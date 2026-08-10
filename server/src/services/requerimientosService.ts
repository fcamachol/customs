import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { recordAudit } from './audit';
import { mirrorEventoToAgora } from './agoraMirror';
import { sendMail, type MailOutcome } from './mailer';
import { avisarInternoPorEvento, escalarPorWhatsapp } from './whatsappFanout';
import type { WhatsappOutcome } from './whatsapp';

/**
 * RIESGO REQUERIMIENTOS — the risk→client bridge with a hard deadline (PRD-02 `R18`/`D13`, §8.7),
 * and the `CT-4` expiry that freezes cargo nobody answered for.
 *
 * This module owns the two things that must happen without a human: TELLING the client (through
 * `services/mailer.ts`, #22) and EXPIRING the deadline (a phase of `POST /api/ops/tick`). Emission,
 * resolution and cancellation are human acts and live in `routes/riesgoRequerimientos.ts`.
 *
 * THE RULE THAT SHAPES EVERYTHING HERE: the clock does not run against somebody who was never told.
 * `expirarVencidos` only ever touches rows with `notificado_at IS NOT NULL`. When SMTP is not
 * provisioned the mailer returns `omitido`, `notificado_at` stays NULL, the requerimiento stays
 * `abierto` and visibly un-notified, and `reintentarNotificaciones` tries again on the next tick.
 * The failure mode this prevents is the one with legal consequence (plan §9): stopping the cargo of
 * a client who was never warned.
 *
 * WHAT EXPIRY DOES, AND WHAT IT DELIBERATELY DOES NOT. It opens a hold of tipo `riesgo` — the CT-4
 * freeze — and walks `estado_documental` to `riesgo_vencido`. It does NOT move `estado_planeacion`,
 * exclude the caso from a plan, or look for a replacement guía: that is the contingency engine's job
 * (§8.8, `shared/operaciones/replan.ts`), exactly as `routes/holds.ts` states for every other hold.
 *
 * #31 — WhatsApp is the second channel (Adenda A §6.3): whenever email does not confirm delivery,
 * `escalarPorWhatsapp` (`services/whatsappFanout.ts`) tries the client's phone, and the CT-4 freeze
 * also pings the internal `dirección` roster regardless of the email outcome. See that module's
 * header for the exact scope this covers and what it deliberately does not (R19's plan-change leg,
 * which needs #29).
 */

// -------------------------------------------------------------------------------------------------
// Deadline arithmetic
// -------------------------------------------------------------------------------------------------

/**
 * The offload window added to the flight's ETA (`D13`: "vuelo + descarga").
 *
 * 3 hours is PRD-02 §16's stated default assumption, recorded there precisely so it could be argued
 * with later — hence the env override rather than a constant nobody can reach.
 */
export function ventanaHorasPorDefecto(): number {
  const raw = Number(process.env.REQUERIMIENTO_VENTANA_HORAS);
  return Number.isFinite(raw) && raw > 0 ? raw : 3;
}

/** `eta_pais + ventana`. Both inputs are stored on the row so the result stays re-derivable. */
export function calcularVenceAt(etaBase: Date, ventanaHoras: number): Date {
  return new Date(etaBase.getTime() + ventanaHoras * 3_600_000);
}

// -------------------------------------------------------------------------------------------------
// Notification
// -------------------------------------------------------------------------------------------------

interface FilaNotificable {
  id: string;
  operacion_id: string;
  mawb: string;
  guia_norm: string | null;
  vence_at: Date;
  reason_codes: unknown;
  detalle: string | null;
  ruleset_version: string | null;
  destinatario_email: string | null;
  cliente_email: string | null;
  cliente_telefono: string | null;
  remitente: string | null;
  agora_conversation_id: string | null;
  notificacion_intentos: number;
}

const SQL_FILA = `
  SELECT r.id,
         r.operacion_id,
         o.mawb,
         g.guia_norm,
         r.vence_at,
         r.reason_codes,
         r.detalle,
         r.ruleset_version,
         r.destinatario_email,
         c.email AS cliente_email,
         c.phone AS cliente_telefono,
         (SELECT p.remitente FROM prealertas p
           WHERE p.operacion_id = o.id AND p.remitente IS NOT NULL
           ORDER BY p.version DESC LIMIT 1) AS remitente,
         o.agora_conversation_id,
         r.notificacion_intentos
    FROM riesgo_requerimientos r
    JOIN operaciones o ON o.id = r.operacion_id
    LEFT JOIN operacion_guias g ON g.id = r.operacion_guia_id
    LEFT JOIN clients c ON c.id = o.client_id
`;

