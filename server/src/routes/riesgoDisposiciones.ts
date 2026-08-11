import { Router, type Request, type Response, type NextFunction } from 'express';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { requireAuth, requireRole } from '../auth/middleware';
import type { Role } from '../auth/token';
import { recordAudit } from '../services/audit';
import { materializarRiesgoEfectivo } from '../services/riesgoEfectivo';
import { validate } from '../validation/middleware';
import {
  disposicionCrearBody,
  manifiestoIdParam,
  type DisposicionCrearBody,
} from '../validation/schemas';
import {
  evaluarDisposiciones,
  hallazgoHash,
  type DisposicionVigente,
} from '../../../shared/risk/efectivo';
import type { ReasonCode, SignalId } from '../../../shared/risk/signals';

/**
 * RIESGO DISPOSICIONES — el humano afirma sobre un hallazgo, y el motor no se toca
 * (diseño 2026-08-10, §3 y §7; orden de trabajo 3).
 *
 * LA INVARIANTE QUE JUSTIFICA TODO EL DISEÑO, escrita aquí porque es aquí donde se podría romper:
 * este router NUNCA escribe `risk_score`, `risk_color`, `risk_incidences`, `risk_reasons` ni
 * `ruleset_hash`. Lo que dijo el motor queda byte a byte como estaba, y lo que afirma el humano vive
 * en `riesgo_disposiciones` con su motivo y su autor. El color EFECTIVO se materializa aparte
 * (`services/riesgoEfectivo.ts`) en columnas propias. Un sistema que sobreescribe la calificación
 * cuando alguien la discute no puede responder la primera pregunta de un auditor —*¿qué dijo el
 * sistema?*— y deja al humano sin coartada: si el color cambió, nadie puede probar que hubo bandera.
 *
 * LA HUELLA LA CALCULA EL SERVIDOR. El cuerpo trae `signalId`, no `hallazgoHash`: la huella sale de
 * la razón que el motor almacenó en `shipments.risk_reasons` para esa línea. Un cliente que elige la
 * huella dispone hallazgos que nunca existieron, y la tabla pasaría de "qué afirmó un humano sobre
 * qué" a "qué escribió alguien". `signalId` basta como asa porque el motor emite como mucho UNA razón
 * por señal y por línea (`shared/risk/signals.ts`): las dos variantes de `monto` son excluyentes y
 * las de lista producen una sola coincidencia.
 *
 * DOS COMPUERTAS DE 409, Y NINGUNA ES DEFENSIVA. `sin_hallazgo_vigente` si esa señal no dispara hoy
 * en esa línea: disponer de un hallazgo inexistente crea una afirmación humana que nada sostiene, y
 * peor, que se activaría sola el día que el hallazgo apareciera de verdad. `analisis_rancio` si
 * `manifests.risk_stale`: los datos cambiaron después de la última corrida, así que las razones
 * describen un manifiesto que ya no es éste — un humano no dispone sobre datos rancios, vuelve a
 * correr el análisis. Reutiliza el concepto de rancio que ya existe y ya tiene banner ámbar.
 *
 * RETRACTARSE ES INSERTAR. La tabla es append-only por trigger; deshacer una supresión es escribir un
 * `confirmado` con `supersede_a` apuntando a la fila anterior, y gana la última por
 * `(línea, señal, huella)`. No hay UPDATE ni DELETE en este archivo, y no puede haberlos.
 *
 * ROUTING. Se monta sobre `/api/manifests`, junto a `manifestsRouter`, `pedimentoUploadRouter` y
 * `riskRouter`. Sus dos rutas son multi-segmento (`/:id/riesgo/disposiciones`) con el `:id` validado
 * como UUID, así que ni sombrean ni son sombreadas por nada de los otros tres.
 */
export const riesgoDisposicionesRouter = Router();

type Estado = 'falso_positivo' | 'mitigado' | 'confirmado';

interface FilaOro {
  id: string;
  manifest_id: string;
  idempotency_key: string;
  guia: string | null;
  risk_color: string | null;
  risk_reasons: ReasonCode[] | null;
  ruleset_hash: string | null;
  risk_color_efectivo: string | null;
  risk_score_efectivo: number | null;
  risk_disposiciones: { suprimidas?: SignalId[] } | null;
}

