import { Router, type NextFunction, type Request, type Response } from 'express';
import { unlink } from 'node:fs/promises';
import { withTransaction } from '../db/tx';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { isDemoMode } from '../auth/roles';
import { validate } from '../validation/middleware';
import { demoResetBody, type DemoResetBody } from '../validation/schemas';

export const adminRouter = Router();

/**
 * demoOnly — first gate on the reset endpoint. When DEMO_MODE !== 'true' the route
 * responds 404 so a non-demo deployment does not even reveal the feature's existence.
 * Placed before requireAuth so the 404 is returned regardless of credentials.
 */
function demoOnly(_req: Request, res: Response, next: NextFunction): void {
  if (!isDemoMode()) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  next();
}

/**
 * The Sistema de Operaciones surface, in FK-safe order — wiped ONLY when the caller opts in.
 *
 * WHY THE OPT-IN. `demo-reset` predates the operations system: it wiped manifests, their cascade and
 * the files table, and nothing else, so a "pristine" demo started with yesterday's trucks on today's
 * board. Listing PRD-02's tables here fixed that and overshot: an unauthenticated-shaped request with
 * NO BODY AT ALL now truncated `operacion_eventos` — the append-only ledger whose entire purpose is
 * that no later fact can be smuggled into an earlier one — along with every trip, hold, requerimiento
 * and invoice. A demo button that can erase the record of what the system said is a bigger lie than
 * the stale board it was fixing. So the operational wipe is a thing the caller ASKS for
 * (`{ "incluirOperaciones": true }`), and the default is exactly the pre-PRD-02 behaviour.
 *
 * TRUNCATE, NOT DELETE, AND THAT IS LOAD-BEARING. `operacion_eventos` carries a BEFORE UPDATE OR
 * DELETE trigger that makes the ledger append-only (migration 1700003900000); a `DELETE` against it
 * raises. `TRUNCATE` does not fire row-level triggers, which is exactly how `test/helpers/db.ts`
 * resets the same table, and it is legitimate here for the same reason: this is a whole-table reset
 * under an explicit demo gate AND an explicit opt-in, not an attempt to erase one inconvenient row.
 *
 * THE ORDER IS FK ORDER AND THE LIST IS EXPLICIT — no `CASCADE`. One statement truncates them
 * together, so no intermediate state ever violates a constraint. Explicit rather than cascading
 * because CASCADE would silently reach whatever a future migration attaches, and a reset that quietly
 * grows its own blast radius is how a survivor table (`clients`, `users`) eventually stops surviving.
 * If a new ops table is added and not listed here, Postgres refuses the statement by name — a loud
 * failure in a test instead of a quiet leftover in a demo.
 *
 * NOT TRUNCATED, deliberately: `integracion_cursores`. Those rows are seeded by migration and are the
 * scheduler's watermark, not demo data — removing them does not reset the tick, it breaks it.
 */
const TABLAS_OPERACIONES = [
  'operacion_eventos',
  'operacion_evidencias',
  'operacion_guias',
  'operacion_holds',
  'retenciones',
  'riesgo_requerimientos',
  'replan_acciones',
  'replan_evaluaciones',
  'prealerta_adjuntos',
  'prealertas',
  'despacho_partidas',
  'despachos',
  'plan_publicaciones',
  'pods',
  'factura_partidas',
  'facturas',
  'operaciones',
  'vuelos',
] as const;

/**
 * THE DURABLE CATALOGS. These NEVER go, whatever the request says.
 *
 * A carrier, its fleet, its signed convenio and the rates inside it, a client's delivery addresses
 * and its agreed tariffs — these are counterparties and commercial terms, entered by an admin, and
 * several of them (`transportista_convenios`, `convenios`, `client_tarifas`) carry a NOM-151 signed
 * document and its evidence hash. Truncating them from a demo button destroys signed agreements to
 * clean up a whiteboard. They are the same kind of thing as `clients` and `agentes_aduanales`, which
 * this endpoint has always preserved, and they are now treated the same way.
 *
 * Listed rather than merely omitted so the policy is readable, and so the response can name what it
 * kept instead of leaving the operator to infer it.
 */
const TABLAS_CATALOGOS_DURABLES = [
  'transportistas',
  'transportista_unidades',
  'transportista_convenios',
  'transportista_tarifas',
  'client_direcciones',
  'client_tarifas',
  'convenios',
] as const;

