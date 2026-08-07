import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { recordAudit } from '../services/audit';

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
