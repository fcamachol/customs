import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `vuelos` — the flight the cargo is on, as reported by an external feed rather than by the client.
 *
 * WHY THIS TABLE IS SEPARATE FROM `operaciones`. The prealerta already carries a declared flight
 * number, ETD and ETA, and those stay on `operaciones` as what the client SAID. This table holds what
 * an independent source says, so the two can be compared — that comparison is `PA-04` (does the
 * flight actually fly this route) and `PA-05` (does the real itinerary match the declared ETA). Fold
 * them into one row and the cotejo has nothing to cotejar against.
 *
 * One row per (numero_vuelo, fecha_operacion): the same flight number recurs daily, and several
 * operaciones on the same aircraft must share one flight record so a single delay cascades to all of
 * them at once.
 *
 * `fuente` and `payload_fuente` record which provider answered and its raw response. Deliberate:
 * when the system later reschedules cargo because a flight moved, an auditor is entitled to see the
 * evidence that it moved, not just our conclusion.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('vuelos', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    numero_vuelo: { type: 'text', notNull: true },
    // ICAO callsign (CAL5218) as transmitted over ADS-B, vs the IATA flight number (CI5218) the
    // client declares. They are different alphabets for the same flight and both are needed.
    callsign: { type: 'text' },
    aerolinea: { type: 'text' },
    origen_iata: { type: 'text' },
    destino_iata: { type: 'text' },
    fecha_operacion: { type: 'date', notNull: true },
    etd_programado: { type: 'timestamptz' },
    eta_programado: { type: 'timestamptz' },
    etd_real: { type: 'timestamptz' },
    eta_estimado: { type: 'timestamptz' },
    arribo_real: { type: 'timestamptz' },
    estado: {
      type: 'text',
      notNull: true,
      default: 'desconocido',
      check:
        "estado IN ('programado','en_ruta','aterrizado','demorado','cancelado','desviado','desconocido')",
    },
    fuente: { type: 'text' },
    // Last known position, so the control tower can show movement without a second round trip.
    ultima_lat: { type: 'numeric' },
    ultima_lon: { type: 'numeric' },
    ultima_altitud_ft: { type: 'integer' },
    ultima_consulta_at: { type: 'timestamptz' },
    payload_fuente: { type: 'jsonb' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
    updated_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('vuelos', 'vuelos_numero_fecha_uq', {
    unique: ['numero_vuelo', 'fecha_operacion'],
  });
  pgm.createIndex('vuelos', 'estado');
  pgm.createIndex('vuelos', 'ultima_consulta_at');

  pgm.addColumns('operaciones', {
    vuelo_id: { type: 'uuid', references: 'vuelos', onDelete: 'SET NULL' },
  });
  pgm.createIndex('operaciones', 'vuelo_id');

  // Cursor row for the flight-refresh tick. Seeded so a scheduler that never fires shows up as a
  // stale last_run_at rather than as a missing row nobody notices.
  pgm.sql(`
    INSERT INTO integracion_cursores (fuente) VALUES ('vuelos')
    ON CONFLICT (fuente) DO NOTHING
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('operaciones', ['vuelo_id']);
  pgm.dropTable('vuelos');
}
