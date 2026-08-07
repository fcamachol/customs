import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { saveFile } from '../storage/files';
import { validate } from '../validation/middleware';
import {
  campoEventoBody,
  campoEvidenciaBody,
  campoOperacionParam,
  type CampoEventoBody,
  type CampoEventoTipo,
  type CampoEvidenciaBody,
} from '../validation/schemas';
import { canAdvanceEtapa, type Etapa, type TipoEvento } from '../../../shared/operaciones/estados';

/**
 * Field capture — the tramitador's write path (PRD-02 R11, R30–R35, §9.4, §13).
 *
 * THE PREMISE. There is no electronic feed for cargo availability and none for the semáforo result;
 * both were confirmed absent in the source meeting. The warehouse can sit on a landed shipment for up
 * to seven hours and will not call (R11), and at the semáforo phones are prohibited outright (R33).
 * So the only sensor this system has for the middle of an operation is a person with a phone, and the
 * job of these endpoints is to make that person's report *structured, timed and non-repudiable*
 * instead of a cell in someone's Excel. Every accepted call appends to `operacion_eventos` (append-only
 * by trigger) and mirrors into the audit hash chain, so `GET /api/audit/verify` covers field facts too.
 *
 * FOUR RULES THAT LOOK DEFENSIVE AND ARE ACTUALLY THE PRODUCT:
 *
 * 1. `ocurridoAt` ≠ `registradoAt`. The event time is whatever the tramitador says it was; the
 *    registration time is ours. Modulación is captured ~5 minutes late by design, so a past
 *    `ocurridoAt` is CORRECT input and must never be rejected as stale.
 *
 * 2. Forward jumps are allowed, regressions are not. Facts arrive out of order — a tramitador who
 *    forgot to press "inicio de carga" still has to be able to report the modulación. `etapa` is
 *    monotonic (`canAdvanceEtapa`), so the later fact wins and the ledger keeps the gap visible.
 *
 * 3. A repeat of the same etapa is a no-op, not an error and not a second event. Warehouse
 *    connectivity is bad, CampoView queues and retries (N4); a retry must be idempotent or the
 *    timeline fills with phantom duplicates.
 *
 * 4. Most buttons do not move `etapa` at all. INGRESO_PATIO, INGRESO_ADUANA and FIN_CARGA are pure
 *    ledger facts, and that is the point: their value is the timestamp delta (cited 10:00, entered
 *    10:05 — R30), which a single state column can never express.
 */
export const campoRouter = Router();

/** Who may capture from the field. `admin`/`capturista` included so an office coordinator can fix a
 *  missed capture; `super_admin` satisfies `admin` inside requireRole. `autoridad` is read-only. */
const rolesCampo = ['tramitador', 'capturista', 'admin'] as const;

/**
 * Clock tolerances for `ocurridoAt`. A device clock can drift, so a few minutes into the future is
 * accepted rather than treated as fraud; anything beyond that is a bad clock or a typo and would
 * corrupt every downstream KPI. The 48-hour floor exists for the opposite reason: a genuinely late
 * capture is normal (a phone with no signal all afternoon), a two-day-old one is data entry and
 * belongs to the office with an `override` + `motivo`, not to a field button.
 */
const FUTURO_TOLERANCIA_MS = 10 * 60 * 1000;
const PASADO_TOLERANCIA_MS = 48 * 60 * 60 * 1000;

/**
 * Which etapa each button lands on, `null` for the ledger-only facts.
 *
 * INGRESO_ADUANA is deliberately `null`. It reads like the disponible → en_carga transition and it is
 * not: the patio regulador sits BEFORE the aduana, and a unit can be inside the aduana for a long
 * while before anyone starts loading it. `en_carga` means cargo is moving, so only INICIO_CARGA
 * asserts it (R31).
 *
 * MODULACION skips `modulado` and lands on the outcome. The semáforo result is known at the same
 * instant as the crossing, so `modulado` would be a state the row occupies for zero time; recording
 * it would only cost an extra ledger row that says nothing the MODULACION event does not already say.
 * `modulado` stays in the vocabulary (and in the tareas filter) because other writers may set it.
 */
