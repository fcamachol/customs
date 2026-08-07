import { withTransaction } from '../db/tx';
import { query } from '../db/pool';
import { recordAudit } from './audit';
import { isAeroSnapshot, lookupFlight } from './flightProviders';
import { parseFlightNumber, type EstadoVuelo } from '../../../shared/operaciones/vuelo';
import { canAdvanceEtapa, type Etapa } from '../../../shared/operaciones/estados';
import {
  CODIGOS_VUELO,
  COTEJO_RULESET_VERSION,
  ETA_TOLERANCIA_HORAS_DEFAULT,
  cotejarVuelo,
  mergeDiscrepancias,
  type Discrepancia,
} from '../../../shared/operaciones/cotejo';

/**
 * Flight resolution and refresh (PRD-02 R8, R9, R12).
 *
 * This is what replaces a human opening the airline's website and typing three fields into Excel.
 * It also produces the first two cotejo rules that can actually fire (PA-04, PA-05), because it is
 * the first point where an INDEPENDENT source contradicts what the client declared.
 *
 * Etapa advancement is derived, never asserted: the flight state drives `en_vuelo` → `arribado`, and
 * `canAdvanceEtapa` guarantees it can only move forward. Arrival is the trigger for the tramitador's
 * ~2-hour window, so `arribo_vuelo_at` is recorded as the fact it is.
 */

export interface RefreshResult {
  operacionId: string;
  mawb: string;
  status: 'sin_vuelo_declarado' | 'no_identificado' | 'actualizado' | 'sin_cambio' | 'error_proveedor';
  estadoVuelo?: EstadoVuelo;
  etapaAvanzada?: Etapa | null;
  discrepancias?: number;
  errores?: Array<{ provider: string; message: string }>;
}

interface OperacionRow {
  id: string;
  mawb: string;
  numero_vuelo: string | null;
  origen_iata: string | null;
  destino_iata: string | null;
  etd_origen: string | null;
  eta_pais: string | null;
  etapa: Etapa;
  vuelo_id: string | null;
  discrepancias: Discrepancia[] | null;
}

/**
 * The operating date of the leg. Prefer the declared ETD (that is when the flight number is in
 * service); fall back to the ETA, then to today. A wrong date means AeroAPI picks the wrong daily
 * leg, so this is worth being deliberate about rather than defaulting to now().
 */
function fechaOperacionFor(op: OperacionRow): string {
  const basis = op.etd_origen ?? op.eta_pais;
  const d = basis ? new Date(basis) : new Date();
  return Number.isNaN(d.getTime()) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
}

/**
 * How far the declared ETA may diverge from the real itinerary before PA-05 fires. Configurable
 * because PRD-02 §16 records the 6-hour figure as an assumption taken to avoid blocking, not as a
 * number anyone in the meeting validated — Luis or Alfonso may well want it tighter.
 */
function etaToleranciaHoras(): number {
  const raw = Number(process.env.ETA_TOLERANCIA_HORAS);
  return Number.isFinite(raw) && raw > 0 ? raw : ETA_TOLERANCIA_HORAS_DEFAULT;
}

/** Flight findings replace only their own codes; the manifest family's findings survive untouched. */
function mergeFlight(existing: Discrepancia[] | null, flightFindings: Discrepancia[]): Discrepancia[] {
  return mergeDiscrepancias(existing, flightFindings, CODIGOS_VUELO);
}

