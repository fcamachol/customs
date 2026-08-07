import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `integracion_cursores` — the "did we miss anything?" bookmark per external source.
 *
 * The AGORA webhook is the fast path; it is not a guarantee. `Webhooks::Trigger` is a single
 * RestClient POST with a ~5s timeout and only Sidekiq's default retries behind it, so an AGORA
 * restart or a customs deploy during a flight window can silently drop a prealerta — and a dropped
 * prealerta means cargo nobody planned for.
 *
 * So the webhook is the notification and this cursor is the safety net: a periodic sweep asks AGORA
 * for messages since `last_synced_at` and reprocesses anything whose Message-ID we have not seen.
 * AGORA itself already uses this pattern for the same reason (`supra_reconcile_pending_tramites_job`,
 * `cincel_poll_status_job`), so it is the house idiom rather than an invention.
 *
 * Single row per `fuente`; the primary key IS the source name because there is nothing else to say
 * about it.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('integracion_cursores', {
    fuente: { type: 'text', primaryKey: true },
    last_synced_at: { type: 'timestamptz' },
    last_event_id: { type: 'text' },
    last_run_at: { type: 'timestamptz' },
    last_error: { type: 'text' },
    consecutive_errors: { type: 'integer', notNull: true, default: 0 },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  // Seed the AGORA prealerta cursor so the first sweep has a row to advance rather than having to
  // special-case "no cursor yet". last_synced_at stays NULL: the first sweep decides its own window.
  pgm.sql(`
    INSERT INTO integracion_cursores (fuente) VALUES ('agora_prealertas')
    ON CONFLICT (fuente) DO NOTHING
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropTable('integracion_cursores');
}