const ETAPA_DESTINO: Record<CampoEventoTipo, Etapa | null> = {
  CARGA_DISPONIBLE: 'disponible',
  INGRESO_PATIO: null,
  INGRESO_ADUANA: null,
  INICIO_CARGA: 'en_carga',
  FIN_CARGA: null,
  MODULACION: null, // resolved from `semaforo`: green → en_transito, red → reconocimiento
  SALIDA_ROJO: 'en_transito',
};

/** Widening guard: tsc rejects this if a campo tipo is missing from the shared ledger vocabulary. */
function tipoLedger(tipo: CampoEventoTipo): TipoEvento {
  return tipo;
}

function minutosEntre(desde: Date, hasta: Date): number {
  return Math.round((hasta.getTime() - desde.getTime()) / 60000);
}

/** What the transaction decided, mapped to a status code by the handler. */
type Resultado =
  | { kind: 'no_encontrada' }
  | { kind: 'noop'; etapa: Etapa }
  | { kind: 'regresion'; etapaActual: Etapa; destino: Etapa }
  | { kind: 'fuera_de_reconocimiento'; etapaActual: Etapa }
  | {
      kind: 'ok';
      eventoId: string;
      mawb: string;
      etapaAnterior: Etapa;
      etapa: Etapa;
      semaforo: 'green' | 'red' | null;
      payload: Record<string, unknown>;
    };

/**
 * POST /api/campo/operaciones/:id/evento — one of the seven CampoView buttons.
 *
 * State change and ledger row are written in ONE transaction so the timeline can never disagree with
 * the current state; `recordAudit` runs after the commit because it takes its own advisory lock for
 * the hash chain (same convention as every other writer here).
 */