// =================================================================================================
// La matriz de roles (§9)
// =================================================================================================

/**
 * La escala, en una frase del diseño: **el rol que hace falta para TAPAR un hallazgo es el mismo que
 * hace falta para EDITAR la lista que lo produjo.**
 *
 * `denied_party` pide super_admin porque `denied_parties` ya es la única clave de configuración
 * restringida a super_admin "para prevenir manipulación" (`routes/catalogs.ts`,
 * `SUPER_ADMIN_CONFIG_KEYS`). Si sólo el super admin puede tocar la lista de sancionados, sólo el
 * super admin puede declarar falso positivo un golpe contra ella; cualquier otra cosa convierte una
 * restricción de configuración en teatro, porque tapar el resultado equivale a borrar la entrada.
 */
const ESCALA: Record<string, number> = { capturista: 1, admin: 2, super_admin: 3 };

/** Las señales que FUERZAN rojo: se tapan con rol de admin, se elija la línea que se elija. */
const SENALES_FORZADAS: ReadonlySet<SignalId> = new Set<SignalId>(['prohibidos', 'pirateria']);

interface Compuerta {
  ok: boolean;
  /** El rol que sí podría hacerlo, nombrado en el 403 para que el bloqueo sea accionable. */
  requerido: 'capturista' | 'admin' | 'super_admin';
  motivo: string;
}

/**
 * ¿Puede este rol afirmar esto sobre este hallazgo?
 *
 * `confirmado` no suprime nada —le da la razón al motor— así que no escala: cualquiera que capture
 * riesgo puede dejar constancia de que miró un hallazgo y está de acuerdo. Todo el escalón vive en
 * las dos afirmaciones que SÍ tapan (`falso_positivo` y `mitigado`), y sube con el peso de lo tapado:
 * una línea amarilla es el trabajo diario de un capturista; una roja es una decisión de admin; un
 * golpe contra la lista de sancionados es del super admin y de nadie más.
 */
function compuertaDeRol(args: {
  rol: Role;
  estado: Estado;
  signalId: SignalId;
  razon: ReasonCode;
  colorCrudo: string | null;
}): Compuerta {
  const nivel = ESCALA[args.rol] ?? 0;
  const permitir = (
    requerido: Compuerta['requerido'],
    motivo: string,
  ): Compuerta => ({ ok: nivel >= ESCALA[requerido], requerido, motivo });

  if (args.estado === 'confirmado') {
    return permitir('capturista', 'confirmar un hallazgo (no suprime nada)');
  }
  if (args.signalId === 'denied_party') {
    return permitir(
      'super_admin',
      'suprimir una coincidencia en lista de sancionados (`denied_party`)',
    );
  }
  if (args.razon.forcesBand === 'rojo' || SENALES_FORZADAS.has(args.signalId)) {
    return permitir('admin', `suprimir un hallazgo que fuerza rojo (\`${args.signalId}\`)`);
  }
  if (args.colorCrudo === 'rojo') {
    return permitir('admin', 'suprimir un hallazgo en una línea que el motor calificó roja');
  }
  return permitir('capturista', 'suprimir un hallazgo en una línea que el motor no calificó roja');
}

// =================================================================================================
// POST — disponer un hallazgo
// =================================================================================================

/**
 * POST /api/manifests/:id/riesgo/disposiciones
 *
 * `requireRole('admin','capturista')` es sólo la compuerta GRUESA (deja fuera a `tramitador` y a
 * `autoridad`, y deja pasar a `super_admin` por el superset que `requireRole` ya implementa). El
 * escalón fino depende de datos que sólo se conocen tras leer la línea —qué señal es y de qué color
 * la pintó el motor— así que se evalúa dentro, con `compuertaDeRol`, y responde 403 nombrando el rol
 * que sí podría.
 *
 * `tramitador` queda fuera con la misma frase que usa `riesgoRequerimientos.ts`: el rol de campo
 * reporta hechos, no impone ni levanta obligaciones. `autoridad` sólo lee: el diseño la trata como
 * TESTIGO y no como actor.
 */
