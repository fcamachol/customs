import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * Richer flight detail, now that FlightAware AeroAPI is the primary source.
 *
 * Community ADS-B could only ever answer "airborne right now, within receiver range", so the original
 * `vuelos` shape had nowhere to put anything else. AeroAPI returns the whole picture — filed route,
 * aircraft and registration, runway times, gate and terminal, progress, cancellation and diversion
 * flags — and these are worth first-class columns rather than leaving them buried in
 * `payload_fuente`, because the contingency engine and the control tower query them.
 *
 * `fa_flight_id` is AeroAPI's own identifier for a specific flight leg. Keeping it lets us fetch the
 * position and track endpoints for that exact leg instead of guessing which daily instance we meant,
 * and it is the handle for replaying a historical lookup later.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('vuelos', {
    fa_flight_id: { type: 'text' },
    aeronave_tipo: { type: 'text' },
    matricula: { type: 'text' },
    // 0–100 while airborne. The single most useful number for a control tower: it answers "how much
    // longer" without a human comparing two timestamps.
    progreso_pct: { type: 'integer' },
    ruta_filed: { type: 'text' },
    distancia_km: { type: 'integer' },
    terminal_destino: { type: 'text' },
    puerta_destino: { type: 'text' },
    pista_salida: { type: 'text' },
    pista_llegada: { type: 'text' },
    cancelado: { type: 'boolean', notNull: true, default: false },
    desviado: { type: 'boolean', notNull: true, default: false },
    // Set when the feed reports a destination other than the one filed — the cargo is not where the
    // plan assumed, which is a replanning trigger, not a footnote.
    destino_real_iata: { type: 'text' },
  });

  pgm.createIndex('vuelos', 'fa_flight_id');
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('vuelos', [
    'fa_flight_id',
    'aeronave_tipo',
    'matricula',
    'progreso_pct',
    'ruta_filed',
    'distancia_km',
    'terminal_destino',
    'puerta_destino',
    'pista_salida',
    'pista_llegada',
    'cancelado',
    'desviado',
    'destino_real_iata',
  ]);
}