export async function refreshVueloForOperacion(operacionId: string): Promise<RefreshResult> {
  const opRes = await query<OperacionRow>(
    `SELECT id, mawb, numero_vuelo, origen_iata, destino_iata, etd_origen, eta_pais,
            etapa, vuelo_id, discrepancias
       FROM operaciones WHERE id = $1`,
    [operacionId],
  );
  const op = opRes.rows[0];
  if (!op) throw new Error(`operación ${operacionId} no existe`);

  const parts = parseFlightNumber(op.numero_vuelo);
  if (!parts) {
    // Either nothing declared, or digits only ("160") which no feed can resolve. Record PA-10 so the
    // caso visibly reads as unverified rather than as verified-and-fine.
    const findings = cotejarVuelo(
      {
        numeroVuelo: op.numero_vuelo,
        origenIata: op.origen_iata,
        destinoIata: op.destino_iata,
        etaPais: op.eta_pais,
      },
      null,
    );
    await persistCotejo(op, findings);
    return { operacionId: op.id, mawb: op.mawb, status: 'sin_vuelo_declarado', discrepancias: findings.length };
  }

  const fechaOperacion = fechaOperacionFor(op);

  // Upsert the flight row first so concurrent operaciones on the same leg converge on one record and
  // a delay cascades to all of them at once.
  const vueloRes = await query<{ id: string; estado: EstadoVuelo }>(
    `INSERT INTO vuelos (numero_vuelo, callsign, fecha_operacion)
     VALUES ($1, $2, $3)
     ON CONFLICT (numero_vuelo, fecha_operacion) DO UPDATE
       SET callsign = COALESCE(EXCLUDED.callsign, vuelos.callsign)
     RETURNING id, estado`,
    [parts.iataFlight, parts.callsign, fechaOperacion],
  );
  const vuelo = vueloRes.rows[0];
  const previous = vuelo.estado;

  const { snapshot, errors } = await lookupFlight(
    { iataFlight: parts.iataFlight, callsign: parts.callsign, fechaOperacion },
    previous,
  );

  if (!snapshot) {
    await query(
      `UPDATE vuelos SET ultima_consulta_at = now(), updated_at = now() WHERE id = $1`,
      [vuelo.id],
    );
    // A provider outage is NOT evidence about the flight. Only claim PA-10 when every provider
    // answered and none could identify it.
    if (errors.length) {
      return { operacionId: op.id, mawb: op.mawb, status: 'error_proveedor', errores: errors };
    }
    const findings = cotejarVuelo(
      { numeroVuelo: op.numero_vuelo, origenIata: op.origen_iata, destinoIata: op.destino_iata, etaPais: op.eta_pais },
      null,
    );
    await persistCotejo(op, findings, vuelo.id);
    return { operacionId: op.id, mawb: op.mawb, status: 'no_identificado', discrepancias: findings.length };
  }

  const findings = cotejarVuelo(
    { numeroVuelo: op.numero_vuelo, origenIata: op.origen_iata, destinoIata: op.destino_iata, etaPais: op.eta_pais },
    {
      origenIata: snapshot.origenIata,
      destinoIata: snapshot.destinoIata,
      etaProgramado: snapshot.etaProgramado,
      etaEstimado: snapshot.etaEstimado,
      arriboReal: snapshot.arriboReal,
      estado: snapshot.estado,
      fuente: snapshot.fuente,
      tieneItinerario: snapshot.tieneItinerario,
    },
    { etaToleranciaHoras: etaToleranciaHoras() },
  );

  // Extra detail exists only when an itinerary provider answered.
  const d = isAeroSnapshot(snapshot) ? snapshot.detalle : null;
  const estadoCambio = snapshot.estado !== previous;
  const nuevaEtapa = etapaForEstado(snapshot.estado, op.etapa);

  const result = await withTransaction(async (q) => {
    await q(
      `UPDATE vuelos SET
         aerolinea         = COALESCE($2, aerolinea),
         origen_iata       = COALESCE($3, origen_iata),
         destino_iata      = COALESCE($4, destino_iata),
         etd_programado    = COALESCE($5, etd_programado),
         eta_programado    = COALESCE($6, eta_programado),
         etd_real          = COALESCE($7, etd_real),
         eta_estimado      = COALESCE($8, eta_estimado),
         arribo_real       = COALESCE($9, arribo_real),
         estado            = $10,
         fuente            = $11,
         ultima_lat        = COALESCE($12, ultima_lat),
         ultima_lon        = COALESCE($13, ultima_lon),
         ultima_altitud_ft = COALESCE($14, ultima_altitud_ft),
         payload_fuente    = $15,
         fa_flight_id      = COALESCE($16, fa_flight_id),
         aeronave_tipo     = COALESCE($17, aeronave_tipo),
         matricula         = COALESCE($18, matricula),
         progreso_pct      = COALESCE($19, progreso_pct),
         ruta_filed        = COALESCE($20, ruta_filed),
         distancia_km      = COALESCE($21, distancia_km),
         terminal_destino  = COALESCE($22, terminal_destino),
         puerta_destino    = COALESCE($23, puerta_destino),
         pista_salida      = COALESCE($24, pista_salida),
         pista_llegada     = COALESCE($25, pista_llegada),
         cancelado         = COALESCE($26, cancelado),
         desviado          = COALESCE($27, desviado),
         destino_real_iata = COALESCE($28, destino_real_iata),
         ultima_consulta_at = now(),
         updated_at        = now()
       WHERE id = $1`,
      [
        vuelo.id,
        snapshot.aerolinea,
        snapshot.origenIata,
        snapshot.destinoIata,
        snapshot.etdProgramado,
        snapshot.etaProgramado,
        snapshot.etdReal,
        snapshot.etaEstimado,
        snapshot.arriboReal,
        snapshot.estado,
        snapshot.fuente,
        snapshot.posicion?.lat ?? null,
        snapshot.posicion?.lon ?? null,
        snapshot.posicion?.altitudeFt ?? null,
        JSON.stringify(snapshot.raw ?? null),
        // Only AeroAPI supplies these; ADS-B leaves them null and COALESCE preserves whatever a
        // previous AeroAPI cycle already established.
        d?.faFlightId ?? null,
        d?.aeronaveTipo ?? null,
        d?.matricula ?? null,
        d?.progresoPct ?? null,
        d?.rutaFiled ?? null,
        d?.distanciaKm ?? null,
        d?.terminalDestino ?? null,
        d?.puertaDestino ?? null,
        d?.pistaSalida ?? null,
        d?.pistaLlegada ?? null,
        d ? d.cancelado : null,
        d ? d.desviado : null,
        d?.destinoRealIata ?? null,
      ],
    );

    await q(
      `UPDATE operaciones SET
         vuelo_id        = $2,
         discrepancias   = $3::jsonb,
         cotejo_version  = $4,
         etapa           = COALESCE($5, etapa),
         arribo_vuelo_at = CASE WHEN $6::timestamptz IS NOT NULL AND arribo_vuelo_at IS NULL
                                THEN $6::timestamptz ELSE arribo_vuelo_at END
       WHERE id = $1`,
      [
        op.id,
        vuelo.id,
        JSON.stringify(mergeFlight(op.discrepancias, findings)),
        COTEJO_RULESET_VERSION,
        nuevaEtapa,
        snapshot.estado === 'aterrizado' ? (snapshot.arriboReal ?? new Date().toISOString()) : null,
      ],
    );

    // Only write an event when something actually changed. A five-minute poll that appends an
    // identical event every cycle would bury the real signals in the timeline.
    const tipo =
      snapshot.estado === 'cancelado' && estadoCambio
        ? 'VUELO_CANCELADO'
        : snapshot.estado === 'demorado' && estadoCambio
          ? 'VUELO_DEMORADO'
          : snapshot.estado === 'aterrizado' && estadoCambio
            ? 'ARRIBO_VUELO'
            : estadoCambio || findings.length
              ? 'VUELO_ACTUALIZADO'
              : null;

    if (tipo) {
      await q(
        `INSERT INTO operacion_eventos
           (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
         VALUES ($1,$2,$3,'feed_vuelo',now(),$4)`,
        [
          op.id,
          op.mawb,
          tipo,
          JSON.stringify({
            numeroVuelo: parts.iataFlight,
            callsign: parts.callsign,
            estadoAnterior: previous,
            estado: snapshot.estado,
            fuente: snapshot.fuente,
            tieneItinerario: snapshot.tieneItinerario,
            posicion: snapshot.posicion,
            etaEstimado: snapshot.etaEstimado,
            arriboReal: snapshot.arriboReal,
            discrepancias: findings,
            cotejoVersion: COTEJO_RULESET_VERSION,
          }),
        ],
      );
    }
    return { tipo };
  });

  if (result.tipo) {
    await recordAudit({
      userId: null,
      action: result.tipo,
      entity: 'operacion',
      entityId: op.id,
      after: {
        mawb: op.mawb,
        numeroVuelo: parts.iataFlight,
        estado: snapshot.estado,
        fuente: snapshot.fuente,
        discrepancias: findings.map((d) => d.codigo),
      },
      ip: null,
    });
  }

  return {
    operacionId: op.id,
    mawb: op.mawb,
    status: result.tipo ? 'actualizado' : 'sin_cambio',
    estadoVuelo: snapshot.estado,
    etapaAvanzada: nuevaEtapa,
    discrepancias: findings.length,
    errores: errors.length ? errors : undefined,
  };
}