riesgoDisposicionesRouter.post(
  '/:id/riesgo/disposiciones',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ params: manifiestoIdParam, body: disposicionCrearBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const manifestId = req.params.id;
      const body = req.body as DisposicionCrearBody;
      const userId = req.user!.userId;
      const rol = req.user!.role;

      const resultado = await withTransaction(async (q) => {
        const man = await q(
          'SELECT id, risk_stale, version_vigente, ruleset_version FROM manifests WHERE id = $1',
          [manifestId],
        );
        if (!man.rows.length) return { kind: 'manifiesto_no_encontrado' as const };
        const manifiesto = man.rows[0] as {
          risk_stale: boolean;
          version_vigente: number;
          ruleset_version: string | null;
        };

        /**
         * `FOR UPDATE` sobre la línea, patrón de casa para todo comprobar-y-escribir: entre leer
         * `risk_reasons` y escribir la disposición cabe una corrida de riesgo concurrente que cambie
         * justo esas razones, y el resultado sería una afirmación anclada a una huella que ya no
         * existe. Se bloquea la línea, no el manifiesto: dos personas disponiendo hallazgos de dos
         * líneas distintas del mismo manifiesto no tienen por qué esperarse.
         */
        const sh = await q(
          `SELECT id, manifest_id, idempotency_key, data->>'guideId' AS guia,
                  risk_color, risk_reasons, ruleset_hash,
                  risk_color_efectivo, risk_score_efectivo, risk_disposiciones
             FROM shipments
            WHERE id = $1
            FOR UPDATE`,
          [body.shipmentId],
        );
        // La línea ajena responde 404 y no 403: que este manifiesto no la contenga es lo único que
        // el caller necesita saber, y distinguir "no existe" de "es de otro manifiesto" convertiría
        // el endpoint en un oráculo de qué ids existen en la base.
        if (!sh.rows.length || sh.rows[0].manifest_id !== manifestId) {
          return { kind: 'linea_ajena' as const };
        }
        const linea = sh.rows[0] as FilaOro;

        // Rancio ANTES que hallazgo: sobre datos rancios ni siquiera se puede afirmar que la señal
        // "dispara hoy", porque las razones describen el manifiesto anterior a la última corrección.
        if (manifiesto.risk_stale) return { kind: 'analisis_rancio' as const };

        const razones = linea.risk_reasons ?? [];
        const coincidencias = razones.filter((r) => r.signalId === body.signalId);
        if (!coincidencias.length || !linea.ruleset_hash) {
          return { kind: 'sin_hallazgo_vigente' as const };
        }
        // El motor emite como mucho una razón por señal y por línea. Si alguna vez emitiera dos, el
        // `signalId` dejaría de identificar el hallazgo y elegir una en silencio taparía la otra:
        // mejor negarse en voz alta que disponer de la equivocada.
        if (coincidencias.length > 1) return { kind: 'hallazgo_ambiguo' as const };
        const razon = coincidencias[0];
        const hash = hallazgoHash(razon);

        const compuerta = compuertaDeRol({
          rol,
          estado: body.estado,
          signalId: body.signalId,
          razon,
          colorCrudo: linea.risk_color,
        });
        if (!compuerta.ok) return { kind: 'rol_insuficiente' as const, compuerta };

        /**
         * El CHECK `riesgo_disposiciones_mitigado_check` ya lo impide; esto lo impide ANTES, con una
         * frase. `mitigado` afirma que el hallazgo era REAL y está resuelto, así que exige enseñar
         * con qué: el documento que lo resuelve o el requerimiento que el cliente contestó.
         */
        if (body.estado === 'mitigado' && !body.evidenciaFileId && !body.requerimientoId) {
          return { kind: 'mitigado_sin_respaldo' as const };
        }

        // Comprobado en vez de dejado a la FK, misma razón que en `riesgoRequerimientos.ts`: un id
        // caduco debe contestar 400 con una frase, no 500 con el nombre de una constraint.
        if (body.evidenciaFileId) {
          const f = await q('SELECT id FROM files WHERE id = $1', [body.evidenciaFileId]);
          if (!f.rows.length) return { kind: 'archivo_desconocido' as const };
        }
        if (body.requerimientoId) {
          /**
           * El requerimiento tiene que ser del MISMO caso que este manifiesto. Citar el requerimiento
           * de otro expediente para respaldar un `mitigado` sería exactamente la forma de fabricar
           * respaldo: el CHECK sólo comprueba que la columna no esté vacía, no que apunte a algo que
           * tenga que ver con esta carga.
           */
          const r = await q(
            `SELECT r.id
               FROM riesgo_requerimientos r
               JOIN operaciones o ON o.id = r.operacion_id
              WHERE r.id = $1 AND o.manifest_id = $2`,
            [body.requerimientoId, manifestId],
          );
          if (!r.rows.length) return { kind: 'requerimiento_ajeno' as const };
        }
        if (body.supersedeA) {
          // Sólo se puede reemplazar una afirmación sobre EL MISMO hallazgo de LA MISMA línea. Sin
          // esto, `supersede_a` sería un puntero decorativo y la cadena de sucesión —que es la
          // historia que lee el auditor— podría enlazar dos cosas que no se suceden.
          const s = await q(
            `SELECT id FROM riesgo_disposiciones
              WHERE id = $1 AND shipment_id = $2 AND signal_id = $3 AND hallazgo_hash = $4`,
            [body.supersedeA, linea.id, body.signalId, hash],
          );
          if (!s.rows.length) return { kind: 'supersede_ajeno' as const };
        }

        const antes = {
          riskColorEfectivo: linea.risk_color_efectivo,
          riskScoreEfectivo: linea.risk_score_efectivo,
          suprimidas: linea.risk_disposiciones?.suprimidas ?? [],
        };

        const ins = await q(
          `INSERT INTO riesgo_disposiciones
             (manifest_id, shipment_id, idempotency_key, manifiesto_version, signal_id, hallazgo_hash,
              hallazgo, ruleset_version, ruleset_hash, estado, motivo, evidencia_file_id,
              requerimiento_id, supersede_a, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15)
           RETURNING id, created_at`,
          [
            manifestId,
            linea.id,
            // Desnormalizada a propósito: es la identidad DURABLE de la línea y sobrevive al borrado
            // que una corrección de manifiesto hace sobre `shipments` (§3).
            linea.idempotency_key,
            manifiesto.version_vigente,
            body.signalId,
            hash,
            // El `ReasonCode` verbatim, magnitud incluida: la huella sirve para el arrastre, la cita
            // sirve para el auditor. Son dos trabajos distintos y por eso son dos columnas.
            JSON.stringify(razon),
            manifiesto.ruleset_version,
            linea.ruleset_hash,
            body.estado,
            body.motivo,
            body.evidenciaFileId ?? null,
            body.requerimientoId ?? null,
            body.supersedeA ?? null,
            userId,
          ],
        );
        const disposicionId = String(ins.rows[0].id);

        // DENTRO de la transacción: recalcular fuera leería un mundo donde esta fila todavía no
        // existe. La fórmula es absoluta —le pregunta a la tabla qué es verdad ahora— así que sirve
        // igual para disponer, para retractarse y para una disposición que acaba de caducar.
        await materializarRiesgoEfectivo(q, { shipmentId: linea.id });

        const post = await q(
          `SELECT risk_color, risk_color_efectivo, risk_score_efectivo, risk_disposiciones
             FROM shipments WHERE id = $1`,
          [linea.id],
        );
        const efectivo = post.rows[0] as FilaOro;
        const suprimidas = efectivo.risk_disposiciones?.suprimidas ?? [];
        const colorEfectivo = efectivo.risk_color_efectivo ?? efectivo.risk_color;

        /**
         * El evento SÓLO cuando el manifiesto tiene caso. `operacion_eventos.operacion_mawb` es NOT
         * NULL y una carga manual no tiene `operaciones`: el ledger no debe llenarse de filas
         * huérfanas, y en ese escenario la auditoría —que sí se escribe siempre— es el registro.
         */
        const op = await q('SELECT id, mawb FROM operaciones WHERE manifest_id = $1 LIMIT 1', [
          manifestId,
        ]);
        let eventoRegistrado = false;
        if (op.rows.length) {
          await q(
            `INSERT INTO operacion_eventos
               (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, created_by)
             VALUES ($1,$2,'RIESGO_HALLAZGO_DISPUESTO','coordinador',now(),$3,$4)`,
            [
              op.rows[0].id,
              op.rows[0].mawb,
              // Claves y hashes, nunca valores de PII: `hallazgoHash` identifica el hallazgo sin
              // repetir el nombre que coincidió con la lista de sancionados. Quien tenga derecho a
              // leerlo lo lee de `riesgo_disposiciones.hallazgo`, que sí lo cita verbatim.
              JSON.stringify({
                shipmentId: linea.id,
                guia: linea.guia,
                signalId: body.signalId,
                hallazgoHash: hash,
                estado: body.estado,
                motivo: body.motivo,
                colorCrudo: efectivo.risk_color,
                colorEfectivo,
                disposicionId,
                supersedeA: body.supersedeA ?? null,
              }),
              userId,
            ],
          );
          eventoRegistrado = true;
        }

        return {
          kind: 'ok' as const,
          disposicionId,
          linea,
          hash,
          antes,
          despues: {
            riskColorEfectivo: efectivo.risk_color_efectivo,
            riskScoreEfectivo: efectivo.risk_score_efectivo,
            suprimidas,
          },
          colorCrudo: efectivo.risk_color,
          colorEfectivo,
          suprimidas,
          eventoRegistrado,
        };
      });

      switch (resultado.kind) {
        case 'manifiesto_no_encontrado':
          res.status(404).json({ error: 'Manifest not found' });
          return;
        case 'linea_ajena':
          res.status(404).json({ error: 'La línea indicada no pertenece a este manifiesto.' });
          return;
        case 'analisis_rancio':
          res.status(409).json({
            error: 'analisis_rancio',
            mensaje:
              'Los datos cambiaron después del último análisis de riesgo: vuelve a correrlo antes de disponer.',
          });
          return;
        case 'sin_hallazgo_vigente':
          res.status(409).json({
            error: 'sin_hallazgo_vigente',
            mensaje: `La señal '${body.signalId}' no dispara hoy en esta línea; no hay hallazgo que disponer.`,
          });
          return;
        case 'hallazgo_ambiguo':
          res.status(409).json({
            error: 'hallazgo_ambiguo',
            mensaje: `La señal '${body.signalId}' produjo más de un hallazgo en esta línea; el 'signalId' no basta para identificarlo.`,
          });
          return;
        case 'rol_insuficiente':
          res.status(403).json({
            error: `Se requiere el rol '${resultado.compuerta.requerido}' para ${resultado.compuerta.motivo}.`,
            rolRequerido: resultado.compuerta.requerido,
          });
          return;
        case 'mitigado_sin_respaldo':
          res.status(400).json({
            error:
              "Un 'mitigado' afirma que el hallazgo era real y está resuelto: envía `evidenciaFileId` o `requerimientoId`.",
          });
          return;
        case 'archivo_desconocido':
          res.status(400).json({ error: 'El `evidenciaFileId` indicado no existe.' });
          return;
        case 'requerimiento_ajeno':
          res.status(400).json({
            error: 'El `requerimientoId` indicado no existe o no pertenece al caso de este manifiesto.',
          });
          return;
        case 'supersede_ajeno':
          res.status(400).json({
            error:
              'El `supersedeA` indicado no es una disposición sobre este mismo hallazgo de esta misma línea.',
          });
          return;
        default:
          break;
      }

      /**
       * Auditoría SIEMPRE, tenga caso o no el manifiesto, y con `before` además de `after`: el hecho
       * que interesa no es "quedó en verde", es "estaba en rojo y quedó en verde porque alguien lo
       * afirmó". `entity: 'shipment'` porque lo que cambió de lectura es la línea; el id de la
       * disposición viaja en el payload para poder saltar de una a otra.
       */
      await recordAudit({
        userId,
        action: 'RIESGO_DISPOSICION',
        entity: 'shipment',
        entityId: resultado.linea.id,
        before: resultado.antes,
        after: {
          disposicionId: resultado.disposicionId,
          manifestId,
          idempotencyKey: resultado.linea.idempotency_key,
          signalId: body.signalId,
          hallazgoHash: resultado.hash,
          estado: body.estado,
          motivo: body.motivo,
          evidenciaFileId: body.evidenciaFileId ?? null,
          requerimientoId: body.requerimientoId ?? null,
          supersedeA: body.supersedeA ?? null,
          colorCrudo: resultado.colorCrudo,
          ...resultado.despues,
        },
        ip: req.ip,
      });

      res.status(201).json({
        disposicionId: resultado.disposicionId,
        // Las dos palabras, lado a lado y siempre. La del motor no desaparece de ninguna respuesta de
        // esta capa, igual que no desaparece de la pantalla (§10).
        resultadoMotor: resultado.colorCrudo,
        resultado: resultado.colorEfectivo,
        suprimidas: resultado.suprimidas,
        eventoRegistrado: resultado.eventoRegistrado,
      });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// GET — el expediente completo
// =================================================================================================

interface FilaDisposicion {
  id: string;
  shipmentId: string | null;
  idempotencyKey: string;
  guia: string | null;
  manifiestoVersion: number;
  signalId: SignalId;
  hallazgoHash: string;
  hallazgo: ReasonCode;
  rulesetVersion: string | null;
  rulesetHash: string;
  estado: Estado;
  motivo: string;
  evidenciaFileId: string | null;
  requerimientoId: string | null;
  supersedeA: string | null;
  createdBy: string | null;
  createdByUsuario: string | null;
  createdAt: Date;
  /** Contexto de la línea, para evaluar la aplicabilidad sin una segunda consulta. */
  razonesVigentes: ReasonCode[] | null;
  rulesetHashVigente: string | null;
}

/**
 * GET /api/manifests/:id/riesgo/disposiciones — la pantalla del auditor.
 *
 * Devuelve el historial COMPLETO: las vigentes, las reemplazadas por una retractación posterior y las
 * caducadas. Ninguna se oculta, porque el valor de una tabla append-only es precisamente que se
 * puede leer entera; una vista que sólo enseñara "lo que aplica hoy" tendría el mismo efecto que
 * borrar, con la ventaja añadida de parecer honesta.
 *
 * LA APLICABILIDAD NO SE PERSISTE, SE CALCULA AQUÍ. `aplicable`, `caducada` y `revalidacionPendiente`
 * salen de `evaluarDisposiciones` (`shared/risk/efectivo.ts`) contra las razones que el motor tiene
 * AHORA en la línea — la misma función que usa la materialización, para que la pantalla y el color
 * escrito no puedan discrepar nunca. Por eso una corrección de manifiesto hace caducar una
 * disposición sin una sola escritura: la razón nueva tiene otra huella, o simplemente ya no dispara.
 *
 * `autoridad` lee aquí. El diseño la trata como TESTIGO: puede ver qué se tapó, quién lo tapó y con
 * qué motivo, y no puede tapar nada. `tramitador` queda fuera, como en todo lo demás de riesgo.
 */
riesgoDisposicionesRouter.get(
  '/:id/riesgo/disposiciones',
  requireAuth,
  requireRole('admin', 'capturista', 'autoridad'),
  validate({ params: manifiestoIdParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const manifestId = req.params.id;
      const man = await query('SELECT id FROM manifests WHERE id = $1', [manifestId]);
      if (!man.rows.length) {
        res.status(404).json({ error: 'Manifest not found' });
        return;
      }

      const { rows } = await query<FilaDisposicion>(
        `SELECT d.id,
                d.shipment_id        AS "shipmentId",
                d.idempotency_key    AS "idempotencyKey",
                s.data->>'guideId'   AS guia,
                d.manifiesto_version AS "manifiestoVersion",
                d.signal_id          AS "signalId",
                d.hallazgo_hash      AS "hallazgoHash",
                d.hallazgo,
                d.ruleset_version    AS "rulesetVersion",
                d.ruleset_hash       AS "rulesetHash",
                d.estado,
                d.motivo,
                d.evidencia_file_id  AS "evidenciaFileId",
                d.requerimiento_id   AS "requerimientoId",
                d.supersede_a        AS "supersedeA",
                d.created_by         AS "createdBy",
                u.username           AS "createdByUsuario",
                d.created_at         AS "createdAt",
                s.risk_reasons       AS "razonesVigentes",
                s.ruleset_hash       AS "rulesetHashVigente"
           FROM riesgo_disposiciones d
           LEFT JOIN shipments s ON s.id = d.shipment_id
           LEFT JOIN users u ON u.id = d.created_by
          WHERE d.manifest_id = $1
          ORDER BY d.created_at DESC, d.id DESC`,
        [manifestId],
      );

      /**
       * Se agrupa por línea porque la evaluación es por línea: las razones vigentes contra las que se
       * comprueba una afirmación son las de SU shipment. Las filas cuyo `shipment_id` quedó en NULL
       * —líneas que una corrección de manifiesto retiró— caen en su propio grupo sin razones, que es
       * la respuesta correcta: nada las sostiene, así que caducaron.
       */
      const grupos = new Map<string, FilaDisposicion[]>();
      for (const d of rows) {
        const clave = d.shipmentId ?? '(línea retirada)';
        const lista = grupos.get(clave);
        if (lista) lista.push(d);
        else grupos.set(clave, [d]);
      }

      const aplicadas = new Set<string>();
      const caducadas = new Set<string>();
      const revalidacion = new Set<string>();
      /** La última fila por `(línea, señal, huella)` — la que manda, y la única que puede aplicar. */
      const vigentes = new Set<string>();

      for (const grupo of grupos.values()) {
        const razones = grupo[0].razonesVigentes ?? [];
        const ev = evaluarDisposiciones(
          razones,
          grupo.map(
            (d): DisposicionVigente => ({
              id: d.id,
              signalId: d.signalId,
              hallazgoHash: d.hallazgoHash,
              estado: d.estado,
              rulesetHash: d.rulesetHash,
              motivo: d.motivo,
              createdAt: new Date(d.createdAt).toISOString(),
              createdBy: d.createdBy,
            }),
          ),
          { rulesetHashVigente: grupo[0].rulesetHashVigente ?? '' },
        );
        for (const d of ev.aplicadas) aplicadas.add(d.id);
        for (const d of ev.caducadas) caducadas.add(d.id);
        for (const d of ev.revalidacionPendiente) revalidacion.add(d.id);

        // El orden de la consulta ya es el de vigencia (`created_at DESC, id DESC`), el mismo
        // desempate que usa el `DISTINCT ON` de la materialización: la primera de cada clave es la
        // que gana. Sin el desempate por id, dos filas con el mismo microsegundo darían un resultado
        // no determinista, y una pantalla que cambia entre dos lecturas idénticas es indefendible.
        const vistas = new Set<string>();
        for (const d of grupo) {
          const clave = `${d.signalId} ${d.hallazgoHash}`;
          if (vistas.has(clave)) continue;
          vistas.add(clave);
          vigentes.add(d.id);
        }
      }

      res.json({
        disposiciones: rows.map((d) => {
          const { razonesVigentes: _r, rulesetHashVigente: _h, ...fila } = d;
          return {
            ...fila,
            /** Vigente por clave Y sostenida por una razón de hoy. Las dos cosas, o no aplica. */
            aplicable: vigentes.has(d.id) && aplicadas.has(d.id),
            /** Reemplazada por una afirmación posterior sobre el mismo hallazgo (una retractación). */
            supersedida: !vigentes.has(d.id),
            /** Ninguna razón vigente la sostiene: el dato cambió, o el ruleset en una señal forzada. */
            caducada: caducadas.has(d.id),
            /** Sigue aplicando, pero se afirmó contra otro ruleset: ámbar, "que alguien la mire". */
            revalidacionPendiente: revalidacion.has(d.id),
          };
        }),
      });
    } catch (err) {
      next(err);
    }
  },
);