/**
 * File references held by rows that SURVIVE this reset — a file is deleted only when nothing that is
 * still standing points at it.
 *
 * WHY THIS REPLACED `DELETE FROM files`. Two reasons, both of which the blanket delete got wrong.
 * `operacion_evidencias.file_id` is ON DELETE RESTRICT (a field-captured photo must not vanish out
 * from under its event), so with campo evidence on file and the ops surface preserved, the blanket
 * delete does not merely misbehave — it fails the whole request. And every other FK into `files` is
 * ON DELETE SET NULL, which is worse than failing: a signed convenio would keep its row, keep its
 * hash column, and quietly lose the pointer to the document it was signed on.
 *
 * So the rule is stated positively and applies to both modes: durable catalogs always pin their
 * documents; the operational tables pin theirs while they are being preserved. Whatever is left —
 * the manifest graph's files and the never-referenced rows abandoned uploads leave behind, since
 * `saveFile()` commits before its referencing row is attached — is demo debris and goes.
 */
const REFERENCIAS_FILES_DURABLES: ReadonlyArray<readonly [string, string]> = [
  ['convenios', 'file_id'],
  ['convenios', 'firma_evidencia_file_id'],
  ['client_tarifas', 'contrato_file_id'],
  ['transportista_convenios', 'file_id'],
  ['transportista_convenios', 'firma_evidencia_file_id'],
];

const REFERENCIAS_FILES_OPERACIONES: ReadonlyArray<readonly [string, string]> = [
  ['operacion_evidencias', 'file_id'],
  ['operacion_eventos', 'evidencia_file_id'],
  ['prealertas', 'raw_file_id'],
  ['prealerta_adjuntos', 'file_id'],
  ['pods', 'file_id_generado'],
  ['pods', 'file_id_firmado'],
  ['pods', 'firma_evidencia_file_id'],
  ['retenciones', 'evidencia_file_id'],
  ['riesgo_requerimientos', 'evidencia_file_id'],
  ['facturas', 'file_id'],
];

function sqlArchivosFijados(referencias: ReadonlyArray<readonly [string, string]>): string {
  // Table and column names are compile-time literals from the two lists above, never request input.
  return referencias
    .map(([tabla, col]) => `SELECT ${col} AS id FROM ${tabla} WHERE ${col} IS NOT NULL`)
    .join(' UNION ');
}

/**
 * POST /api/admin/demo-reset — wipe demo data so a demo can restart from a clean board.
 *
 * WHAT GOES, ALWAYS: the manifest graph (manifests + everything cascading off them: shipments,
 * pedimentos, pedimento_scans, manifest_staging_rows, monthly_history) and every stored file that
 * nothing surviving still points at.
 *
 * WHAT GOES ONLY ON `{ "incluirOperaciones": true }`: the Sistema de Operaciones graph — casos and
 * their guías, the append-only `operacion_eventos` ledger, campo evidence, prealertas, the freeze
 * layer (holds/retenciones/requerimientos), the contingency engine's evaluations and actions, trips
 * and their partidas, published plans, PODs, invoices, and observed flights.
 *
 * WHAT NEVER GOES: users, clients, platforms, catalogs, header mappings, compliance config, validated
 * RFCs, the scheduler cursors (`integracion_cursores`), the append-only audit log (which instead
 * gains a DEMO_RESET trace) — and the durable commercial catalogs listed in
 * `TABLAS_CATALOGOS_DURABLES`, with the signed documents attached to them.
 *
 * The response says which surfaces it actually touched. "It ran" is not an answer to "what did it
 * delete", and an operator about to give a demo is entitled to the second one.
 *
 * RELATIONSHIP TO `RESET_DATA_KEEP_USERS` (`server/scripts/resetData.ts`, run by
 * `docker-entrypoint.sh` on every boot while the flag is `true`): they are two different tools and
 * neither is changed by the other. The boot script truncates EVERY public table except `users` and
 * `pgmigrations` by enumerating `pg_tables`, so it needs no list; it is the operator's one-shot
 * "start this deployment over", gated on an env var that has to be unset again by hand. This endpoint
 * is the in-app, DEMO_MODE-gated, authenticated, audited reset that keeps clients and catalogs — the
 * thing a person clicks between demos. Nothing here touches boot behaviour.
 *
 * Gates: DEMO_MODE=true (else 404) + role admin/super_admin (else 403).
 */
