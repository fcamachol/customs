import 'dotenv/config';
import { parseFlightNumber } from '../../shared/operaciones/vuelo';
import { flightProviderChain, lookupFlight } from '../src/services/flightProviders';

/**
 * Diagnóstico aislado del feed de vuelos — sin base de datos, sin caso, sin producción.
 *
 * POR QUÉ EXISTE: cuando un caso muestra "sin verificar" o un estado que contradice lo que
 * se ve en FlightRadar24, hay tres causas posibles que desde la UI se ven IDÉNTICAS:
 *
 *   1. no hay FLIGHT_API_KEY      → aeroApi devuelve null SIN lanzar error y sale de la cadena
 *   2. el proveedor falló         → excepción (red, 401, límite de cuota)
 *   3. el vuelo no se identificó  → el proveedor respondió bien y no lo reconoció
 *
 * Sólo el caso 2 es "error de conexión". Este script los separa: imprime qué proveedores
 * entraron a la cadena, si alguno lanzó error, y qué devolvió el que contestó.
 *
 * Uso:
 *   npx tsx server/scripts/diagVuelo.ts CV5161 2026-08-31
 *   npx tsx server/scripts/diagVuelo.ts 5Y8174 2026-08-31
 *
 * El segundo argumento es la fecha de operación (YYYY-MM-DD); default: hoy.
 */
async function main(): Promise<void> {
  const raw = process.argv[2];
  const fecha = process.argv[3] ?? new Date().toISOString().slice(0, 10);
  const origen = process.argv[4] ?? null;
  const destino = process.argv[5] ?? null;
  if (!raw) {
    console.error('uso: npx tsx server/scripts/diagVuelo.ts <numeroVuelo> [YYYY-MM-DD]');
    process.exit(2);
  }

  console.log(`\n── entorno ──`);
  console.log(`FLIGHT_API_KEY      ${process.env.FLIGHT_API_KEY ? 'presente' : 'AUSENTE (aeroApi queda fuera de la cadena)'}`);
  console.log(`FLIGHT_API_PROVIDER ${process.env.FLIGHT_API_PROVIDER ?? '(sin fijar — cadena automática)'}`);
  console.log(`cadena              ${flightProviderChain().map((p) => p.name).join(' → ')}`);

  const parts = parseFlightNumber(raw);
  console.log(`\n── identidad del vuelo ──`);
  console.log(`declarado           ${raw}`);
  if (!parts) {
    console.log(`parseo              FALLÓ — sin forma aerolínea+número, ningún feed puede resolverlo`);
    process.exit(1);
  }
  console.log(`IATA                ${parts.iataFlight}   (lo que se le pregunta a AeroAPI)`);
  console.log(`ICAO/callsign       ${parts.callsign ?? 'SIN MAPEO — ADS-B no puede buscarlo'}   (lo que transmite el avión)`);
  console.log(`fecha de operación  ${fecha}`);
  if (origen || destino) console.log(`ruta declarada      ${origen ?? '?'} → ${destino ?? '?'}`);

  const t0 = Date.now();
  const { snapshot, errors } = await lookupFlight(
    { iataFlight: parts.iataFlight, callsign: parts.callsign, fechaOperacion: fecha, origenIata: origen, destinoIata: destino },
    'desconocido',
  );
  const ms = Date.now() - t0;

  console.log(`\n── resultado (${ms} ms) ──`);
  if (errors.length) {
    console.log(`ERROR DE PROVEEDOR — esto SÍ es un problema de conexión/credencial/cuota:`);
    for (const e of errors) console.log(`  · ${e.provider}: ${e.message}`);
  }
  if (!snapshot) {
    console.log(
      errors.length
        ? `sin snapshot, pero hubo errores arriba: NO se puede concluir nada sobre el vuelo.`
        : `NO IDENTIFICADO — todos los proveedores respondieron y ninguno reconoció el vuelo.\n` +
          `  Esto NO es un error de conexión: es el identificador (o el vuelo no existe ese día).`,
    );
    process.exit(errors.length ? 1 : 0);
  }

  console.log(`fuente              ${snapshot.fuente}`);
  console.log(`estado              ${snapshot.estado}`);
  console.log(`ruta                ${snapshot.origenIata ?? '?'} → ${snapshot.destinoIata ?? '?'}`);
  console.log(`ETD programado      ${snapshot.etdProgramado ?? '—'}`);
  console.log(`ETD real            ${snapshot.etdReal ?? '—'}`);
  console.log(`ETA estimado        ${snapshot.etaEstimado ?? '—'}`);
  console.log(`arribo real         ${snapshot.arriboReal ?? '—'}`);
  if (snapshot.posicion) {
    const p = snapshot.posicion;
    console.log(`posición            ${p.lat}, ${p.lon} @ ${p.altitudeFt ?? '?'} ft`);
  }

  // El crudo es la evidencia de que la conexión funcionó, pase lo que pase con la interpretación.
  if (process.env.DIAG_RAW === '1') {
    console.log(`\n── payload crudo ──\n${JSON.stringify(snapshot.raw, null, 2)}`);
  } else {
    console.log(`\n(DIAG_RAW=1 para ver el payload crudo del proveedor)`);
  }
}

main().catch((err) => {
  console.error('\nel diagnóstico falló:', err instanceof Error ? err.message : err);
  process.exit(1);
});
