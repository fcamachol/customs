import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `plan_publicaciones` — the living plan (PRD-02 §8.5, R14, R19, principle P4).
 *
 * WHAT IT REPLACES, LITERALLY. Today the day's programme is an Excel workbook emailed to the
 * warehouse, to the transportista and to the client. When anything changes, a second workbook is
 * emailed, and from that instant nobody in the chain can say which version they are working from —
 * the warehouse stages against one file while the transportista quotes another. The meeting's phrase
 * for the fix was "sustituye el Excel corrigiendo al Excel": the plan stays a document people
 * receive, but it is versioned, immutable once published, and every version after the first ships
 * with the DELTA instead of asking the reader to diff two spreadsheets by eye.
 *
 * WHY A SNAPSHOT AND NOT A VIEW. A published plan is a statement made to third parties at a moment
 * in time. If it were a query over `despachos`, then re-opening version 3 next month would render it
 * against today's rows and quietly show something nobody was ever sent. `snapshot` is the document
 * as published — flat, human-shaped, folios and plates and guías rather than uuids — and it is what
 * makes "what did we tell the warehouse on Tuesday?" answerable at all.
 *
 * `diff` IS STORED, NOT DERIVED, for the same reason. It is what went out in the notification body,
 * so it has to be reproducible byte-for-byte later; recomputing it from the live tables would be
 * re-answering the question. The generator is the pure `diffPlan` in shared/operaciones/plan.ts, so
 * the stored value can also be independently recomputed from the two stored snapshots and compared —
 * which is what makes it auditable rather than merely recorded.
 *
 * `(fecha_operacion, version)` UNIQUE is the concurrency guard that matters: two coordinators
 * publishing at the same instant must not both mint version 4, leaving two different "version 4"
 * documents in circulation. The route serializes on an advisory lock and this constraint is the
 * backstop.
 *
 * NOTE ON MUTABILITY. This table is deliberately NOT under an append-only trigger, unlike
 * `operacion_eventos`. The reason is that the trigger's real job is to make a per-shipment history
 * indelible, and that history already exists: every publication writes a PLAN_PUBLICADO event onto
 * each affected caso's timeline, inside the same transaction. This table is the convenience copy of
 * the document; the ledger is the record.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('plan_publicaciones', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    fecha_operacion: { type: 'date', notNull: true },
    // Starts at 1 for each date and never reuses a number: the version is how three organisations
    // agree on which document they are holding.
    version: { type: 'integer', notNull: true },
    // The document as published. See the file header for why it is stored rather than derived.
    snapshot: { type: 'jsonb', notNull: true },
    // Delta against version n-1. NULL only for version 1, where there is nothing to compare against —
    // distinct from an empty diff, which means "republished with no changes".
    diff: { type: 'jsonb' },
    /**
     * Why this version exists. Not notNull, because version 1 of a day needs no justification — it is
     * simply the plan — but every republication carries one, enforced at the route: a plan that
     * changed for no stated reason is the Excel problem with better storage.
     */
    motivo: { type: 'text' },
    publicado_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    publicado_por: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    /**
     * Who it went to, as recorded at publication time. A list rather than a join to a contacts table
     * on purpose: the defensible fact is who we said we notified on the day, not who is on today's
     * distribution list.
     */
    destinatarios: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('plan_publicaciones', 'plan_publicaciones_fecha_version_uq', {
    unique: ['fecha_operacion', 'version'],
  });
  pgm.addConstraint('plan_publicaciones', 'plan_publicaciones_version_positiva_check', {
    check: 'version >= 1',
  });
  // "Latest version for this date" — the read behind every publish and every plan screen.
  pgm.createIndex('plan_publicaciones', [
    { name: 'fecha_operacion', sort: 'DESC' },
    { name: 'version', sort: 'DESC' },
  ]);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('plan_publicaciones');
}
