import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Making the carrier catalog CORRECTABLE without making it falsifiable (PRD-02 R25 / D9).
 *
 * Three columns, and each of them exists because the catalog could until now only ever grow:
 *
 * `transportista_tarifas.activo` — A MISPRICED RATE HAD NO OFF SWITCH. The only remedy was to add a
 * second, cheaper row, and since the carrier-side resolver breaks ties by the LOWEST price
 * (`resolverTarifa` in routes/despachos.ts — deliberately, see the reasoning in
 * shared/operaciones/facturacion.ts: a cheaper truck is unambiguously better for us), a superseding
 * row that happened to be MORE expensive would never win and the wrong price would keep resolving.
 * Deleting the row was never an option either: `despachos.tarifa_id` points at it, and the question
 * "at what agreed price was this trip contracted?" has to stay answerable. So: deactivate, exactly
 * like `transportista_unidades.activo` and `client_direcciones.activo`. `true` by default, so every
 * existing rate keeps resolving; a deactivated one never resolves again, and every past despacho
 * still names the row it was priced against (and stores the amount besides).
 *
 * `transportista_convenios.notas` — the terms a convenio carries beyond its dates: what was
 * negotiated, who agreed it, which annex it came with. It has to exist before an edit endpoint can
 * be honest, because otherwise the only editable fields would be the vigencia — and a convenio whose
 * ONLY writable surface is its expiry date invites editing the expiry date of signed agreements,
 * which is precisely what must never happen.
 *
 * `transportista_convenios.renovado_de_convenio_id` — PROVENANCE FOR RENEWAL, and the structural
 * half of the rule that a signed convenio's terms are frozen. Once `estado_firma = 'firmado'`, the
 * row IS the document: silently moving its `vigencia_hasta` would make the system claim something
 * was signed that was not, the same argument that makes a POD non-reprintable after firma. Extending
 * a signed agreement therefore means a NEW convenio that carries the terms forward and points back
 * at its predecessor, leaving the original intact and readable. Self-referencing FK with
 * `ON DELETE SET NULL`: losing the chain is bad, losing the successor's own terms would be worse —
 * the same trade the `file_id` column already makes on this table.
 *
 * No new table, so `server/test/helpers/db.ts` needs no change.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('transportista_tarifas', {
    activo: { type: 'boolean', notNull: true, default: true },
  });
  // The rate lookup behind D7 now filters on `activo`, so it belongs in the index that serves it.
  pgm.createIndex('transportista_tarifas', ['convenio_id', 'activo']);

  pgm.addColumns('transportista_convenios', {
    notas: { type: 'text' },
    renovado_de_convenio_id: {
      type: 'uuid',
      references: 'transportista_convenios',
      onDelete: 'SET NULL',
    },
  });
  // "Was this agreement already renewed?" — asked every time a signed convenio is displayed.
  pgm.createIndex('transportista_convenios', 'renovado_de_convenio_id');
  /**
   * A convenio cannot be its own predecessor. Cheap to state, and it is the only cycle a single
   * statement can create; longer cycles would need a chain of renewals pointing backwards, which the
   * route layer cannot produce because a successor is always a freshly inserted row.
   */
  pgm.addConstraint('transportista_convenios', 'transportista_convenios_renovacion_check', {
    check: 'renovado_de_convenio_id IS NULL OR renovado_de_convenio_id <> id',
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('transportista_convenios', 'transportista_convenios_renovacion_check');
  pgm.dropColumns('transportista_convenios', ['notas', 'renovado_de_convenio_id']);
  pgm.dropColumns('transportista_tarifas', ['activo']);
}