/**
 * Who gets told, in order of how much we trust the address.
 *
 * An address recorded on the requerimiento itself wins (somebody chose it deliberately), then the
 * client catalog, and last the address the prealerta actually arrived from — which is the robot's
 * mailbox and therefore reaches the party that sent us the cargo even when the catalog is stale.
 */
export function resolverDestinatario(fila: {
  destinatario_email: string | null;
  cliente_email: string | null;
  remitente: string | null;
}): string | null {
  const candidatos = [fila.destinatario_email, fila.cliente_email, fila.remitente];
  for (const c of candidatos) {
    const v = (c ?? '').trim();
    if (v) return v;
  }
  return null;
}

/**
 * The WhatsApp escalation target (#31, §6.3's "segundo canal"). Only one candidate today —
 * `clients.phone` — because the other addresses this module resolves for email (the requerimiento's
 * own override, the prealerta sender) are, by construction, email addresses.
 */
export function resolverTelefono(fila: { cliente_telefono: string | null }): string | null {
  const v = (fila.cliente_telefono ?? '').trim();
  return v || null;
}

/** `ReasonCode[]` as the client should read it. Defensive: the column is jsonb and may hold anything. */
function listarHallazgos(reasonCodes: unknown): string[] {
  if (!Array.isArray(reasonCodes)) return [];
  return reasonCodes.map((rc) => {
    const r = (rc ?? {}) as Record<string, unknown>;
    const id = typeof r.signalId === 'string' ? r.signalId : 'signal';
    const detail = typeof r.detail === 'string' && r.detail ? r.detail : 'flagged by the risk ruleset';
    return `- [${id}] ${detail}`;
  });
}

/** UTC, spelled out. The client is offshore; a local-time deadline with no zone is a dispute waiting. */
function fechaUtc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The message itself, in ENGLISH (`N6`) with the deadline stated explicitly.
 *
 * Exported so the wording — the part that has actual consequences for a client — is testable without
 * a database or an SMTP server.
 */
export function construirCorreoRequerimiento(fila: {
  mawb: string;
  guia_norm: string | null;
  vence_at: Date;
  reason_codes: unknown;
  detalle: string | null;
  ruleset_version: string | null;
}): { subject: string; text: string } {
  const hallazgos = listarHallazgos(fila.reason_codes);
  const subject = `ACTION REQUIRED — customs risk review, MAWB ${fila.mawb}${
    fila.guia_norm ? ` / HAWB ${fila.guia_norm}` : ''
  }`;
  const text = [
    `Our risk review of the documents you sent for MAWB ${fila.mawb}${
      fila.guia_norm ? ` (house waybill ${fila.guia_norm})` : ''
    } raised findings that must be cleared before the shipment can be dispatched.`,
    '',
    'Findings:',
    ...(hallazgos.length ? hallazgos : ['- See the attached risk review.']),
    ...(fila.detalle ? ['', fila.detalle] : []),
    '',
    `DEADLINE: ${fechaUtc(fila.vence_at)}.`,
    'If we do not receive the corrected documents or supporting evidence by that time, the shipment',
    'will be placed on hold and excluded from the dispatch plan until the findings are resolved.',
    '',
    'Please reply to this message with the corrected documentation.',
    ...(fila.ruleset_version ? ['', `Risk ruleset: ${fila.ruleset_version}`] : []),
  ].join('\n');
  return { subject, text };
}

/** The expiry notice — sent to the client AND worth a copy in the thread. English, same as above. */
export function construirCorreoVencimiento(fila: {
  mawb: string;
  guia_norm: string | null;
  vence_at: Date;
}): { subject: string; text: string } {
  return {
    subject: `HOLD PLACED — deadline expired, MAWB ${fila.mawb}`,
    text: [
      `The deadline for the customs risk findings on MAWB ${fila.mawb}${
        fila.guia_norm ? ` (house waybill ${fila.guia_norm})` : ''
      } expired on ${fechaUtc(fila.vence_at)} with no response.`,
      '',
      'The shipment has been placed on hold and removed from the dispatch plan. It will be',
      'reinstated once the findings are resolved. Please reply with the corrected documentation.',
    ].join('\n'),
  };
}

