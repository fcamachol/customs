import { withTransaction } from '../db/tx';
import { query } from '../db/pool';
import { recordAudit } from './audit';
import { saveFile } from '../storage/files';
import { loadScanPolicy, scanPedimentoPdf, type ScanResult } from './pdfScan';
import {
  buildEmailArchive,
  downloadAttachment,
  loadAgoraConfig,
  type AgoraConfig,
} from './agoraClient';
import { mirrorEstadoDeOperacion, mirrorEventoToAgora } from './agoraMirror';
import { parsePrealerta } from '../../../shared/operaciones/prealerta';
import { refreshVueloForOperacion } from './vuelosService';
import { ingestManifiestoFromPrealerta } from './manifiestoIngest';
import { resolveClientForPrealerta } from './clientResolution';
import { runRiskForManifest } from './riskService';
import {
  CODIGOS_MANIFIESTO,
  CODIGOS_OPERACION,
  COTEJO_RULESET_VERSION,
  PESO_TOLERANCIA_PCT_DEFAULT,
  cotejarManifiesto,
  cotejarOperacion,
  mergeDiscrepancias,
  type Discrepancia,
} from '../../../shared/operaciones/cotejo';

/**
 * Weight tolerance as a fraction. Configurable because PRD-02 §16 records 0.5 % as an assumption taken
 * to avoid blocking, not a figure anyone validated — and the sample weight in the meeting was itself
 * ambiguous (52.64 vs 570 kg, still open as Q2).
 */
function pesoToleranciaPct(): number {
  const raw = Number(process.env.PESO_TOLERANCIA_PCT);
  return Number.isFinite(raw) && raw > 0 ? raw : PESO_TOLERANCIA_PCT_DEFAULT;
}

/** The post-commit steps that are allowed to fail. Named so an incident is greppable and filterable. */
type PasoIngesta = 'manifiesto' | 'riesgo' | 'vuelo' | 'cotejo_operacion' | 'espejo_agora';

/**
 * Turn a swallowed best-effort failure into a VISIBLE fact.
 *
 * Every block below the commit is deliberately best-effort — a malformed spreadsheet or a flight-feed
 * outage must not cost us a caso whose evidence is already archived (PRD-02 principle P1). But until
 * now "best-effort" meant `console.warn`, i.e. invisible: the operational complaint was exactly that
 * there is "no clear error log", and it was correct — a caso could sit missing its manifest, its risk
 * score or its guías with nothing anywhere saying why. The caso still stands; the failure now stands
 * next to it, in the append-only ledger and in the audit hash chain, where the same people who see the
 * caso see the gap.
 *
 * Wrapped in its own try/catch, and that is load-bearing: if recording the incident could throw, a DB
 * hiccup during a failure would turn a degraded ingest into a failed one. A failure to record a failure
 * gets a console.error and nothing more — no regress, no rethrow.
 */
async function registrarIncidencia(
  operacion: { id: string; mawb: string },
  paso: PasoIngesta,
  err: unknown,
  agoraConversationId: string | null,
): Promise<void> {
  const mensaje = err instanceof Error ? err.message : String(err);
  console.warn(`[prealertaIngest] paso '${paso}' falló:`, err);
  try {
    await query(
      `INSERT INTO operacion_eventos
         (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
       VALUES ($1,$2,'INGESTA_INCIDENCIA','sistema',now(),$3)`,
      [operacion.id, operacion.mawb, JSON.stringify({ paso, error: mensaje })],
    );
    await recordAudit({
      userId: null,
      action: 'INGESTA_INCIDENCIA',
      entity: 'operacion',
      entityId: operacion.id,
      after: { mawb: operacion.mawb, paso, error: mensaje },
      ip: null,
    });
    await mirrorEventoToAgora({
      operacionId: operacion.id,
      agoraConversationId,
      tipo: 'INGESTA_INCIDENCIA',
      payloadResumen: { paso, error: mensaje },
    });
  } catch (err2) {
    console.error('[prealertaIngest] no se pudo registrar la incidencia de ingesta:', err2);
  }
}

