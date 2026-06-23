import type { MigrationBuilder } from 'node-pg-migrate';

// D3: catalog of already-validated RFCs/CURPs for the CNNE (consignatario). The manifest carries
// only an ID; the T1 layout needs RFC + CURP. This table lets the report enrich the CNNE block by
// looking up the manifest ID in `id_ref`.
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('validated_rfcs', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    id_ref: { type: 'text', notNull: true, unique: true }, // manifest ID (RFC/CURP/ID del CNNE) used as the lookup key
    rfc: { type: 'text' },
    curp: { type: 'text' },
    name: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('validated_rfcs');
}
