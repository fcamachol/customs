/**
 * `operaciones.hold_activo` — the ONE materialization of the freeze flag.
 *
 * WHY THIS MODULE EXISTS. The flag is denormalized onto `operaciones` because the control-tower board
 * filters on it on every poll (§8.5), and until now the SQL that recomputes it was copied verbatim
 * into five places — `routes/holds.ts` (twice), `routes/riesgoRequerimientos.ts`,
 * `services/requerimientosService.ts` and `services/replanService.ts` — each with a comment saying
 * "kept identical on purpose; if one changes, both must". Four of those comments cannot all be true
 * at once: a formula that must not drift is a formula that must not be written down five times. A
 * single divergent copy would leave cargo showing as free to plan while a hold is open on it, which
 * is precisely the *flete en falso* the freeze layer exists to prevent.
 *
 * THE FORMULA IS ABSOLUTE, NOT INCREMENTAL, and that is the load-bearing property. It never
 * increments a counter and never trusts the caller's intent — it asks the table what is true right
 * now: *"is there any active hold that is either global or mine?"*. So a hold opened while a CT-6
 * global freeze is already in force, a per-caso hold closed while the global one remains, and the
 * global one closed while a per-caso hold survives, all land on the correct value with no ordering
 * assumptions and no special branch.
 *
 * Both functions take the caller's query function (`withTransaction`'s `q`, or a bare `query`) rather
 * than reaching for the pool, because every call site runs inside the transaction that just wrote the
 * hold row: recomputing the flag outside that transaction would read a world where the hold does not
 * exist yet.
 */

/** The tx query function handed out by `withTransaction`, and the shape `db/pool`'s `query` fits. */
export type QueryFn = (text: string, params?: unknown[]) => Promise<any>;

/**
 * The predicate itself, as SQL, correlated to the `operaciones` row aliased `o`.
 *
 * Exported so a future reader (or a query that needs the same truth without writing the column) can
 * reuse the definition instead of retyping it. It is a constant string with no interpolation — there
 * is nothing here for a caller to inject into.
 */
export const SQL_HOLD_ACTIVO = `EXISTS (
              SELECT 1 FROM operacion_holds h
               WHERE h.activo
                 AND (h.operacion_id IS NULL OR h.operacion_id = o.id))`;

/**
 * Recompute the flag for ONE caso. Returns its new value.
 *
 * Returns `false` when the caso does not exist, which is the honest answer to "is this caso frozen?"
 * for a row that is not there — every call site already knows the id it just locked.
 */
export async function materializarHoldActivo(q: QueryFn, operacionId: string): Promise<boolean> {
  const { rows } = await q(
    `UPDATE operaciones o
        SET hold_activo = ${SQL_HOLD_ACTIVO}
      WHERE o.id = $1
      RETURNING o.hold_activo`,
    [operacionId],
  );
  return Boolean(rows[0]?.hold_activo);
}

/**
 * Recompute the flag for EVERY still-open caso — the global open/close path (CT-6).
 *
 * ONE statement, not a loop: the whole point of the audit button is that it is instantaneous and
 * atomic, and a per-row loop inside the transaction would hold locks proportional to the size of the
 * board. Reusing the same absolute formula is what makes the interesting edge case correct without a
 * special branch — closing the global hold does NOT clear `hold_activo` on a caso that still has an
 * operación-level hold of its own, because the EXISTS still finds that row.
 *
 * `etapasCerradas` is a SQL fragment rather than a parameter list because it is the caller's own
 * compile-time constant (`routes/holds.ts`'s `ETAPAS_CERRADAS`) and never carries user input.
 * Returns the affected casos so the caller can write one ledger event per timeline.
 */
export async function materializarHoldActivoAbiertas(
  q: QueryFn,
  etapasCerradas: string,
): Promise<Array<{ id: string; mawb: string; holdActivo: boolean }>> {
  const { rows } = await q(
    `UPDATE operaciones o
        SET hold_activo = ${SQL_HOLD_ACTIVO}
      WHERE o.etapa NOT IN ${etapasCerradas}
      RETURNING o.id, o.mawb, o.hold_activo AS "holdActivo"`,
  );
  return rows as Array<{ id: string; mawb: string; holdActivo: boolean }>;
}