/**
 * Prealerta ingest — the entry point of the whole operations pipeline (PRD-02 R1–R6, Adenda A).
 *
 * ORDER IS THE DESIGN HERE, not an implementation detail. Rule R-A of the addendum says evidence is
 * archived before it is acted on, so the sequence is: verify → de-duplicate → download → scan →
 * hash and store → only then parse, key the caso and write the ledger. If archival fails we return a
 * retryable failure and process nothing, because a prealerta whose evidence we could not keep is
 * worse than one we have not seen: it would advance the operation while leaving nothing for an
 * auditor to check. AGORA cannot be the fallback copy — it incinerates inbound mail after 30 days.
 *
 * The scan step exists because AGORA applies NO malware scanning and NO content-type allowlist to
 * email attachments (its validation covers only the web-widget channel). These attachments arrive
 * from Chinese e-commerce robots, so they are the least trusted bytes in the system.
 */

/** Shape of the bits of the AGORA `message_created` webhook we rely on. */
export interface AgoraWebhookPayload {
  event?: string;
  id?: number;
  message_type?: string;
  private?: boolean;
  content?: string | null;
  content_attributes?: {
    email?: {
      subject?: string;
      message_id?: string;
      from?: string[] | string;
      text_content?: { full?: string } | string;
      html_content?: { full?: string } | string;
      [k: string]: unknown;
    };
    [k: string]: unknown;
  };
  conversation?: { id?: number; inbox_id?: number; [k: string]: unknown };
  inbox?: { id?: number; name?: string };
  sender?: { id?: number; email?: string; name?: string };
  attachments?: Array<{
    id?: number;
    file_type?: string;
    data_url?: string;
    extension?: string;
    [k: string]: unknown;
  }>;
  [k: string]: unknown;
}

export type IngestOutcome =
  | { status: 'duplicate'; prealertaId: string }
  | { status: 'ignored'; reason: string }
  | { status: 'rejected'; reason: string; operacionId?: string; prealertaId?: string }
  | {
      status: 'processed';
      operacionId: string;
      prealertaId: string;
      version: number;
      operacionCreated: boolean;
      warnings: number;
    };

type AdjuntoTipo = 'awb' | 'manifiesto' | 'otro';

interface PreparedAdjunto {
  tipo: AdjuntoTipo;
  fileId: string;
  originalName: string;
  contentHash: string;
  scanVerdict: string;
  scanResult: ScanResult | null;
  /**
   * Retained for the manifiesto only, so it can be parsed after the caso commits without re-reading
   * from disk. Held for one attachment rather than all of them to bound memory.
   */
  bytes?: Buffer;
}

function textOf(v: { full?: string } | string | undefined): string {
  if (!v) return '';
  return typeof v === 'string' ? v : (v.full ?? '');
}

function senderEmail(payload: AgoraWebhookPayload): string | null {
  const from = payload.content_attributes?.email?.from;
  if (Array.isArray(from) && from.length) return from[0];
  if (typeof from === 'string' && from) return from;
  return payload.sender?.email ?? null;
}

/**
 * The name an AGORA attachment is archived under. Exported because the blob-recovery script
 * (`scripts/recoverEvidence.ts`) has to re-derive it to match a stored `files.original_name` back to
 * the attachment it came from — and if the two ever disagreed, recovery would silently find nothing.
 */
export function fileNameFor(att: { data_url?: string; extension?: string; id?: number }): string {
  const fromUrl = att.data_url ? decodeURIComponent(att.data_url.split('?')[0].split('/').pop() ?? '') : '';
  if (fromUrl) return fromUrl;
  const ext = att.extension ? `.${att.extension.replace(/^\./, '')}` : '';
  return `adjunto-${att.id ?? 'sin-id'}${ext}`;
}

/**
 * Classify an attachment by extension. The prealerta carries exactly two meaningful artifacts — the
 * AWB (a PDF) and the manifiesto (a spreadsheet, the same file the risk engine already consumes) —
 * so extension is sufficient and, unlike a client-supplied label, cannot be gamed into the wrong
 * pipeline. Anything else is kept as `otro` rather than discarded: we archive what arrived.
 */
