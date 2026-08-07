import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `prealertas` — the versioned inbound notice, and `prealerta_adjuntos` — its archived attachments.
 *
 * Why versioned rather than one row per email (PRD-02 R6 / decision D2): when a flight is cancelled
 * the client's robot re-sends the SAME guía máster with a different flight. That is an UPDATE to an
 * existing caso, never a new caso. Each resend lands as version n+1 on the same operación, and the
 * earlier versions stay readable — which is what lets us show an auditor how the plan moved and why.
 *
 * Three independent idempotency keys, because the same message can reach us more than once by more
 * than one route:
 *   - `agora_event_id`  UNIQUE — AGORA's X-Agora-Event-Id, guards webhook redelivery
 *   - `message_id`      UNIQUE — the RFC822 Message-ID, guards the same mail arriving via the
 *                       reconciliation sweep after a webhook was already processed
 *   - (operacion_id, version) UNIQUE — guards a concurrent double-version
 *
 * `raw_file_id` points at the archived `.eml` in `files`. This is the whole reason the ingest copies
 * evidence instead of pointing at AGORA: AGORA incinerates raw inbound email after 30 days (Rails
 * ActionMailbox default) and stores no raw copy at all on the IMAP path, whereas the fiscal
 * retention we need is years (PRD-02 Adenda A, rule R-A).
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('prealertas', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    operacion_id: { type: 'uuid', notNull: true, references: 'operaciones', onDelete: 'CASCADE' },
    version: { type: 'integer', notNull: true },
    agora_event_id: { type: 'text' },
    agora_message_id: { type: 'text' },
    agora_conversation_id: { type: 'text' },
    message_id: { type: 'text' },
    recibido_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    remitente: { type: 'text' },
    asunto: { type: 'text' },
    headers: { type: 'jsonb' },
    cuerpo_texto: { type: 'text' },
    parsed: { type: 'jsonb' },
    parser_version: { type: 'text' },
    raw_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    estado: {
      type: 'text',
      notNull: true,
      default: 'recibida',
      check: "estado IN ('recibida','parseada','cotejada','rechazada')",
    },
    motivo_rechazo: { type: 'text' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('prealertas', 'prealertas_operacion_version_uq', {
    unique: ['operacion_id', 'version'],
  });
  // Partial unique indexes: NULL is legitimate (a prealerta recovered by the reconciliation sweep
  // has no AGORA event id), and a plain UNIQUE would let unlimited NULL rows through while still
  // costing an index — the partial form states the intent precisely.
  pgm.createIndex('prealertas', 'agora_event_id', {
    unique: true,
    name: 'prealertas_agora_event_id_uq',
    where: 'agora_event_id IS NOT NULL',
  });
  pgm.createIndex('prealertas', 'message_id', {
    unique: true,
    name: 'prealertas_message_id_uq',
    where: 'message_id IS NOT NULL',
  });
  pgm.createIndex('prealertas', 'operacion_id');

  pgm.createTable('prealerta_adjuntos', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    prealerta_id: { type: 'uuid', notNull: true, references: 'prealertas', onDelete: 'CASCADE' },
    file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    tipo: { type: 'text', notNull: true, check: "tipo IN ('awb','manifiesto','otro')" },
    original_name: { type: 'text' },
    content_hash: { type: 'text' },
    scan_verdict: { type: 'text' },
    scan_result: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.createIndex('prealerta_adjuntos', 'prealerta_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('prealerta_adjuntos');
  pgm.dropTable('prealertas');
}
