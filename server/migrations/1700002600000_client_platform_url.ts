import type { MigrationBuilder } from 'node-pg-migrate';

// The client's "Reporte general mapeado" layout carries a Plataforma URL (col 35), the e-commerce
// storefront. ANAM's Anexo 2 platform block does not require it, but the operator does — so we
// persist it alongside the other client_platforms fields. PlatformData.url already exists in the
// shipment type; this makes the catalog the source of truth the Reporte General overlays.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('client_platforms', {
    url: { type: 'text' },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('client_platforms', ['url']);
}
