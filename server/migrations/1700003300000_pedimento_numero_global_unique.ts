import type { MigrationBuilder } from 'node-pg-migrate';

// Poka-Yoke: a SAT pedimento number belongs to exactly one manifest — it cannot be reused across
// manifests. Mirrors normPedimentoNumero (shared/pedimento/subdivision.ts: strip non-digits) via
// regexp_replace, and excludes NULL/empty so unparseable PDFs (no numero) coexist freely.
export async function up(pgm: MigrationBuilder): Promise<void> {
  // Dedup pre-existing duplicates first (global, by normalized numero); keep the newest. The DELETE
  // is not reversible — down() only drops the index.
  pgm.sql(`
    DELETE FROM pedimentos WHERE id IN (
      SELECT id FROM (
        SELECT id, row_number() OVER (
          PARTITION BY regexp_replace(numero_pedimento, '\\D', '', 'g')
          ORDER BY created_at DESC, id DESC
        ) AS rn
        FROM pedimentos
        WHERE numero_pedimento IS NOT NULL
          AND regexp_replace(numero_pedimento, '\\D', '', 'g') <> ''
      ) t WHERE t.rn > 1
    )
  `);

  pgm.sql(`
    CREATE UNIQUE INDEX pedimentos_numero_global_uq
      ON pedimentos (regexp_replace(numero_pedimento, '\\D', '', 'g'))
      WHERE numero_pedimento IS NOT NULL
        AND regexp_replace(numero_pedimento, '\\D', '', 'g') <> ''
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropIndex('pedimentos', [], { name: 'pedimentos_numero_global_uq' });
}