adminRouter.post(
  '/demo-reset',
  demoOnly,
  requireAuth,
  requireRole('admin', 'super_admin'),
  validate({ body: demoResetBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const incluirOperaciones = (req.body as DemoResetBody).incluirOperaciones === true;

      const result = await withTransaction(async (q) => {
        // Counts for the response/audit payload, taken in ONE statement so they all
        // come from the same snapshot as each other (under READ COMMITTED, separate
        // statements could undercount vs. the DELETE below).
        const counts = await q(
          `SELECT (SELECT count(*) FROM manifests)::int    AS manifests,
                  (SELECT count(*) FROM pedimentos)::int   AS pedimentos,
                  (SELECT count(*) FROM shipments)::int    AS shipments,
                  (SELECT count(*) FROM operaciones)::int  AS operaciones,
                  (SELECT count(*) FROM prealertas)::int   AS prealertas,
                  (SELECT count(*) FROM despachos)::int    AS despachos,
                  (SELECT count(*) FROM pods)::int         AS pods,
                  (SELECT count(*) FROM facturas)::int     AS facturas,
                  (SELECT count(*) FROM transportistas)::int AS transportistas,
                  (SELECT count(*) FROM convenios)::int    AS convenios`,
        );
        const antes = counts.rows[0] as Record<string, number>;

        // The operations surface first, when asked for — see TABLAS_OPERACIONES for why TRUNCATE and
        // why this order. It also has to precede the file cleanup: while it stands, its rows pin
        // their evidence (operacion_evidencias.file_id is RESTRICT).
        if (incluirOperaciones) {
          await q(`TRUNCATE ${TABLAS_OPERACIONES.join(', ')} RESTART IDENTITY`);
        }

        // One delete drives the cascade. ON DELETE CASCADE FKs remove shipments,
        // pedimentos, pedimento_scans, manifest_staging_rows, and monthly_history rows
        // that carry a manifest_id — all in this statement.
        await q(`DELETE FROM manifests`);

        // Manifest-derived rows WITHOUT a cascade path, removed explicitly:
        // - monthly_history aggregates with a NULL manifest_id (legacy rows the FK missed)
        await q(`DELETE FROM monthly_history`);
        // - every files row nothing surviving still points at; see REFERENCIAS_FILES_DURABLES.
        const fijados = [
          ...REFERENCIAS_FILES_DURABLES,
          ...(incluirOperaciones ? [] : REFERENCIAS_FILES_OPERACIONES),
        ];
        const removedFiles = await q(
          `DELETE FROM files f
             WHERE NOT EXISTS (SELECT 1 FROM (${sqlArchivosFijados(fijados)}) fijados WHERE fijados.id = f.id)
           RETURNING storage_path`,
        );
        const storagePaths: string[] = removedFiles.rows.map(
          (r: { storage_path: string }) => r.storage_path,
        );

        return {
          deleted: {
            manifests: antes.manifests,
            pedimentos: antes.pedimentos,
            shipments: antes.shipments,
            files: removedFiles.rowCount ?? 0,
            // Honest zeroes when the surface was out of scope: nothing was deleted, and the
            // `superficies` block below is what says whether it was even considered.
            operaciones: incluirOperaciones ? antes.operaciones : 0,
            prealertas: incluirOperaciones ? antes.prealertas : 0,
            despachos: incluirOperaciones ? antes.despachos : 0,
            pods: incluirOperaciones ? antes.pods : 0,
            facturas: incluirOperaciones ? antes.facturas : 0,
          },
          superficies: {
            manifiestos: true,
            archivos: true,
            operaciones: incluirOperaciones,
            catalogosDurables: false,
          },
          conservado: {
            catalogosDurables: [...TABLAS_CATALOGOS_DURABLES],
            transportistas: antes.transportistas,
            convenios: antes.convenios,
          },
          storagePaths,
        };
      });

      const { storagePaths, ...resumen } = result;

      // Post-commit best-effort blob cleanup. Ordering constraint: this MUST run before
      // recordAudit — the files rows are already gone, so if the audit insert threw first
      // and the unlinks were skipped, every blob would be permanently orphaned. A
      // filesystem hiccup never fails the request; the DB reset already committed.
      await Promise.allSettled(
        result.storagePaths.map(async (p) => {
          try {
            await unlink(p);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
              console.warn(`[demo-reset] failed to unlink ${p}:`, err instanceof Error ? err.message : err);
            }
          }
        }),
      );

      // DEMO_RESET audit event through the hash-chain helper (keeps the chain valid). The audit row
      // carries the SAME object the caller was handed — including which surfaces were in scope, so
      // "who wiped the ledger, and did they mean to?" is answerable from the chain alone.
      await recordAudit({
        userId: req.user!.userId,
        action: 'DEMO_RESET',
        entity: 'system',
        after: resumen,
        ip: req.ip,
      });

      res.json(resumen);
    } catch (err) {
      next(err);
    }
  },
);