campoRouter.post(
  '/operaciones/:id/evento',
  requireAuth,
  requireRole(...rolesCampo),
  validate({ params: campoOperacionParam, body: campoEventoBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { tipo, ocurridoAt, lat, lng, semaforo, citaAt, motivo, override } =
        req.body as CampoEventoBody;

      // ---- Body-level rules, checked before touching the database.

      // The DB has the same CHECK (operacion_eventos_override_motivo_check). Surfaced here so the
      // caller gets a Spanish 400 instead of a 500 from a constraint violation.
      if (override && !(motivo ?? '').trim()) {
        res.status(400).json({ error: 'Un override requiere `motivo`: hay que decir por qué.' });
        return;
      }
      if (tipo === 'MODULACION' && !semaforo) {
        res.status(400).json({
          error: "MODULACION requiere `semaforo` ('green' o 'red'): el cruce sin resultado no es un hecho.",
        });
        return;
      }

      const ocurrido = ocurridoAt ? new Date(ocurridoAt) : new Date();
      const ahora = Date.now();
      if (ocurrido.getTime() - ahora > FUTURO_TOLERANCIA_MS) {
        res.status(400).json({
          error: 'ocurridoAt no puede estar más de 10 minutos en el futuro: revisa el reloj del dispositivo.',
        });
        return;
      }
      if (ahora - ocurrido.getTime() > PASADO_TOLERANCIA_MS) {
        res.status(400).json({
          error:
            'ocurridoAt no puede tener más de 48 horas de antigüedad; una captura tan tardía se registra desde oficina con override y motivo.',
        });
        return;
      }
      const cita = citaAt ? new Date(citaAt) : null;

      const resultado = await withTransaction(async (q): Promise<Resultado> => {
        // FOR UPDATE: two tramitadores on the same guía (or a queued retry racing the original) must
        // not both read the same etapa and both decide they are advancing it.
        const op = await q(
          `SELECT id, mawb, etapa, semaforo, modulacion_at
             FROM operaciones WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (!op.rows.length) return { kind: 'no_encontrada' };
        const operacion = op.rows[0] as {
          id: string;
          mawb: string;
          etapa: Etapa;
          semaforo: 'green' | 'red' | null;
          modulacion_at: Date | null;
        };
        const etapaActual = operacion.etapa;

        // R35: "salida de rojo" is only meaningful as the exit from reconocimiento aduanero. Anywhere
        // else it would start a red-time counter from nothing and poison the KPI.
        if (tipo === 'SALIDA_ROJO' && etapaActual !== 'reconocimiento') {
          return { kind: 'fuera_de_reconocimiento', etapaActual };
        }

        const destino: Etapa | null =
          tipo === 'MODULACION'
            ? semaforo === 'red'
              ? 'reconocimiento'
              : 'en_transito'
            : ETAPA_DESTINO[tipo];

        if (destino) {
          // Rule 3: an exact repeat is the retry queue doing its job. No row, no event, no error.
          if (destino === etapaActual) return { kind: 'noop', etapa: etapaActual };
          // Rule 2: forward jumps yes, regressions no.
          if (!canAdvanceEtapa(etapaActual, destino)) {
            return { kind: 'regresion', etapaActual, destino };
          }
        }

        const payload: Record<string, unknown> = {
          etapaAnterior: etapaActual,
          etapaNueva: destino ?? etapaActual,
          ocurridoAt: ocurrido.toISOString(),
          // Recorded so an auditor can tell a device-supplied time from a server-supplied one without
          // having to compare against registrado_at and guess.
          ocurridoAtDeclarado: ocurridoAt ?? null,
        };
        if (cita) {
          payload.citaAt = cita.toISOString();
          // THE point of R30: not that the unit arrived, but how far off its appointment it was.
          // Negative means early. Computed on write because `citaAt` is not stored anywhere else.
          payload.demoraMin = minutosEntre(cita, ocurrido);
        }

        const sets: string[] = [];
        const params: unknown[] = [id];
        const set = (col: string, val: unknown): void => {
          params.push(val);
          sets.push(`${col} = $${params.length}`);
        };
        if (destino) set('etapa', destino);

        switch (tipo) {
          case 'CARGA_DISPONIBLE':
            // R11: the fact the warehouse never phones in. This timestamp is what makes the
            // "landed at X, released at X+7h" gap measurable at all.
            set('disponible_at', ocurrido);
            break;
          case 'MODULACION':
            set('semaforo', semaforo);
            set('modulacion_at', ocurrido);
            payload.semaforo = semaforo;
            break;
          case 'SALIDA_ROJO': {
            set('salida_rojo_at', ocurrido);
            // R35's KPI. Null when modulacion_at is missing (a red reached by another writer without
            // a MODULACION event) — reported as null rather than as a fabricated zero.
            payload.tiempoEnRojoMin = operacion.modulacion_at
              ? minutosEntre(new Date(operacion.modulacion_at), ocurrido)
              : null;
            payload.modulacionAt = operacion.modulacion_at
              ? new Date(operacion.modulacion_at).toISOString()
              : null;
            payload.semaforo = operacion.semaforo;
            break;
          }
          default:
            break;
        }

        if (sets.length) {
          await q(`UPDATE operaciones SET ${sets.join(', ')} WHERE id = $1`, params);
        }

        const ev = await q(
          `INSERT INTO operacion_eventos
             (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, override, motivo, lat, lng, created_by)
           VALUES ($1,$2,$3,'tramitador',$4,$5,$6,$7,$8,$9,$10)
           RETURNING id`,
          [
            operacion.id,
            operacion.mawb,
            tipoLedger(tipo),
            ocurrido,
            JSON.stringify(payload),
            override ?? false,
            motivo ?? null,
            lat ?? null,
            lng ?? null,
            req.user!.userId,
          ],
        );

        return {
          kind: 'ok',
          eventoId: String((ev.rows[0] as { id: string | number }).id),
          mawb: operacion.mawb,
          etapaAnterior: etapaActual,
          etapa: destino ?? etapaActual,
          semaforo: tipo === 'MODULACION' ? (semaforo ?? null) : operacion.semaforo,
          payload,
        };
      });

      switch (resultado.kind) {
        case 'no_encontrada':
          res.status(404).json({ error: 'Operación no encontrada' });
          return;
        case 'fuera_de_reconocimiento':
          res.status(409).json({
            error: `SALIDA_ROJO sólo aplica cuando la operación está en reconocimiento; la etapa actual es '${resultado.etapaActual}'.`,
            etapaActual: resultado.etapaActual,
          });
          return;
        case 'regresion':
          res.status(409).json({
            error: `La etapa no puede regresar de '${resultado.etapaActual}' a '${resultado.destino}': el avance físico es monótono.`,
            etapaActual: resultado.etapaActual,
          });
          return;
        case 'noop':
          // 200, not 409: the caller asked for a state the operación is already in, which is what a
          // retry looks like. `noop` lets CampoView drop the item from its queue instead of retrying.
          res.json({ ok: true, noop: true, etapa: resultado.etapa });
          return;
        default:
          break;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: tipoLedger(tipo),
        entity: 'operacion',
        entityId: id,
        after: {
          mawb: resultado.mawb,
          eventoId: resultado.eventoId,
          etapaAnterior: resultado.etapaAnterior,
          etapa: resultado.etapa,
          semaforo: resultado.semaforo,
          override: override ?? false,
          motivo: motivo ?? null,
          ...resultado.payload,
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        eventoId: resultado.eventoId,
        tipo,
        etapaAnterior: resultado.etapaAnterior,
        etapa: resultado.etapa,
        semaforo: resultado.semaforo,
        payload: resultado.payload,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Evidence upload. 15 MB because a modern phone photo is 3–8 MB and HEIC bursts are larger; well
 * under the 100 MB manifest ceiling because nobody should be uploading video from a dock.
 */
const uploadEvidencia = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

/**
 * Content-type allowlist. Deliberately short: a photo or a scanned document, nothing executable.
 * These bytes come from a phone in a customs yard and are later served back to office staff and,
 * through the POD, to clients — so the same fail-closed posture as the prealerta attachments applies.
 * HEIC/HEIF are here because that is what an iPhone produces by default.
 */
const TIPOS_CONTENIDO_EVIDENCIA = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

/**
 * POST /api/campo/operaciones/:id/evidencia — the photo Alfonso demanded (R32 / D5).
 *
 * Multipart, because the alternative (base64 in JSON) triples the bytes over a warehouse connection.
 * `capturadoAt` is required and comes from the device: a photo without a capture time proves that
 * something was photographed, not when — and "when" is the entire evidentiary value.
 *
 * The photo does NOT move `etapa`. Evidence corroborates a fact, it does not assert one; the
 * corresponding button does that. This keeps a failed upload from blocking the operation and a
 * successful one from advancing it behind the tramitador's back.
 */
campoRouter.post(
  '/operaciones/:id/evidencia',
  requireAuth,
  requireRole(...rolesCampo),
  // multer first: without it req.body is empty for multipart and every field would fail validation.
  uploadEvidencia.single('file'),
  validate({ params: campoOperacionParam, body: campoEvidenciaBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { tipo, capturadoAt, lat, lng, deviceId, eventoId } = req.body as CampoEvidenciaBody;

      if (!req.file) {
        res.status(400).json({ error: 'Falta el archivo de evidencia (campo `file`).' });
        return;
      }
      const contentType = (req.file.mimetype ?? '').toLowerCase();
      if (!TIPOS_CONTENIDO_EVIDENCIA.has(contentType)) {
        res.status(400).json({
          error: `Tipo de archivo no permitido ('${contentType || 'desconocido'}'). Se aceptan imágenes (jpeg, png, webp, heic) o PDF.`,
        });
        return;
      }

      const op = await query<{ id: string; mawb: string; etapa: string }>(
        'SELECT id, mawb, etapa FROM operaciones WHERE id = $1',
        [id],
      );
      if (!op.rows.length) {
        res.status(404).json({ error: 'Operación no encontrada' });
        return;
      }
      const operacion = op.rows[0];

      // A caller-supplied eventoId must belong to THIS operación. Otherwise a typo would file a photo
      // against someone else's shipment — evidence pointing at the wrong caso is worse than none.
      if (eventoId) {
        const ev = await query<{ id: string }>(
          'SELECT id FROM operacion_eventos WHERE id = $1 AND operacion_id = $2',
          [eventoId, id],
        );
        if (!ev.rows.length) {
          res.status(400).json({ error: 'El `eventoId` indicado no pertenece a esta operación.' });
          return;
        }
      }

      // Hash-and-store BEFORE the ledger write, same order as the prealerta ingest (rule R-A):
      // evidence is archived before it is acted on. saveFile computes the sha256 content_hash.
      const file = await saveFile({
        kind: 'evidencia',
        originalName: req.file.originalname,
        bytes: req.file.buffer,
        uploadedBy: req.user!.userId,
      });

      const capturado = new Date(capturadoAt);
      // Minted here so the ledger event can name the evidencia row and the row can name the event —
      // both directions resolvable from either side, in one transaction.
      const evidenciaId = randomUUID();

      const eventoNuevoId = await withTransaction(async (q) => {
        const ev = await q(
          `INSERT INTO operacion_eventos
             (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, lat, lng, evidencia_file_id, created_by)
           VALUES ($1,$2,'EVIDENCIA_CAPTURADA','tramitador',$3,$4,$5,$6,$7,$8)
           RETURNING id`,
          [
            operacion.id,
            operacion.mawb,
            capturado,
            JSON.stringify({
              tipo,
              fileId: file.id,
              contentHash: file.contentHash,
              evidenciaId,
              originalName: req.file!.originalname,
              contentType,
              sizeBytes: file.sizeBytes,
              capturadoAt: capturado.toISOString(),
              deviceId: deviceId ?? null,
              eventoId: eventoId ?? null,
              etapa: operacion.etapa,
            }),
            lat ?? null,
            lng ?? null,
            file.id,
            req.user!.userId,
          ],
        );
        const nuevoId = String((ev.rows[0] as { id: string | number }).id);

        await q(
          `INSERT INTO operacion_evidencias
             (id, operacion_id, evento_id, file_id, tipo, capturado_at, lat, lng, device_id, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            evidenciaId,
            operacion.id,
            // Link to the field event this photo backs when the caller named one; otherwise to the
            // EVIDENCIA_CAPTURADA event just written, so the row is never orphaned.
            eventoId ?? nuevoId,
            file.id,
            tipo,
            capturado,
            lat ?? null,
            lng ?? null,
            deviceId ?? null,
            req.user!.userId,
          ],
        );
        return nuevoId;
      });

      await recordAudit({
        userId: req.user!.userId,
        action: 'EVIDENCIA_CAPTURADA',
        entity: 'operacion',
        entityId: id,
        after: {
          mawb: operacion.mawb,
          evidenciaId,
          eventoId: eventoNuevoId,
          tipo,
          fileId: file.id,
          contentHash: file.contentHash,
          capturadoAt: capturado.toISOString(),
          deviceId: deviceId ?? null,
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        evidenciaId,
        eventoId: eventoNuevoId,
        fileId: file.id,
        contentHash: file.contentHash,
        tipo,
        capturadoAt: capturado.toISOString(),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/campo/tareas — the tramitador's queue.
 *
 * Everything physically in play: landed but not yet released by the warehouse, released, loading,
 * modulada, or held in reconocimiento. Ordered by arrival time with NULLS LAST so the shipments with
 * a known clock come first and the ones with no arrival data fall to the bottom instead of the top.
 *
 * This is the ONLY read the tramitador role has, and it is intentionally thin: guía, etapa, flight,
 * two timestamps, semáforo. No client, no value, no consignatario — the role with the most physical
 * exposure carries the least information (PRD-02 §13).
 */
campoRouter.get(
  '/tareas',
  requireAuth,
  requireRole(...rolesCampo),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { rows } = await query(
        `SELECT o.id,
                o.mawb,
                o.etapa,
                o.arribo_vuelo_at AS "arriboVueloAt",
                o.disponible_at   AS "disponibleAt",
                o.semaforo,
                o.numero_vuelo    AS "numeroVuelo"
           FROM operaciones o
          WHERE o.etapa IN ('arribado','disponible','en_carga','modulado','reconocimiento')
          ORDER BY o.arribo_vuelo_at ASC NULLS LAST, o.mawb ASC
          LIMIT 200`,
      );
      res.json(rows);
    } catch (err) {
      next(err);
    }
  },
);
