import 'dotenv/config';
import { query } from '../src/db/pool';
import { refreshVueloForOperacion } from '../src/services/vuelosService';

/**
 * Simulador de caso operativo a partir de un manifiesto ya cargado.
 *
 * POR QUÉ EXISTE: Torre de Control y Prealertas se alimentan de `operaciones` (PRD-02), que sólo
 * nacen de un correo de prealerta entrando por AGORA. En un ambiente sin AGORA configurado esas
 * pantallas quedan vacías aunque el manifiesto esté cargado — y con ellas el panel de vuelo, que
 * es justo lo que hay que poder demostrar.
 *
 * QUÉ NO HACE: no finge evidencia. No inventa adjuntos ni hashes, y el vuelo NO se simula — se
 * consulta de verdad contra el feed configurado. Las cifras de la prealerta se derivan del
 * manifiesto real, así que el cotejo compara datos que existen. Cada evento que escribe en el
 * ledger lleva `simulado: true` en su payload —el CHECK de `origen` sólo admite el vocabulario
 * operativo real, así que la marca va en el payload, que es inmutable igual que el resto de la
 * fila— de modo que un auditor pueda distinguirlo siempre de un caso real: un sistema cuya tesis
 * es la trazabilidad no puede sembrar datos indistinguibles de los auténticos.
 *
 * Uso:
 *   npx tsx server/scripts/simularOperacion.ts <MAWB> [vuelo] [origenIata] [destinoIata] [YYYY-MM-DD]
 *   npx tsx server/scripts/simularOperacion.ts 695-44821907 5Y8174 ANC NLU 2026-09-14
 */
async function main(): Promise<void> {
  const [mawbArg, vuelo, origen, destino, fecha] = process.argv.slice(2);
  if (!mawbArg) {
    console.error('uso: simularOperacion.ts <MAWB> [vuelo] [origen] [destino] [YYYY-MM-DD]');
    process.exit(2);
  }
  const numeroVuelo = vuelo ?? '5Y8174';
  const origenIata = origen ?? 'ANC';
  const destinoIata = destino ?? 'NLU';
  const fechaOp = fecha ?? new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

  // 1) El manifiesto tiene que existir: el caso se construye sobre datos reales, no al revés.
  const man = await query<{ id: string; mawb_reference: string | null; total: string; piezas: string | null; peso: string | null }>(
    `SELECT m.id,
            m.mawb_reference,
            count(s.id)::text                                            AS total,
            sum((s.data->>'quantity')::numeric)::text                    AS piezas,
            sum(coalesce(s.data->>'weightKg', s.data->>'weight')::numeric)::text AS peso
       FROM manifests m
       LEFT JOIN shipments s ON s.manifest_id = m.id
      WHERE m.mawb_reference = $1
      GROUP BY m.id, m.mawb_reference`,
    [mawbArg],
  );
  if (!man.rows.length) {
    console.error(`[simulador] no hay manifiesto con MAWB ${mawbArg}. Cárgalo primero.`);
    process.exit(1);
  }
  const m = man.rows[0];
  const piezas = m.piezas ? Math.round(Number(m.piezas)) : null;
  const pesoKg = m.peso ? Number(Number(m.peso).toFixed(2)) : null;
  const cartones = Number(m.total);

  // 2) La operación. ETD/ETA se derivan de la fecha declarada para que el cotejo tenga contra qué
  //    comparar cuando el feed responda.
  const etd = `${fechaOp}T07:05:00Z`;
  const eta = `${fechaOp}T13:47:00Z`;
  const op = await query<{ id: string; mawb: string }>(
    `INSERT INTO operaciones (
       mawb, mawb_raw, manifest_id, origen_iata, destino_iata, numero_vuelo,
       etd_origen, eta_pais, cartones_prealerta, piezas_prealerta, peso_kg_prealerta
     ) VALUES ($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (mawb) DO UPDATE SET
       manifest_id  = EXCLUDED.manifest_id,
       numero_vuelo = EXCLUDED.numero_vuelo,
       origen_iata  = EXCLUDED.origen_iata,
       destino_iata = EXCLUDED.destino_iata,
       etd_origen   = EXCLUDED.etd_origen,
       eta_pais     = EXCLUDED.eta_pais
     RETURNING id, mawb`,
    [mawbArg, m.id, origenIata, destinoIata, numeroVuelo, etd, eta, cartones, piezas, pesoKg],
  );
  const operacion = op.rows[0];
  console.log(`[simulador] caso ${operacion.mawb} (${operacion.id})`);
  console.log(`[simulador]   manifiesto: ${cartones} guías · ${piezas ?? '?'} piezas · ${pesoKg ?? '?'} kg`);

  // 3) La prealerta. `parsed` refleja lo que un parser habría extraído del correo, con su
  //    procedencia marcada como simulada — nunca como declaración del cliente.
  const parsed = {
    fields: {
      mawb: mawbArg, mawbRaw: mawbArg, numeroVuelo, origenIata, destinoIata,
      etdOrigen: etd, etaPais: eta, cartones, piezas, pesoKg,
    },
    warnings: [],
    procedencia: 'simulador',
  };
  await query(
    `INSERT INTO prealertas (operacion_id, version, recibido_at, remitente, asunto, parsed, parser_version, estado)
     VALUES ($1, 1, now(), $2, $3, $4, 'simulador', 'parseada')
     ON CONFLICT DO NOTHING`,
    [
      operacion.id,
      'simulador@demo.local',
      `PREALERTA ${mawbArg} ${origenIata}-${destinoIata} ${numeroVuelo}`,
      JSON.stringify(parsed),
    ],
  );
  console.log('[simulador]   prealerta v1 registrada');

  // 4) El vuelo: esto NO se simula. Es una consulta real al feed, y su resultado es el que se
  //    guarda — incluida la posibilidad de que el proveedor no lo reconozca.
  const r = await refreshVueloForOperacion(operacion.id);
  console.log(`[simulador]   vuelo ${numeroVuelo}: ${r.status}${r.estadoVuelo ? ` (${r.estadoVuelo})` : ''}`);
  if (r.discrepancias) console.log(`[simulador]   cotejo: ${r.discrepancias} discrepancia(s)`);
  if (r.errores?.length) r.errores.forEach((e) => console.log(`[simulador]   ! ${e.provider}: ${e.message}`));

  // 5) Un par de eventos de cadena física, marcados como simulados en el propio ledger.
  const eventos: Array<[string, string]> = [
    ['CARGA_DISPONIBLE', 'la carga quedó disponible en almacén'],
    ['INGRESO_PATIO', 'la unidad ingresó al patio'],
  ];
  for (const [tipo, nota] of eventos) {
    await query(
      `INSERT INTO operacion_eventos (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
       VALUES ($1,$2,$3,'sistema',now(),$4)`,
      [operacion.id, operacion.mawb, tipo, JSON.stringify({ nota, simulado: true })],
    );
  }
  console.log(`[simulador]   ${eventos.length} eventos en la bitácora (payload.simulado = true)`);
  console.log('[simulador] listo — el caso ya aparece en Torre de Control y en Prealertas.');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[simulador] falló:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
