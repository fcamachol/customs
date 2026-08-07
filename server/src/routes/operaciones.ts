import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { manifestTotales } from '../services/manifiestoIngest';
import { parsePrealerta } from '../../../shared/operaciones/prealerta';
import {
  CODIGOS_MANIFIESTO,
  COTEJO_RULESET_VERSION,
  PESO_TOLERANCIA_PCT_DEFAULT,
  cotejarManifiesto,
  mergeDiscrepancias,
  type Discrepancia,
} from '../../../shared/operaciones/cotejo';

export const operacionesRouter = Router();

/**
 * Read API for the Sistema de Operaciones.
 *
 * Read-only on purpose: state changes happen through the ingest, the field-capture endpoints and the
 * tick, never by a client PATCHing a row. That keeps every transition paired with a ledger event, so
 * the timeline can never disagree with the current state.
 *
 * Naming follows the house convention — snake_case in the database, camelCase over the wire via
 * explicit `AS "camelCase"` aliases.
 */

/** GET /api/operaciones — board list. */
operacionesRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { etapa, holdActivo, conDiscrepancias, q } = req.query as Record<string, string | undefined>;
    const limit = Math.min(Number(req.query.limit ?? 200) || 200, 500);

    const { rows } = await query(
      `SELECT o.id,
              o.mawb,
              o.mawb_raw            AS "mawbRaw",
              c.name                AS "clienteNombre",
              o.origen_iata         AS "origenIata",
              o.destino_iata        AS "destinoIata",
              o.numero_vuelo        AS "numeroVuelo",
              o.etd_origen          AS "etdOrigen",
              o.eta_pais            AS "etaPais",
              o.cartones_prealerta  AS "cartonesPrealerta",
              o.piezas_prealerta    AS "piezasPrealerta",
              o.peso_kg_prealerta   AS "pesoKgPrealerta",
              o.etapa,
              o.estado_documental   AS "estadoDocumental",
              o.estado_planeacion   AS "estadoPlaneacion",
              o.semaforo,
              o.hold_activo         AS "holdActivo",
              o.created_at          AS "createdAt",
              v.estado              AS "vueloEstado",
              v.eta_estimado        AS "vueloEtaEstimado",
              v.arribo_real         AS "vueloArriboReal",
              COALESCE(jsonb_array_length(o.discrepancias), 0) AS "discrepanciasCount",
              (SELECT COALESCE(MAX(p.version), 0) FROM prealertas p WHERE p.operacion_id = o.id)
                                    AS "prealertaVersion"
         FROM operaciones o
         LEFT JOIN clients c ON c.id = o.client_id
         LEFT JOIN vuelos  v ON v.id = o.vuelo_id
        WHERE ($1::text IS NULL OR o.etapa = $1)
          AND ($2::boolean IS NULL OR o.hold_activo = $2)
          AND ($3::boolean IS NOT TRUE OR COALESCE(jsonb_array_length(o.discrepancias), 0) > 0)
          AND ($4::text IS NULL OR o.mawb ILIKE '%' || $4 || '%' OR o.numero_vuelo ILIKE '%' || $4 || '%')
        ORDER BY o.created_at DESC
        LIMIT $5`,
      [
        etapa ?? null,
        holdActivo === undefined ? null : holdActivo === 'true',
        conDiscrepancias === 'true',
        q && q.trim() ? q.trim() : null,
        limit,
      ],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

/** GET /api/operaciones/:id — full caso: flight, prealerta versions, evidence, timeline. */
operacionesRouter.get('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const op = await query(
      `SELECT o.id,
              o.mawb,
              o.mawb_raw           AS "mawbRaw",
              o.manifest_id        AS "manifestId",
              o.client_id          AS "clientId",
              c.name               AS "clienteNombre",
              o.origen_iata        AS "origenIata",
              o.destino_iata       AS "destinoIata",
              o.numero_vuelo       AS "numeroVuelo",
              o.etd_origen         AS "etdOrigen",
              o.eta_pais           AS "etaPais",
              o.cartones_prealerta AS "cartonesPrealerta",
              o.piezas_prealerta   AS "piezasPrealerta",
              o.peso_kg_prealerta  AS "pesoKgPrealerta",
              o.etapa,
              o.estado_documental  AS "estadoDocumental",
              o.estado_planeacion  AS "estadoPlaneacion",
              o.semaforo,
              o.hold_activo        AS "holdActivo",
              o.discrepancias,
              o.cotejo_version     AS "cotejoVersion",
              o.arribo_vuelo_at    AS "arriboVueloAt",
              o.disponible_at      AS "disponibleAt",
              o.agora_conversation_id AS "agoraConversationId",
              o.created_at         AS "createdAt"
         FROM operaciones o
         LEFT JOIN clients c ON c.id = o.client_id
        WHERE o.id = $1`,
      [id],
    );
    if (!op.rows.length) {
      res.status(404).json({ error: 'Operación no encontrada' });
      return;
    }

    const vuelo = await query(
      `SELECT v.numero_vuelo      AS "numeroVuelo",
              v.callsign,
              v.aerolinea,
              v.origen_iata       AS "origenIata",
              v.destino_iata      AS "destinoIata",
              v.fecha_operacion   AS "fechaOperacion",
              v.etd_programado    AS "etdProgramado",
              v.eta_programado    AS "etaProgramado",
              v.etd_real          AS "etdReal",
              v.eta_estimado      AS "etaEstimado",
              v.arribo_real       AS "arriboReal",
              v.estado,
              v.fuente,
              v.ultima_lat        AS "ultimaLat",
              v.ultima_lon        AS "ultimaLon",
              v.ultima_altitud_ft AS "ultimaAltitudFt",
              v.ultima_consulta_at AS "ultimaConsultaAt",
              v.fa_flight_id      AS "faFlightId",
              v.aeronave_tipo     AS "aeronaveTipo",
              v.matricula,
              v.progreso_pct      AS "progresoPct",
              v.ruta_filed        AS "rutaFiled",
              v.distancia_km      AS "distanciaKm",
              v.terminal_destino  AS "terminalDestino",
              v.puerta_destino    AS "puertaDestino",
              v.pista_salida      AS "pistaSalida",
              v.pista_llegada     AS "pistaLlegada",
              v.cancelado,
              v.desviado,
              v.destino_real_iata AS "destinoRealIata"
         FROM vuelos v
         JOIN operaciones o ON o.vuelo_id = v.id
        WHERE o.id = $1`,
      [id],
    );

    const prealertas = await query(
      `SELECT p.id,
              p.version,
              p.recibido_at    AS "recibidoAt",
              p.remitente,
              p.asunto,
              p.estado,
              p.motivo_rechazo AS "motivoRechazo",
              p.parser_version AS "parserVersion",
              p.parsed,
              p.raw_file_id    AS "rawFileId",
              p.message_id     AS "messageId",
              COALESCE(
                (SELECT jsonb_agg(jsonb_build_object(
                          'id', a.id, 'tipo', a.tipo, 'originalName', a.original_name,
                          'contentHash', a.content_hash, 'scanVerdict', a.scan_verdict,
                          'fileId', a.file_id) ORDER BY a.tipo)
                   FROM prealerta_adjuntos a WHERE a.prealerta_id = p.id),
                '[]'::jsonb) AS adjuntos
         FROM prealertas p
        WHERE p.operacion_id = $1
        ORDER BY p.version DESC`,
      [id],
    );

    const timeline = await query(
      `SELECT e.id::text,
              e.tipo,
              e.origen,
              e.ocurrido_at   AS "ocurridoAt",
              e.registrado_at AS "registradoAt",
              e.override,
              e.motivo,
              e.payload
         FROM operacion_eventos e
        WHERE e.operacion_id = $1
        ORDER BY e.ocurrido_at ASC, e.id ASC`,
      [id],
    );

    // Reading a caso exposes the client's shipment detail, so it is audited like the other
    // PII-bearing reads in this codebase. Fail-closed: if the audit write fails the read fails too.
    await recordAudit({
      userId: req.user!.userId,
      action: 'VIEW_OPERACION',
      entity: 'operacion',
      entityId: id,
      ip: req.ip,
    });

    res.json({
      ...op.rows[0],
      vuelo: vuelo.rows[0] ?? null,
      prealertas: prealertas.rows,
      timeline: timeline.rows,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/operaciones/:id/reparse — heal a stored parse.
 *
 * `prealertas.parsed` and the mirrored `operaciones.*` columns are a SNAPSHOT taken at ingest time.
 * Fixing a bug in shared/operaciones/prealerta.ts (a new PREALERTA_PARSER_VERSION) does nothing for a
 * caso already stored under the old version — that is exactly what happened in production: two live
 * prealertas carried a stale parse from parser 2026-08b, arrived minutes before 2026-08c deployed.
 * This route re-runs the CURRENT parser against the LATEST stored prealerta and, where the manifest
 * cotejo depends on the corrected fields, re-runs that too, so a parser fix can heal casos that
 * already exist instead of only protecting future ones.
 */
operacionesRouter.post(
  '/:id/reparse',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;

      const op = await query<{ id: string; mawb: string }>(
        `SELECT id, mawb FROM operaciones WHERE id = $1`,
        [id],
      );
      if (!op.rows.length) {
        res.status(404).json({ error: 'Operación no encontrada' });
        return;
      }
      const operacion = op.rows[0];

      const pre = await query<{
        id: string;
        asunto: string | null;
        cuerpo_texto: string | null;
        parser_version: string | null;
        version: number;
      }>(
        `SELECT id, asunto, cuerpo_texto, parser_version, version
           FROM prealertas
          WHERE operacion_id = $1
          ORDER BY version DESC
          LIMIT 1`,
        [id],
      );
      if (!pre.rows.length) {
        res.status(409).json({ error: 'La operación no tiene prealertas' });
        return;
      }
      const prealerta = pre.rows[0];

      const parsed = parsePrealerta({ subject: prealerta.asunto, textBody: prealerta.cuerpo_texto });

      // operaciones.mawb is the unique key every FK (manifest, guías, eventos) hangs off — a reparse
      // may CORRECT fields but must never re-key an existing caso onto a different guía máster.
      if (parsed.fields.mawb && parsed.fields.mawb !== operacion.mawb) {
        res.status(409).json({
          error:
            'El reproceso produjo una guía máster distinta a la de la operación; ' +
            'un reparse no puede re-clavar (re-key) un caso existente.',
        });
        return;
      }

      // Same fallback logic as prealertaIngest.ts's pesoToleranciaPct(): a positive finite override,
      // else the shared default. Duplicated locally because that helper is not exported.
      const pesoToleranciaRaw = Number(process.env.PESO_TOLERANCIA_PCT);
      const pesoToleranciaPct =
        Number.isFinite(pesoToleranciaRaw) && pesoToleranciaRaw > 0
          ? pesoToleranciaRaw
          : PESO_TOLERANCIA_PCT_DEFAULT;

      const declarado = {
        cartones: parsed.fields.cartones ?? null,
        piezas: parsed.fields.piezas ?? null,
        pesoKg: parsed.fields.pesoKg ?? null,
      };

      const { discrepancias } = await withTransaction(async (q) => {
        await q(
          `UPDATE prealertas SET parsed = $2::jsonb, parser_version = $3 WHERE id = $1`,
          [
            prealerta.id,
            JSON.stringify({ fields: parsed.fields, provenance: parsed.provenance, warnings: parsed.warnings }),
            parsed.parserVersion,
          ],
        );

        // Overwrite what the new parse produced; COALESCE-keep whatever it could not read this time —
        // the same convention the ingest's ON CONFLICT clause uses, so a reparse and a resend behave
        // identically with respect to fields the parser missed. mawb itself is never touched here.
        const upd = await q(
          `UPDATE operaciones SET
             mawb_raw           = COALESCE($2, mawb_raw),
             origen_iata        = COALESCE($3, origen_iata),
             destino_iata       = COALESCE($4, destino_iata),
             numero_vuelo       = COALESCE($5, numero_vuelo),
             etd_origen         = COALESCE($6, etd_origen),
             eta_pais           = COALESCE($7, eta_pais),
             cartones_prealerta = COALESCE($8, cartones_prealerta),
             piezas_prealerta   = COALESCE($9, piezas_prealerta),
             peso_kg_prealerta  = COALESCE($10, peso_kg_prealerta)
           WHERE id = $1
           RETURNING discrepancias, manifest_id`,
          [
            id,
            parsed.fields.mawbRaw ?? null,
            parsed.fields.origenIata ?? null,
            parsed.fields.destinoIata ?? null,
            parsed.fields.numeroVuelo ?? null,
            parsed.fields.etdOrigen ?? null,
            parsed.fields.etaPais ?? null,
            parsed.fields.cartones ?? null,
            parsed.fields.piezas ?? null,
            parsed.fields.pesoKg ?? null,
          ],
        );
        const row = upd.rows[0] as { discrepancias: Discrepancia[] | null; manifest_id: string | null };
        let current: Discrepancia[] = row.discrepancias ?? [];
        const manifestId = row.manifest_id;

        // Only the manifest-owned codes (PA-01..PA-03) are recomputed — mergeDiscrepancias replaces
        // exactly that family and leaves PA-04/05/07/08/10 etc. untouched, exactly like a normal
        // cotejo cycle. With no manifest attached, discrepancias is left untouched entirely.
        if (manifestId) {
          const totales = await manifestTotales(manifestId);
          const findings = cotejarManifiesto(declarado, { ...totales, lineas: totales.lineas }, { pesoToleranciaPct });
          current = mergeDiscrepancias(current, findings, CODIGOS_MANIFIESTO);
          await q(
            `UPDATE operaciones SET discrepancias = $2::jsonb, cotejo_version = $3 WHERE id = $1`,
            [id, JSON.stringify(current), COTEJO_RULESET_VERSION],
          );
        }

        // Reuses the COTEJO_EJECUTADO event type deliberately: shared/operaciones/estados.ts's
        // TIPOS_EVENTO vocabulary is owned by another agent concurrently, and semantically a reparse
        // IS another cotejo run — payload.reproceso is what distinguishes it from an ingest-time one.
        await q(
          `INSERT INTO operacion_eventos (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
           VALUES ($1, $2, 'COTEJO_EJECUTADO', 'sistema', now(), $3)`,
          [
            id,
            operacion.mawb,
            JSON.stringify({
              reproceso: true,
              parserVersionAntes: prealerta.parser_version,
              parserVersionDespues: parsed.parserVersion,
              prealertaVersion: prealerta.version,
              fields: parsed.fields,
              warnings: parsed.warnings,
              discrepancias: current,
            }),
          ],
        );

        return { discrepancias: current };
      });

      // recordAudit runs its own transaction (advisory-locked hash chain), so it must sit outside
      // withTransaction — same house rule every other writer in this codebase follows.
      await recordAudit({
        userId: req.user!.userId,
        action: 'PREALERTA_REPROCESADA',
        entity: 'operacion',
        entityId: id,
        after: {
          mawb: operacion.mawb,
          prealertaId: prealerta.id,
          prealertaVersion: prealerta.version,
          parserVersionAntes: prealerta.parser_version,
          parserVersionDespues: parsed.parserVersion,
          warnings: parsed.warnings.length,
          discrepancias: discrepancias.length,
        },
        ip: req.ip,
      });

      res.json({
        ok: true,
        parserVersion: parsed.parserVersion,
        fields: parsed.fields,
        warnings: parsed.warnings.length,
        discrepancias: discrepancias.length,
      });
    } catch (err) {
      next(err);
    }
  },
);