/**
 * The WhatsApp escalation text (#31, §6.3's "segundo canal") — condensed, English (`N6`), no
 * subject line: WhatsApp has no separate subject field, and a message this short reads as a message,
 * not an email pasted into a chat window.
 */
export function construirWhatsappRequerimiento(fila: {
  mawb: string;
  guia_norm: string | null;
  vence_at: Date;
}): string {
  return (
    `ACTION REQUIRED — customs risk review, MAWB ${fila.mawb}` +
    `${fila.guia_norm ? ` / HAWB ${fila.guia_norm}` : ''}. ` +
    `Findings must be cleared by ${fechaUtc(fila.vence_at)} or the shipment is held and excluded ` +
    'from dispatch. Please reply to this message (or the earlier email) with corrected documentation.'
  );
}

/** The expiry notice's WhatsApp counterpart — condensed, same facts as `construirCorreoVencimiento`. */
export function construirWhatsappVencimiento(fila: {
  mawb: string;
  guia_norm: string | null;
  vence_at: Date;
}): string {
  return (
    `HOLD PLACED — deadline expired, MAWB ${fila.mawb}${fila.guia_norm ? ` / HAWB ${fila.guia_norm}` : ''}. ` +
    `The risk review deadline (${fechaUtc(fila.vence_at)}) passed with no response; the shipment is ` +
    'on hold and out of the dispatch plan. Reply with corrected documentation to reinstate it.'
  );
}

export interface NotificacionResultado {
  requerimientoId: string;
  outcome: MailOutcome;
  /** null when WhatsApp was never attempted — the primary channel confirmed, or there is no phone
   *  number on file. See `escalarPorWhatsapp` for the exact rule. */
  whatsapp: WhatsappOutcome | null;
}

/**
 * Try to tell the client about one requerimiento, and RECORD what happened either way.
 *
 * Never throws — it is called from a request path (right after emission) and from the tick. The row
 * is updated in all three outcomes, because "we tried and could not" is information the control tower
 * has to show; a silent failure here reads as a client who was warned.
 */
export async function notificarRequerimiento(requerimientoId: string): Promise<NotificacionResultado> {
  const { rows } = await query<FilaNotificable>(`${SQL_FILA} WHERE r.id = $1`, [requerimientoId]);
  const fila = rows[0];
  if (!fila) {
    return {
      requerimientoId,
      outcome: { status: 'omitido', motivo: 'requerimiento inexistente' },
      whatsapp: null,
    };
  }

  const destinatario = resolverDestinatario(fila);
  const { subject, text } = construirCorreoRequerimiento(fila);
  const outcome: MailOutcome = destinatario
    ? await sendMail({ to: destinatario, subject, text })
    : {
        status: 'omitido',
        motivo: 'sin destinatario: el caso no tiene cliente con correo ni remitente de prealerta',
      };

  const enviado = outcome.status === 'enviado';
  const detalle =
    outcome.status === 'enviado'
      ? `enviado (${outcome.aceptados.join(', ')})`
      : outcome.status === 'omitido'
        ? `omitido: ${outcome.motivo}`
        : `error: ${outcome.error}`;

  await query(
    `UPDATE riesgo_requerimientos
        SET notificacion_estado  = $2,
            notificacion_detalle = $3,
            notificacion_intentos = notificacion_intentos + 1,
            destinatario_email   = COALESCE($4, destinatario_email),
            -- Set ONCE, and only on a real send. This is the gate the expiry sweep reads: a NULL
            -- here means the client was never told, and the deadline must not run against them.
            notificado_at        = CASE WHEN $5::boolean THEN COALESCE(notificado_at, now()) ELSE notificado_at END
      WHERE id = $1`,
    [
      requerimientoId,
      outcome.status === 'enviado' ? 'enviada' : outcome.status === 'omitido' ? 'omitida' : 'error',
      detalle,
      destinatario,
      enviado,
    ],
  );

  if (!enviado) {
    console.warn(
      `[requerimientos] el requerimiento ${requerimientoId} (MAWB ${fila.mawb}) NO fue notificado — ${detalle}. ` +
        'El plazo no corre hasta que haya confirmación de envío.',
    );
  }

  // §6.3 — the second channel. Fires only when email did NOT confirm delivery; a confirmed send has
  // nothing to escalate. Never affects `notificado_at`: WhatsApp delivery is not the gate the CT-4
  // deadline reads (email is, per D13), it is a courtesy attempt to reach the client another way.
  const whatsapp = await escalarPorWhatsapp({
    telefono: resolverTelefono(fila),
    canalPrimarioEstado: outcome.status,
    texto: construirWhatsappRequerimiento(fila),
  });

  return { requerimientoId, outcome, whatsapp };
}

