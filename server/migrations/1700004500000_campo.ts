import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Field capture (PRD-02 §13, R11, R30–R35). Two things: the `tramitador` role and the table that
 * holds the photographic proof.
 *
 * WHY A ROLE OF ITS OWN. There is no electronic feed for cargo availability or for the semáforo
 * result — confirmed in the source meeting. The tramitador standing at the warehouse and at the
 * aduana is the ONLY source for those facts, so he needs write access to the ledger. He is also the
 * role with the most physical exposure (a phone on a loading dock, in a customs yard), which is why
 * PRD-02 §13 makes him the least privileged: only `POST /api/campo/*` and `GET /api/campo/tareas`.
 * No manifiestos, no risk, no pedimentos, no billing. `canSeeAll()` in src/auth/access.ts is an
 * allowlist of roles, so adding the role here grants nothing by itself.
 *
 * `operacion_evidencias` — R32 / decision D5. Alfonso's demand, verbatim: a photo for inicio and fin
 * de carga. Without it the platform would still be taking a human's word for the two facts that
 * decide whether a flete was justified, which is exactly the dependency this module exists to break.
 * `capturado_at` is the DEVICE clock (what the operator's phone said when the shutter fired) and is
 * deliberately separate from `registrado_at` (when the server received it): warehouse connectivity is
 * bad, uploads queue, and the two times routinely differ by minutes.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.dropConstraint('users', 'users_role_check');
  pgm.addConstraint('users', 'users_role_check', {
    check: "role IN ('capturista','admin','autoridad','super_admin','tramitador')",
  });

  pgm.createTable('operacion_evidencias', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    operacion_id: {
      type: 'uuid',
      notNull: true,
      references: 'operaciones',
      onDelete: 'CASCADE',
    },
    // The ledger event this photo backs (the INICIO_CARGA it proves, or the EVIDENCIA_CAPTURADA row
    // written alongside it). SET NULL rather than CASCADE for the same reason as
    // operacion_eventos.operacion_id: operacion_eventos is append-only by trigger, so a cascade would
    // either fail outright or, worse, become a way to erase evidence by deleting its event.
    evento_id: { type: 'bigint', references: 'operacion_eventos', onDelete: 'SET NULL' },
    // RESTRICT, not CASCADE and not SET NULL. Evidence must never become silently unlinkable: an
    // evidencia row whose file_id had been nulled would look like a photo was taken while the bytes
    // were gone, which is a worse lie than an error. Deleting the blob now requires deleting the
    // evidencia row first — a deliberate, auditable act. This FK is also what lets us keep the
    // sha256 in `files.content_hash` instead of copying it here: the hash cannot outlive its file.
    file_id: { type: 'uuid', notNull: true, references: 'files', onDelete: 'RESTRICT' },
    tipo: {
      type: 'text',
      notNull: true,
      check:
        "tipo IN ('disponible','inicio_carga','fin_carga','modulacion','entrega','retencion','patio','otro')",
    },
    // Device clock at the moment of capture (R32/D5). Trusted as a claim, not as a fact — which is
    // precisely why `registrado_at` sits next to it.
    capturado_at: { type: 'timestamptz', notNull: true },
    registrado_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    lat: { type: 'numeric' },
    lng: { type: 'numeric' },
    device_id: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('operacion_evidencias', 'operacion_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('operacion_evidencias');
  pgm.dropConstraint('users', 'users_role_check');
  pgm.addConstraint('users', 'users_role_check', {
    check: "role IN ('capturista','admin','autoridad','super_admin')",
  });
}
