import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `operaciones` — the caso. One row per guía máster (MAWB).
 *
 * Created the instant a prealerta email lands, BEFORE the manifest is ingested or the client is
 * resolved (PRD-02 principle P1: "el correo no es un correo, es un caso"). That is why
 * `manifest_id` and `client_id` are nullable and ON DELETE SET NULL rather than required FKs.
 *
 * Three ORTHOGONAL state axes instead of one status column (PRD-02 §8.4). The Excel formula this
 * replaces mixed physical progress with documentary progress, which is exactly what makes
 * contingencies impossible to reason about:
 *   - etapa              → physical progress, monotonic, advanced only by observed facts
 *   - estado_documental  → mirrors the existing risk/pedimento modules
 *   - estado_planeacion  → planning/dispatch lifecycle
 * `hold_activo` is a materialized rollup of the (future) operacion_holds table, denormalized because
 * the control-tower board filters on it on every poll.
 *
 * `mawb` is stored normalized (shared/pedimento/guia.ts normGuia) so it can carry a UNIQUE
 * constraint and match `manifests.mawb_reference` across punctuation drift; `mawb_raw` keeps what
 * the client actually sent, which is what a human must reconcile.
 *
 * The `agora_*` columns are the correlation handles into the AGORA communication hub (PRD-02
 * Adenda A). They are references, never a second source of truth: AGORA holds transport history,
 * this table and operacion_eventos hold the record.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('operaciones', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    mawb: { type: 'text', notNull: true, unique: true },
    mawb_raw: { type: 'text' },
    manifest_id: { type: 'uuid', references: 'manifests', onDelete: 'SET NULL' },
    client_id: { type: 'uuid', references: 'clients', onDelete: 'SET NULL' },
    origen_iata: { type: 'text' },
    destino_iata: { type: 'text' },
    numero_vuelo: { type: 'text' },
    etd_origen: { type: 'timestamptz' },
    eta_pais: { type: 'timestamptz' },
    cartones_prealerta: { type: 'integer' },
    piezas_prealerta: { type: 'integer' },
    peso_kg_prealerta: { type: 'numeric' },
    etapa: {
      type: 'text',
      notNull: true,
      default: 'prealerta',
      check:
        "etapa IN ('prealerta','en_vuelo','arribado','disponible','en_carga'," +
        "'modulado','reconocimiento','en_transito','entregado','cerrada','cancelada')",
    },
    estado_documental: {
      type: 'text',
      notNull: true,
      default: 'sin_cotejar',
      check:
        "estado_documental IN ('sin_cotejar','cotejado','riesgo_con_hallazgos'," +
        "'riesgo_ok','riesgo_vencido','pedimento_generado','liberada')",
    },
    estado_planeacion: {
      type: 'text',
      notNull: true,
      default: 'sin_plan',
      check:
        "estado_planeacion IN ('sin_plan','planeada','asignada','replanificada','excluida','cumplida')",
    },
    // Stored in English on purpose: the client sees this value and clients are mostly Chinese
    // (PRD-02 decision D16).
    semaforo: { type: 'text', check: "semaforo IN ('green','red')" },
    arribo_vuelo_at: { type: 'timestamptz' },
    disponible_at: { type: 'timestamptz' },
    modulacion_at: { type: 'timestamptz' },
    salida_rojo_at: { type: 'timestamptz' },
    hold_activo: { type: 'boolean', notNull: true, default: false },
    discrepancias: { type: 'jsonb' },
    cotejo_version: { type: 'text' },
    agora_conversation_id: { type: 'text' },
    agora_contact_id: { type: 'text' },
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('operaciones', 'manifest_id');
  pgm.createIndex('operaciones', 'client_id');
  pgm.createIndex('operaciones', 'etapa');
  pgm.createIndex('operaciones', ['estado_planeacion', 'etapa']);
  pgm.createIndex('operaciones', 'agora_conversation_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('operaciones');
}
