import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumn('pedimentos', {
    sub_status: {
      type: 'text',
      notNull: true,
      default: 'pendiente',
      check: "sub_status IN ('pendiente','capturado','prevalidado','cargado','rechazado')",
    },
  });
  // Backfill from existing signals (no 'cargado'/'rechazado' — those are new operator states).
  pgm.sql(`
    UPDATE pedimentos SET sub_status = CASE
      WHEN prevalidation->>'status' = 'APPROVED' THEN 'prevalidado'
      WHEN import_data IS NOT NULL THEN 'capturado'
      ELSE 'pendiente' END
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumn('pedimentos', 'sub_status');
}