// -------------------------------------------------------------------------------------------------
// The tick phases
// -------------------------------------------------------------------------------------------------

/**
 * Recompute `operaciones.hold_activo` for one caso.
 *
 * The same absolute formula `routes/holds.ts` uses, restated rather than imported: it asks the table
 * what is true right now instead of incrementing anything, so it lands on the correct value no matter
 * what other holds exist. Kept identical to holds.ts on purpose — if one changes, both must.
 */
async function materializarHold(
  q: (text: string, params?: unknown[]) => Promise<any>,
  operacionId: string,
): Promise<boolean> {
  const { rows } = await q(
    `UPDATE operaciones o
        SET hold_activo = EXISTS (
              SELECT 1 FROM operacion_holds h
               WHERE h.activo
                 AND (h.operacion_id IS NULL OR h.operacion_id = o.id))
      WHERE o.id = $1
      RETURNING o.hold_activo`,
    [operacionId],
  );
  return Boolean(rows[0]?.hold_activo);
}

export interface VencimientoDetalle {
  requerimientoId: string;
  operacionId: string;
  mawb: string;
  holdId: string | null;
  /** True when a CT-4 hold was already open for this caso and reused rather than duplicated. */
  holdReutilizado: boolean;
  estadoDocumental: string;
  avisoCliente: MailOutcome['status'];
}

/**
 * CT-4 — expire the deadlines that ran out, freeze the cargo, tell the client.
 *
 * One transaction PER requerimiento, not one for the batch: a caso whose hold insert trips over
 * something must not take the rest of the sweep with it, and the audit/mirror/mail side effects have
 * to run after their own commit (recordAudit takes the chain's advisory lock and must never be
 * called inside another transaction — HANDOFF §3.5).
 *
 * `LIMIT` caps a single tick. If a backlog ever builds up, it drains over consecutive ticks instead
 * of turning one scheduled poke into a long-running job.
 */
