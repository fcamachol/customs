import type { MigrationBuilder } from 'node-pg-migrate';

// Poka-Yoke: a manifest's MAWB (master air waybill) is globally unique — the same guía cannot be
// ingested twice. Air-cargo MAWB numbers are globally unique, and client_id is NULL at insert time
// (attached later via POST /:id/client), so mawb_reference is the only scope enforceable at insert.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Dedup any pre-existing duplicates first so the constraint can apply. Keep one canonical row per
  // MAWB (prefer promoted, then newest); CASCADE removes the redundant rows' children
  // (manifest_staging_rows, shipments, pedimentos, pedimento_scans). NOTE: the DELETE is not
  // reversible — down() only drops the constraint.
  pgm.sql(`
    DELETE FROM manifests WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (
          PARTITION BY mawb_reference
          ORDER BY (ingestion_status = 'promoted') DESC, created_at DESC, id DESC
        ) AS rn
        FROM manifests
      ) t WHERE t.rn > 1
    )
  `);

  pgm.addConstraint('manifests', 'manifests_mawb_reference_uq', {
    unique: ['mawb_reference'],
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('manifests', 'manifests_mawb_reference_uq');
}
