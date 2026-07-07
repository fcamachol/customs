import type { MigrationBuilder } from 'node-pg-migrate';

// Persist the parser's self-reported diagnostics alongside the pedimento so an operator can tell,
// from the row alone, why an extraction came back thin (empty text layer, unparseable PDF, stray or
// missing guías). Previously both fields were computed at upload and discarded after the response.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('pedimentos', {
    extraction_confidence: { type: 'real' },   // ExtractedPedimento.confidence (0..1)
    extraction_warnings: { type: 'jsonb' },     // route-level warnings array surfaced at upload
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('pedimentos', ['extraction_confidence', 'extraction_warnings']);
}