export async function expirarVencidos(limite = 100): Promise<VencimientoDetalle[]> {
  const { rows: candidatos } = await query<{ id: string }>(
    `SELECT id
       FROM riesgo_requerimientos
      WHERE estado = 'abierto'
        AND notificado_at IS NOT NULL
        AND vence_at <= now()
      ORDER BY vence_at ASC
      LIMIT $1`,
    [limite],
  );

  const salida: VencimientoDetalle[] = [];
  for (const { id } of candidatos) {
    let resultado: {
      requerimientoId: string;
      operacionId: string;
      mawb: string;
      guiaNorm: string | null;
      venceAt: Date;
      holdId: string | null;
      holdReutilizado: boolean;
      holdActivo: boolean;
      estadoDocumental: string;
      agoraConversationId: string | null;
    } | null = null;

    try {
      resultado = await withTransaction(async (q) => {
        // Re-read under a row lock: a coordinator may have resolved it between the scan and now, and
        // expiring a requerimiento the client just answered would freeze cargo for no reason.
        const sel = await q(
          `SELECT r.id, r.operacion_id, r.vence_at, o.mawb, o.agora_conversation_id,
                  g.guia_norm
             FROM riesgo_requerimientos r
             JOIN operaciones o ON o.id = r.operacion_id
             LEFT JOIN operacion_guias g ON g.id = r.operacion_guia_id
            WHERE r.id = $1
              AND r.estado = 'abierto'
              AND r.notificado_at IS NOT NULL
              AND r.vence_at <= now()
            FOR UPDATE OF r`,
          [id],
        );
        if (!sel.rows.length) return null;
        const req = sel.rows[0] as {
          id: string;
          operacion_id: string;
          vence_at: Date;
          mawb: string;
          agora_conversation_id: string | null;
          guia_norm: string | null;
        };

        /**
         * Reuse an already-open `riesgo` hold instead of stacking a second one. Two casos routinely
         * carry two findings; two freezes for one reason means the coordinator closes one, believes
         * the cargo is free, and it is not.
         */
        const existente = await q(
          `SELECT id FROM operacion_holds
            WHERE activo AND operacion_id = $1 AND tipo = 'riesgo'
            ORDER BY abierto_at ASC LIMIT 1`,
          [req.operacion_id],
        );
        let holdId: string | null = existente.rows.length ? String(existente.rows[0].id) : null;
        const holdReutilizado = holdId !== null;
        if (!holdId) {
          const ins = await q(
            `INSERT INTO operacion_holds (operacion_id, tipo, alcance, activo, abierto_por, motivo)
             VALUES ($1,'riesgo','operacion',true,NULL,$2)
             RETURNING id`,
            [
              req.operacion_id,
              `CT-4: venció el plazo del requerimiento de riesgo (${fechaUtc(new Date(req.vence_at))}) sin respuesta del cliente.`,
            ],
          );
          holdId = String(ins.rows[0].id);
        }

        await q(
          `UPDATE riesgo_requerimientos
              SET estado = 'vencido', vencido_at = now(), hold_id = $2
            WHERE id = $1`,
          [req.id, holdId],
        );

        const holdActivo = await materializarHold(q, req.operacion_id);

        // Eje 2 (§8.4). Only from the state that precedes it — never walk backwards over a resolution
        // somebody already recorded, and never leapfrog a caso that is already `pedimento_generado`.
        const doc = await q(
          `UPDATE operaciones
              SET estado_documental = 'riesgo_vencido'
            WHERE id = $1 AND estado_documental = 'riesgo_con_hallazgos'
            RETURNING estado_documental`,
          [req.operacion_id],
        );
        const estadoDocumental = doc.rows.length
          ? String(doc.rows[0].estado_documental)
          : String(
              (await q('SELECT estado_documental FROM operaciones WHERE id = $1', [req.operacion_id]))
                .rows[0].estado_documental,
            );

        await q(
          `INSERT INTO operacion_eventos
             (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
           VALUES ($1,$2,'REQUERIMIENTO_VENCIDO','sistema',now(),$3)`,
          [
            req.operacion_id,
            req.mawb,
            JSON.stringify({
              requerimientoId: req.id,
              venceAt: req.vence_at,
              holdId,
              holdReutilizado,
              guia: req.guia_norm,
              estadoDocumental,
              // The operational consequence, spelled out in the timeline like holds.ts does, because
              // this is the sentence someone reads six weeks later asking why the cargo did not move.
              efecto:
                'CT-4: se abre hold de riesgo; la operación no se programa hasta resolver el requerimiento.',
            }),
          ],
        );

        return {
          requerimientoId: req.id,
          operacionId: req.operacion_id,
          mawb: req.mawb,
          guiaNorm: req.guia_norm,
          venceAt: req.vence_at,
          holdId,
          holdReutilizado,
          holdActivo,
          estadoDocumental,
          agoraConversationId: req.agora_conversation_id,
        };
      });
    } catch (err) {
      // One bad caso must not stop the sweep. Loud, and the row stays `abierto` so the next tick
      // retries it — which is the right default for a step that freezes somebody's cargo.
      console.error(`[requerimientos] falló el vencimiento del requerimiento ${id}:`, err);
      continue;
    }

    if (!resultado) continue;

    await recordAudit({
      userId: null,
      action: 'REQUERIMIENTO_VENCIDO',
      entity: 'riesgo_requerimiento',
      entityId: resultado.requerimientoId,
      after: {
        operacionId: resultado.operacionId,
        mawb: resultado.mawb,
        venceAt: resultado.venceAt,
        holdId: resultado.holdId,
        holdReutilizado: resultado.holdReutilizado,
        holdActivo: resultado.holdActivo,
        estadoDocumental: resultado.estadoDocumental,
      },
      ip: null,
    });

    const aviso = await avisarVencimiento(resultado.requerimientoId, {
      mawb: resultado.mawb,
      guia_norm: resultado.guiaNorm,
      vence_at: new Date(resultado.venceAt),
    });

    const payloadEvento = {
      requerimientoId: resultado.requerimientoId,
      venceAt: resultado.venceAt,
      guia: resultado.guiaNorm,
      efecto:
        'CT-4: se abre hold de riesgo; la operación no se programa hasta resolver el requerimiento.',
    };

    await mirrorEventoToAgora({
      operacionId: resultado.operacionId,
      agoraConversationId: resultado.agoraConversationId,
      tipo: 'REQUERIMIENTO_VENCIDO',
      payloadResumen: payloadEvento,
    });

    // §6.3 — "aviso interno a dirección": a CT-4 freeze is exactly the kind of fact management needs
    // to know about even if nobody is watching the AGORA inbox at that moment.
    await avisarInternoPorEvento({
      operacionId: resultado.operacionId,
      tipo: 'REQUERIMIENTO_VENCIDO',
      payloadResumen: payloadEvento,
    });

    salida.push({
      requerimientoId: resultado.requerimientoId,
      operacionId: resultado.operacionId,
      mawb: resultado.mawb,
      holdId: resultado.holdId,
      holdReutilizado: resultado.holdReutilizado,
      estadoDocumental: resultado.estadoDocumental,
      avisoCliente: aviso,
    });
  }

  return salida;
}