export function classifyAdjunto(name: string): AdjuntoTipo {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  if (ext === 'pdf') return 'awb';
  if (['xlsx', 'xls', 'xlsm', 'xlsb', 'csv'].includes(ext)) return 'manifiesto';
  return 'otro';
}

export async function ingestPrealerta(
  payload: AgoraWebhookPayload,
  opts: { eventId?: string | null; expectedInboxId?: string | null } = {},
): Promise<IngestOutcome> {
  const cfg = loadAgoraConfig();
  if (!cfg) return { status: 'ignored', reason: 'agora_no_configurado' };

  // Only inbound, non-private mail on the prealertas inbox becomes a caso. Outgoing messages are
  // our own replies coming back through the same webhook, and private notes are internal chatter;
  // treating either as a prealerta would create phantom operations.
  if (payload.event && payload.event !== 'message_created') {
    return { status: 'ignored', reason: `evento_no_manejado:${payload.event}` };
  }
  if (payload.message_type && payload.message_type !== 'incoming') {
    return { status: 'ignored', reason: `message_type:${payload.message_type}` };
  }
  if (payload.private) return { status: 'ignored', reason: 'nota_privada' };

  const inboxId = payload.conversation?.inbox_id ?? payload.inbox?.id;
  if (opts.expectedInboxId && String(inboxId ?? '') !== String(opts.expectedInboxId)) {
    return { status: 'ignored', reason: `inbox_no_vigilado:${inboxId ?? 'desconocido'}` };
  }

  const email = payload.content_attributes?.email ?? {};
  const messageId = email.message_id ?? null;
  const conversationId = payload.conversation?.id ?? null;
  const agoraMessageId = payload.id ?? null;
  const eventId = opts.eventId ?? null;

  // De-duplicate before doing any work. Two independent keys because the same mail can reach us
  // twice by two routes: webhook redelivery (same event id) and the reconciliation sweep picking up
  // a message a webhook already delivered (same Message-ID, different/absent event id).
  const dup = await query<{ id: string }>(
    `SELECT id FROM prealertas
      WHERE ($1::text IS NOT NULL AND agora_event_id = $1)
         OR ($2::text IS NOT NULL AND message_id = $2)
      LIMIT 1`,
    [eventId, messageId],
  );
  if (dup.rows.length) return { status: 'duplicate', prealertaId: dup.rows[0].id };

  const subject = email.subject ?? null;
  const bodyText = textOf(email.text_content) || payload.content || '';
  const parsed = parsePrealerta({ subject, textBody: bodyText });

  // Without a guía máster there is no key for the caso, so there is nothing to create or version.
  // We deliberately do NOT invent a placeholder: a synthetic MAWB would pollute the unique index and
  // could later collide with a real one. The mail stays in AGORA for a human, and the fact is
  // recorded in the audit chain so the gap is visible rather than silent.
  if (!parsed.fields.mawb) {
    await recordAudit({
      action: 'PREALERTA_SIN_MAWB',
      userId: null,
      entity: 'prealerta',
      entityId: messageId ?? String(agoraMessageId ?? ''),
      after: { conversationId, subject, warnings: parsed.warnings },
      ip: null,
    });
    return { status: 'ignored', reason: 'sin_guia_master' };
  }

  // Resolve the client before anything is written, so client_id lands on the operación's INSERT rather
  // than needing a follow-up UPDATE — and so the per-client parser vocabulary can be applied.
  const cliente = await resolveClientForPrealerta({ senderEmail: senderEmail(payload), subject });

  // ---- Evidence first (rule R-A). Anything that throws here propagates so the caller can 5xx and
  // let AGORA/Sidekiq retry; nothing has been committed yet at this point.
  const policy = await loadScanPolicy();
  const adjuntos: PreparedAdjunto[] = [];
  let blocked: { name: string; result: ScanResult } | null = null;

  for (const att of payload.attachments ?? []) {
    if (!att.data_url) continue;
    const originalName = fileNameFor(att);
    const tipo = classifyAdjunto(originalName);
    const bytes = await downloadAttachment(cfg, att.data_url);

    // The existing scanner understands PDF structure (active content, QR trojans). Spreadsheets get
    // archived and marked `unscannable` rather than run through a PDF-shaped analysis that would
    // return a meaningless "clean" — an honest gap beats a false assurance. Macro-enabled workbook
    // inspection is a known follow-up.
    let scanVerdict = 'unscannable';
    let scanResult: ScanResult | null = null;
    if (tipo === 'awb') {
      scanResult = await scanPedimentoPdf(bytes, policy);
      scanVerdict = scanResult.verdict;
      if (scanResult.verdict === 'blocked') blocked = { name: originalName, result: scanResult };
    }

    // The manifiesto reuses the existing `manifest` kind so it lands in the same place the UI upload
    // path already puts it and the risk engine can consume it unchanged. Unrecognized files are
    // `evidencia`, not `prealerta_email` — that kind is reserved for the archived message itself.
    const meta = await saveFile({
      kind: tipo === 'manifiesto' ? 'manifest' : tipo === 'awb' ? 'awb' : 'evidencia',
      originalName,
      bytes,
      uploadedBy: null,
    });
    adjuntos.push({
      tipo,
      fileId: meta.id,
      originalName,
      contentHash: meta.contentHash,
      scanVerdict,
      scanResult,
      bytes: tipo === 'manifiesto' ? bytes : undefined,
    });
    // Deliberately no early break on `blocked`: rule R-A says we keep what arrived. We refuse to
    // PROCESS the prealerta, but every attachment still gets archived and hashed, so an auditor can
    // see exactly what was sent and why it was rejected.
  }

  const archive = await saveFile({
    kind: 'prealerta_email',
    originalName: `${messageId ?? `agora-${agoraMessageId ?? 'sin-id'}`}.json`,
    bytes: buildEmailArchive(payload),
    uploadedBy: null,
  });

  // ---- Commit the caso.
  const mawb = parsed.fields.mawb;
  const result = await withTransaction(async (q) => {
    // xmax = 0 distinguishes an inserted row from an updated one, which is what tells us whether
    // this is a new caso or a resend (R6/D2). On a resend we refresh exactly the fields the client
    // re-sends — flight, route, ETA, counts — using COALESCE so a field the parser could not read
    // this time never erases what a previous version had established.
    const op = await q(
      `INSERT INTO operaciones (
         mawb, mawb_raw, origen_iata, destino_iata, numero_vuelo, etd_origen, eta_pais,
         cartones_prealerta, piezas_prealerta, peso_kg_prealerta, agora_conversation_id, client_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (mawb) DO UPDATE SET
         mawb_raw           = COALESCE(EXCLUDED.mawb_raw, operaciones.mawb_raw),
         origen_iata        = COALESCE(EXCLUDED.origen_iata, operaciones.origen_iata),
         destino_iata       = COALESCE(EXCLUDED.destino_iata, operaciones.destino_iata),
         numero_vuelo       = COALESCE(EXCLUDED.numero_vuelo, operaciones.numero_vuelo),
         etd_origen         = COALESCE(EXCLUDED.etd_origen, operaciones.etd_origen),
         eta_pais           = COALESCE(EXCLUDED.eta_pais, operaciones.eta_pais),
         cartones_prealerta = COALESCE(EXCLUDED.cartones_prealerta, operaciones.cartones_prealerta),
         piezas_prealerta   = COALESCE(EXCLUDED.piezas_prealerta, operaciones.piezas_prealerta),
         peso_kg_prealerta  = COALESCE(EXCLUDED.peso_kg_prealerta, operaciones.peso_kg_prealerta),
         agora_conversation_id = COALESCE(EXCLUDED.agora_conversation_id, operaciones.agora_conversation_id),
         client_id             = COALESCE(operaciones.client_id, EXCLUDED.client_id)
       RETURNING id, mawb, client_id, agora_conversation_id, (xmax = 0) AS created`,
      [
        mawb,
        parsed.fields.mawbRaw ?? null,
        parsed.fields.origenIata ?? null,
        parsed.fields.destinoIata ?? null,
        parsed.fields.numeroVuelo ?? null,
        parsed.fields.etdOrigen ?? null,
        parsed.fields.etaPais ?? null,
        parsed.fields.cartones ?? null,
        parsed.fields.piezas ?? null,
        parsed.fields.pesoKg ?? null,
        conversationId != null ? String(conversationId) : null,
        cliente.clientId,
      ],
    );
    const operacion = op.rows[0] as {
      id: string;
      mawb: string;
      client_id: string | null;
      /** Read back rather than taken from the webhook: on a resend that omits it, the stored one wins. */
      agora_conversation_id: string | null;
      created: boolean;
    };

    const ver = await q(
      `SELECT COALESCE(MAX(version), 0) + 1 AS next FROM prealertas WHERE operacion_id = $1`,
      [operacion.id],
    );
    const version = Number((ver.rows[0] as { next: string | number }).next);

    const estado = blocked ? 'rechazada' : 'parseada';
    const pre = await q(
      `INSERT INTO prealertas (
         operacion_id, version, agora_event_id, agora_message_id, agora_conversation_id,
         message_id, remitente, asunto, headers, cuerpo_texto, parsed, parser_version,
         raw_file_id, estado, motivo_rechazo
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       RETURNING id`,
      [
        operacion.id,
        version,
        eventId,
        agoraMessageId != null ? String(agoraMessageId) : null,
        conversationId != null ? String(conversationId) : null,
        messageId,
        senderEmail(payload),
        subject,
        JSON.stringify(email),
        bodyText,
        JSON.stringify({ fields: parsed.fields, provenance: parsed.provenance, warnings: parsed.warnings }),
        parsed.parserVersion,
        archive.id,
        estado,
        blocked ? `adjunto_bloqueado:${blocked.name}` : null,
      ],
    );
    const prealertaId = (pre.rows[0] as { id: string }).id;

    for (const a of adjuntos) {
      await q(
        `INSERT INTO prealerta_adjuntos
           (prealerta_id, file_id, tipo, original_name, content_hash, scan_verdict, scan_result)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          prealertaId,
          a.fileId,
          a.tipo,
          a.originalName,
          a.contentHash,
          a.scanVerdict,
          a.scanResult ? JSON.stringify(a.scanResult) : null,
        ],
      );
    }

    const tipoEvento = blocked
      ? 'PREALERTA_ADJUNTO_BLOQUEADO'
      : operacion.created
        ? 'PREALERTA_RECIBIDA'
        : 'PREALERTA_VERSIONADA';
    await q(
      `INSERT INTO operacion_eventos
         (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
       VALUES ($1,$2,$3,'cliente',now(),$4)`,
      [
        operacion.id,
        operacion.mawb,
        tipoEvento,
        JSON.stringify({
          prealertaId,
          version,
          agoraConversationId: conversationId,
          agoraMessageId,
          messageId,
          parserVersion: parsed.parserVersion,
          fields: parsed.fields,
          // Recorded alongside the values so an auditor can see which fields the client DECLARED and
          // which the parser deduced — the two must never look alike.
          provenance: parsed.provenance,
          warnings: parsed.warnings,
          adjuntos: adjuntos.map((a) => ({
            tipo: a.tipo,
            originalName: a.originalName,
            contentHash: a.contentHash,
            scanVerdict: a.scanVerdict,
          })),
          rawFileId: archive.id,
        }),
      ],
    );

    return { operacion, prealertaId, version, tipoEvento };
  });

  // recordAudit runs its own transaction with an advisory lock for the hash chain, so it must sit
  // outside withTransaction — same convention as every other writer in this codebase. This is the
  // step that puts logistics history into the SAME chain as documentary history, so one
  // GET /api/audit/verify covers both.
  await recordAudit({
    userId: null,
    action: result.tipoEvento,
    entity: 'operacion',
    entityId: result.operacion.id,
    after: {
      mawb: result.operacion.mawb,
      prealertaId: result.prealertaId,
      version: result.version,
      warnings: parsed.warnings,
      adjuntos: adjuntos.map((a) => ({ tipo: a.tipo, scanVerdict: a.scanVerdict })),
    },
    ip: null,
  });

  // Ingest the manifiesto attachment into the existing manifest pipeline. This is the join between the
  // two systems: it is what lets the risk engine score on arrival, and it produces the totals the
  // manifest cotejo rules (PA-01..PA-03) compare the email's declaration against.
  //
  // Best-effort and AFTER the caso is committed, deliberately: a malformed spreadsheet must not cost
  // us the operación. A failure leaves the caso standing with its evidence archived, and shows up as a
  // discrepancy rather than as a lost shipment.
  const manifiesto = adjuntos.find((a) => a.tipo === 'manifiesto' && a.bytes);
  const agoraConvId = result.operacion.agora_conversation_id;
  if (!blocked && manifiesto?.bytes) {
    try {
      const res = await ingestManifiestoFromPrealerta({
        operacionId: result.operacion.id,
        mawb: result.operacion.mawb,
        mawbRaw: parsed.fields.mawbRaw ?? null,
        clientId: result.operacion.client_id,
        bytes: manifiesto.bytes,
        fileId: manifiesto.fileId,
        contentHash: manifiesto.contentHash,
      });

      const declarado = {
        cartones: parsed.fields.cartones ?? null,
        piezas: parsed.fields.piezas ?? null,
        pesoKg: parsed.fields.pesoKg ?? null,
      };
      // The parse's provenance rides along so an INFERRED total cannot produce an `error` finding worded
      // as a client declaration — the 2026-08b incident, see cotejarManifiesto's doc comment.
      const findings =
        res.status === 'ingestado' || res.status === 'adjuntado'
          ? cotejarManifiesto(declarado, { ...res.totales, lineas: res.totales.lineas }, {
              pesoToleranciaPct: pesoToleranciaPct(),
              provenance: parsed.provenance,
            })
          : cotejarManifiesto(declarado, null);

      // Read the stored set first: on a resend the caso may already carry flight findings from a
      // previous cycle, and the merge must preserve them rather than replace the whole array.
      const cur = await query<{ discrepancias: Discrepancia[] | null }>(
        'SELECT discrepancias FROM operaciones WHERE id = $1',
        [result.operacion.id],
      );
      await query(
        `UPDATE operaciones
            SET discrepancias  = $2::jsonb,
                cotejo_version = $3,
                estado_documental = CASE WHEN estado_documental = 'sin_cotejar'
                                         THEN 'cotejado' ELSE estado_documental END
          WHERE id = $1`,
        [
          result.operacion.id,
          JSON.stringify(
            mergeDiscrepancias(cur.rows[0]?.discrepancias ?? null, findings, CODIGOS_MANIFIESTO),
          ),
          COTEJO_RULESET_VERSION,
        ],
      );

      await query(
        `INSERT INTO operacion_eventos
           (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
         VALUES ($1,$2,'COTEJO_EJECUTADO','sistema',now(),$3)`,
        [
          result.operacion.id,
          result.operacion.mawb,
          JSON.stringify({
            manifiesto: res,
            declarado,
            discrepancias: findings,
            cotejoVersion: COTEJO_RULESET_VERSION,
          }),
        ],
      );

      await recordAudit({
        userId: null,
        action: 'COTEJO_EJECUTADO',
        entity: 'operacion',
        entityId: result.operacion.id,
        after: {
          mawb: result.operacion.mawb,
          manifestId: 'manifestId' in res ? res.manifestId : null,
          estado: res.status,
          discrepancias: findings.map((d) => ({ codigo: d.codigo, severidad: d.severidad })),
        },
        ip: null,
      });

      // Mirrored only when the cotejo actually found a red flag: `esEventoEspejable` drops a clean run
      // (and one whose only findings are informativas, including a demoted inferred value).
      await mirrorEventoToAgora({
        operacionId: result.operacion.id,
        agoraConversationId: agoraConvId,
        tipo: 'COTEJO_EJECUTADO',
        payloadResumen: { discrepancias: findings },
      });
      // Score risk immediately, on the same shipments we just promoted. This is the last link that
      // makes the pipeline self-driving: a prealerta now arrives, is archived, cotejada, and risk-scored
      // without anyone clicking anything. userId is null so the audit trail distinguishes an automatic
      // score from a human-triggered one.
      if ('manifestId' in res) {
        try {
          const risk = await runRiskForManifest({ manifestId: res.manifestId, userId: null });
          if (risk) {
            // Eje 2 of the state machine: hallazgos are anything the engine flagged rojo. Only advance
            // from an earlier state — never walk backwards over a resolution someone already recorded.
            const conHallazgos = risk.summary.validarEnPrevio > 0;
            await query(
              `UPDATE operaciones
                  SET estado_documental = $2
                WHERE id = $1 AND estado_documental IN ('sin_cotejar','cotejado')`,
              [result.operacion.id, conHallazgos ? 'riesgo_con_hallazgos' : 'riesgo_ok'],
            );
            await query(
              `INSERT INTO operacion_eventos
                 (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
               VALUES ($1,$2,'RIESGO_EVALUADO','sistema',now(),$3)`,
              [
                result.operacion.id,
                result.operacion.mawb,
                JSON.stringify({
                  manifestId: res.manifestId,
                  summary: risk.summary,
                  rulesetVersion: risk.rulesetVersion,
                  riskFileId: risk.riskFileId,
                  period: risk.period,
                }),
              ],
            );
            await recordAudit({
              userId: null,
              action: 'RIESGO_EVALUADO',
              entity: 'manifest',
              entityId: res.manifestId,
              after: {
                operacionId: result.operacion.id,
                mawb: result.operacion.mawb,
                summary: risk.summary,
                rulesetVersion: risk.rulesetVersion,
              },
              ip: null,
            });
            // Only when the engine demands documents before the previo — `riesgo_ok` needs no human.
            await mirrorEventoToAgora({
              operacionId: result.operacion.id,
              agoraConversationId: agoraConvId,
              tipo: 'RIESGO_EVALUADO',
              payloadResumen: { summary: risk.summary },
            });
          }
        } catch (err) {
          await registrarIncidencia(result.operacion, 'riesgo', err, agoraConvId);
        }
      }
    } catch (err) {
      await registrarIncidencia(result.operacion, 'manifiesto', err, agoraConvId);
    }
  }

  // ---- Operation-level cotejo: PA-07 duplicate cargo, PA-08 unknown sender.
  //
  // ORDER: this runs AFTER the manifiesto ingest, and that is load-bearing rather than incidental.
  // PA-07 compares this caso's house guías against every other open operación's, and the guías only
  // exist in `operacion_guias` once the manifiesto has been ingested and promoted. Run before that
  // step and the comparison set is empty, so PA-07 could never fire on a first ingest — the exact case
  // it exists for. PA-08 does not care where it runs, so the later position costs nothing.
  //
  // Best-effort like every other post-commit step: a duplicate-cargo check that throws must not
  // unwind a caso whose evidence is already archived.
  try {
    const dupes = await query<{ guia_norm: string }>(
      `SELECT DISTINCT g.guia_norm
         FROM operacion_guias g
         JOIN operaciones o2 ON o2.id = g.operacion_id
        WHERE g.operacion_id <> $1
          AND o2.etapa NOT IN ('entregado','cerrada','cancelada')
          AND g.guia_norm IN (SELECT guia_norm FROM operacion_guias WHERE operacion_id = $1)
        ORDER BY g.guia_norm`,
      [result.operacion.id],
    );
    const findings = cotejarOperacion({
      clientId: result.operacion.client_id,
      clientMatchedBy: cliente.matchedBy,
      remitente: senderEmail(payload),
      guiasDuplicadas: dupes.rows.map((r) => r.guia_norm),
    });
    const cur = await query<{ discrepancias: Discrepancia[] | null }>(
      'SELECT discrepancias FROM operaciones WHERE id = $1',
      [result.operacion.id],
    );
    await query(
      `UPDATE operaciones SET discrepancias = $2::jsonb, cotejo_version = $3 WHERE id = $1`,
      [
        result.operacion.id,
        JSON.stringify(
          mergeDiscrepancias(cur.rows[0]?.discrepancias ?? null, findings, CODIGOS_OPERACION),
        ),
        COTEJO_RULESET_VERSION,
      ],
    );

    // A red flag that lives only in a mutable jsonb column is not auditable. When PA-07/PA-08 actually
    // fire, the finding goes in the append-only ledger and the hash chain too — otherwise a duplicate
    // guía could be silently overwritten by the next poll with nothing left to show an auditor. Only
    // when there is something to say, so a clean caso does not gain a noise event.
    if (findings.length) {
      await query(
        `INSERT INTO operacion_eventos
           (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
         VALUES ($1,$2,'COTEJO_EJECUTADO','sistema',now(),$3)`,
        [
          result.operacion.id,
          result.operacion.mawb,
          JSON.stringify({
            alcance: 'operacion',
            clienteResuelto: {
              clientId: result.operacion.client_id,
              matchedBy: cliente.matchedBy,
              evidencia: cliente.evidence,
            },
            remitente: senderEmail(payload),
            discrepancias: findings,
            cotejoVersion: COTEJO_RULESET_VERSION,
          }),
        ],
      );
      await recordAudit({
        userId: null,
        action: 'COTEJO_EJECUTADO',
        entity: 'operacion',
        entityId: result.operacion.id,
        after: {
          mawb: result.operacion.mawb,
          alcance: 'operacion',
          clientId: result.operacion.client_id,
          clientMatchedBy: cliente.matchedBy,
          discrepancias: findings.map((d) => ({ codigo: d.codigo, severidad: d.severidad })),
        },
        ip: null,
      });
      // PA-07 (duplicate cargo) is an error and reaches the inbox; PA-08 alone (unknown sender) does
      // not — it is an advertencia, and a new mailbox is not something to interrupt anyone about.
      await mirrorEventoToAgora({
        operacionId: result.operacion.id,
        agoraConversationId: agoraConvId,
        tipo: 'COTEJO_EJECUTADO',
        payloadResumen: { alcance: 'operacion', discrepancias: findings },
      });
    }
  } catch (err) {
    await registrarIncidencia(result.operacion, 'cotejo_operacion', err, agoraConvId);
  }

  // Resolve the flight immediately rather than waiting for the next tick. The declared ETA drives the
  // risk-requirement deadline and the tramitador's arrival window, so the sooner an independent
  // source either corroborates or contradicts it, the sooner PA-04/PA-05 can fire. Best-effort: a
  // flight-feed outage must not unwind a caso that is already committed and archived — the tick will
  // pick it up.
  try {
    await refreshVueloForOperacion(result.operacion.id);
  } catch (err) {
    await registrarIncidencia(result.operacion, 'vuelo', err, agoraConvId);
  }

  // ---- Mirror the caso's state onto the AGORA conversation (task #24).
  //
  // LAST on purpose: `mirrorEstadoDeOperacion` reads the live row, so running it here means the sidebar
  // shows the etapa the flight lookup just advanced and the bandera count the two cotejos just wrote,
  // rather than the `etapa: 'prealerta'` this used to hard-code. Mirror, not move: customs remains the
  // system of record and AGORA is the human workspace.
  if (agoraConvId) {
    const espejado = await mirrorEstadoDeOperacion(result.operacion.id);
    // agoraMirror swallows its own errors, so a false here means AGORA was configured and a thread
    // existed and the stamp still did not land — the one case worth a timeline row, because a sidebar
    // that silently stops updating is how a coordinator ends up trusting a stale etapa.
    if (!espejado) {
      await registrarIncidencia(
        result.operacion,
        'espejo_agora',
        'no se pudo escribir el estado en la conversación de AGORA',
        agoraConvId,
      );
    }
  }

  if (blocked) {
    return {
      status: 'rejected',
      reason: `adjunto_bloqueado:${blocked.name}`,
      operacionId: result.operacion.id,
      prealertaId: result.prealertaId,
    };
  }
  return {
    status: 'processed',
    operacionId: result.operacion.id,
    prealertaId: result.prealertaId,
    version: result.version,
    operacionCreated: result.operacion.created,
    warnings: parsed.warnings.length,
  };
}

export type { AgoraConfig };
