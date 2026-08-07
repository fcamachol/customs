import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Widen files.kind for the Sistema de Operaciones artifacts.
 *
 * `prealerta_email` is the raw RFC822 message archived on ingest, and `awb` the air waybill that
 * rides with it. The manifest attachment deliberately reuses the existing `manifest` kind — it is
 * the same artifact the UI upload path already stores, so a near-duplicate `manifiesto` kind would
 * only split the same concept across two values.
 *
 * The remaining kinds (`evidencia`, `pod`, `convenio`, `factura`) are declared now, with the rest of
 * PRD-02 in mind, so later phases don't each need their own constraint-widening migration.
 */
const OLD = "('manifest','pedimento_pdf','report','risk_analysis')";
const NEW =
  "('manifest','pedimento_pdf','report','risk_analysis'," +
  "'prealerta_email','awb','evidencia','pod','convenio','factura')";

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('files', 'files_kind_check');
  pgm.addConstraint('files', 'files_kind_check', `CHECK (kind IN ${NEW})`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  // Rows carrying a kind that only exists in NEW would violate the narrowed constraint. Drop them
  // (and their blobs are orphaned on disk, same as any other files delete) so the rollback applies.
  pgm.sql(`DELETE FROM files WHERE kind NOT IN ${OLD}`);
  pgm.dropConstraint('files', 'files_kind_check');
  pgm.addConstraint('files', 'files_kind_check', `CHECK (kind IN ${OLD})`);
}