/** Best-effort expiry notice. Recorded on the row's notification detail, never on `notificado_at`. */
async function avisarVencimiento(
  requerimientoId: string,
  fila: { mawb: string; guia_norm: string | null; vence_at: Date },
): Promise<MailOutcome['status']> {
  const { rows } = await query<{
    destinatario_email: string | null;
    cliente_email: string | null;
    cliente_telefono: string | null;
    remitente: string | null;
  }>(`${SQL_FILA} WHERE r.id = $1`, [requerimientoId]);
  const fija = rows[0] ?? null;
  const destinatario = fija ? resolverDestinatario(fija) : null;
  const outcome: MailOutcome = destinatario
    ? await sendMail({ to: destinatario, ...construirCorreoVencimiento(fila) })
    : { status: 'omitido', motivo: 'sin destinatario' };
  if (outcome.status !== 'enviado') {
    console.warn(
      `[requerimientos] no se pudo avisar el vencimiento del requerimiento ${requerimientoId}: ` +
        (outcome.status === 'omitido' ? outcome.motivo : outcome.error),
    );
  }

  // §6.3 — second channel, same rule as the emission path: only escalate when email did not confirm.
  await escalarPorWhatsapp({
    telefono: fija ? resolverTelefono(fija) : null,
    canalPrimarioEstado: outcome.status,
    texto: construirWhatsappVencimiento(fila),
  });

  return outcome.status;
}

/**
 * Retry the notifications that never went out — the other half of config-gating.
 *
 * Without this, every requerimiento emitted while SMTP was unprovisioned would stay un-notified
 * forever: its deadline would never run, and the CT-4 freeze that protects the operation would never
 * fire. The moment the operator sets `SMTP_HOST`/`SMTP_FROM`, the next tick tells everybody who was
 * missed and their clocks start from that point — which is the correct semantics, because that is
 * when they were actually warned.
 */
export async function reintentarNotificaciones(limite = 50): Promise<NotificacionResultado[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT id
       FROM riesgo_requerimientos
      WHERE estado = 'abierto' AND notificado_at IS NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limite],
  );
  const salida: NotificacionResultado[] = [];
  for (const { id } of rows) {
    try {
      salida.push(await notificarRequerimiento(id));
    } catch (err) {
      console.error(`[requerimientos] falló el reintento de notificación de ${id}:`, err);
    }
  }
  return salida;
}

export interface RequerimientosTickSummary {
  ok: boolean;
  vencidos: number;
  notificacionesReintentadas: number;
  notificacionesEnviadas: number;
  /** True when mail is not provisioned — the reason a batch of deadlines is not running (#22). */
  smtpNoConfigurado: boolean;
  detalle: VencimientoDetalle[];
}

/**
 * The tick's requerimientos phase: retry first, then expire.
 *
 * ORDER IS LOAD-BEARING. A requerimiento notified for the first time in this very tick must not be
 * expired by the same tick, and it cannot be: `notificado_at` is set to `now()` by the retry and
 * `vence_at` is in the future for any requerimiento whose deadline has not passed. For one whose
 * deadline HAS already passed while mail was down, the client still gets told first and is expired
 * immediately after — which is honest (the deadline really did pass) and, unlike expiring silently,
 * leaves them a message explaining why their cargo stopped.
 */
export async function runRequerimientosSweep(): Promise<RequerimientosTickSummary> {
  const reintentos = await reintentarNotificaciones();
  const detalle = await expirarVencidos();
  const enviadas = reintentos.filter((r) => r.outcome.status === 'enviado').length;
  return {
    ok: true,
    vencidos: detalle.length,
    notificacionesReintentadas: reintentos.length,
    notificacionesEnviadas: enviadas,
    smtpNoConfigurado: reintentos.some(
      (r) => r.outcome.status === 'omitido' && r.outcome.motivo.startsWith('SMTP no configurado'),
    ),
    detalle,
  };
}