/** Map a flight state onto the physical etapa, respecting monotonicity. */
function etapaForEstado(estado: EstadoVuelo, current: Etapa): Etapa | null {
  const target: Etapa | null =
    estado === 'en_ruta' ? 'en_vuelo' : estado === 'aterrizado' ? 'arribado' : null;
  if (!target) return null;
  return canAdvanceEtapa(current, target) ? target : null;
}

async function persistCotejo(op: OperacionRow, findings: Discrepancia[], vueloId?: string): Promise<void> {
  await query(
    `UPDATE operaciones
        SET discrepancias  = $2::jsonb,
            cotejo_version = $3,
            vuelo_id       = COALESCE($4, vuelo_id)
      WHERE id = $1`,
    [op.id, JSON.stringify(mergeFlight(op.discrepancias, findings)), COTEJO_RULESET_VERSION, vueloId ?? null],
  );
}

/**
 * Which operaciones are worth polling: anything still physically in motion. Deliberately excludes
 * casos past `arribado`, because once the cargo is on the ground the flight feed has nothing further
 * to say and every extra query costs money on a metered provider.
 */
export async function refreshVuelosPendientes(limit = 100): Promise<RefreshResult[]> {
  const { rows } = await query<{ id: string }>(
    `SELECT o.id
       FROM operaciones o
       LEFT JOIN vuelos v ON v.id = o.vuelo_id
      WHERE o.etapa IN ('prealerta','en_vuelo')
        AND o.numero_vuelo IS NOT NULL
        AND (v.ultima_consulta_at IS NULL OR v.ultima_consulta_at < now() - interval '4 minutes')
      ORDER BY COALESCE(v.ultima_consulta_at, to_timestamp(0)) ASC
      LIMIT $1`,
    [limit],
  );

  const out: RefreshResult[] = [];
  for (const r of rows) {
    try {
      out.push(await refreshVueloForOperacion(r.id));
    } catch (err) {
      out.push({
        operacionId: r.id,
        mawb: '',
        status: 'error_proveedor',
        errores: [{ provider: 'vuelosService', message: err instanceof Error ? err.message : String(err) }],
      });
    }
  }
  return out;
}
