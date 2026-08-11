import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import * as XLSX from 'xlsx';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { materializarRiesgoEfectivo } from '../../src/services/riesgoEfectivo';
import { buildRiskScreenRows, buildRiskXlsxRows, loadShipments } from '../../src/services/reportData';
import { hallazgoHash } from '../../../shared/risk/efectivo';
import type { ReasonCode, SignalId } from '../../../shared/risk/signals';

/**
 * El riesgo efectivo (diseño 2026-08-10, orden de trabajo 2).
 *
 * Dos trabajos, en este orden. Primero el CRITERIO DE SALIDA de la fase: sin ninguna disposición en
 * la base, las cuatro superficies que leen color devuelven exactamente lo mismo que antes del cambio.
 * El bloque `PARIDAD` de más abajo se capturó ejecutando este mismo montaje contra el código ANTERIOR
 * a la fase; si algo de lo que se añadió aquí filtrara a una lectura, este test lo dice. Después, lo
 * que la materialización hace cuando sí hay una disposición — incluida la invariante que sostiene
 * todo el diseño: el motor no se toca nunca.
 */

const app = createApp();
let token: string;
let userId: string;
let manifestId: string;

const MAWB = '369-P1';
const RFC = 'PERJ800101AA8';

interface Semilla {
  guia: string;
  nombre: string;
  rfc?: string;
  descripcion: string;
  cantidad: number;
  valor: number | null;
  direccion: string;
}

/**
 * Cuatro líneas elegidas para que el motor produzca los cuatro colores con la config por defecto:
 * verde, amarillo (monto bajo 20 pts + cantidad 15 pts = 35/348 ≈ 10), rojo forzado (`prohibidos`)
 * y gris (sin descripción, sin valor y sin RFC → datos insuficientes).
 */
const SEMILLAS: Semilla[] = [
  { guia: 'P-VERDE', nombre: 'Ana Verde', rfc: RFC, descripcion: 'camisa', cantidad: 1, valor: 100, direccion: 'Calle 1' },
  { guia: 'P-AMARILLO', nombre: 'Beto Amarillo', rfc: RFC, descripcion: 'camisa', cantidad: 30, valor: 0.5, direccion: 'Calle 2' },
  { guia: 'P-ROJO', nombre: 'Carla Roja', rfc: RFC, descripcion: 'pistola de juguete', cantidad: 1, valor: 50, direccion: 'Calle 3' },
  { guia: 'P-GRIS', nombre: 'Dora Gris', descripcion: '', cantidad: 1, valor: null, direccion: 'Calle 4' },
];

async function insertarLinea(s: Semilla): Promise<void> {
  await query(
    'INSERT INTO shipments (id, manifest_id, idempotency_key, data) VALUES (gen_random_uuid(),$1,$2,$3)',
    [
      manifestId,
      `${MAWB}|${s.guia}`,
      JSON.stringify({
        id: crypto.randomUUID(),
        mawbReference: MAWB,
        description: s.descripcion,
        hsCode: '6109100022',
        quantity: s.cantidad,
        unit: 'PCE',
        customsValueUsd: s.valor,
        currency: 'USD',
        originCountry: 'CN',
        guideId: s.guia,
        consignee: { name: s.nombre, rfc: s.rfc, address: s.direccion },
        sender: { name: 'Remitente', address: 'Shenzhen' },
        platform: { commercialName: 'Plataforma', countryOfOrigin: 'CN' },
      }),
    ],
  );
}

/** Corre el motor por su ruta real: el mismo camino que usa un humano al pulsar "Analizar". */
async function correrRiesgo(): Promise<void> {
  const res = await request(app)
    .post(`/api/manifests/${manifestId}/risk`)
    .set('Authorization', `Bearer ${token}`)
    .send({ period: '2026-03' });
  expect(res.status).toBe(200);
}

async function sembrar(): Promise<void> {
  for (const s of SEMILLAS) await insertarLinea(s);
  await correrRiesgo();
}

interface FilaOro {
  id: string;
  idempotency_key: string;
  risk_color: string | null;
  risk_score: number | null;
  risk_reasons: ReasonCode[] | null;
  risk_incidences: string[] | null;
  ruleset_hash: string | null;
  risk_insufficient_data: boolean | null;
  risk_color_efectivo: string | null;
  risk_score_efectivo: number | null;
  risk_disposiciones: Record<string, unknown> | null;
}

async function fila(guia: string): Promise<FilaOro> {
  const { rows } = await query<FilaOro>(
    `SELECT id, idempotency_key, risk_color, risk_score, risk_reasons, risk_incidences, ruleset_hash,
            risk_insufficient_data, risk_color_efectivo, risk_score_efectivo, risk_disposiciones
       FROM shipments WHERE manifest_id=$1 AND data->>'guideId'=$2`,
    [manifestId, guia],
  );
  expect(rows).toHaveLength(1);
  return rows[0];
}

/** Las cinco columnas del motor, tal cual, para compararlas byte a byte antes y después. */
function columnasDelMotor(f: FilaOro) {
  return {
    risk_score: f.risk_score,
    risk_color: f.risk_color,
    risk_incidences: f.risk_incidences,
    risk_reasons: f.risk_reasons,
    ruleset_hash: f.ruleset_hash,
  };
}

/**
 * Escribe una disposición como la escribirá la fase 3: la huella la calcula el SERVIDOR desde la
 * razón almacenada, nunca la trae el cliente. Un cliente que elige la huella dispone hallazgos que
 * no existen.
 */
async function disponer(
  guia: string,
  signalId: SignalId,
  estado: 'falso_positivo' | 'confirmado' = 'falso_positivo',
  over: { rulesetHash?: string } = {},
): Promise<string> {
  const f = await fila(guia);
  const razon = (f.risk_reasons ?? []).find((r) => r.signalId === signalId);
  expect(razon, `la señal ${signalId} debe disparar hoy en ${guia}`).toBeDefined();
  const { rows } = await query<{ id: string }>(
    `INSERT INTO riesgo_disposiciones
       (manifest_id, shipment_id, idempotency_key, manifiesto_version, signal_id, hallazgo_hash,
        hallazgo, ruleset_hash, estado, motivo, created_by)
     VALUES ($1,$2,$3,1,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [
      manifestId, f.id, f.idempotency_key, signalId, hallazgoHash(razon!),
      JSON.stringify(razon), over.rulesetHash ?? f.ruleset_hash, estado,
      'revisado con el cliente', userId,
    ],
  );
  return rows[0].id;
}

/**
 * Las CUATRO superficies del criterio de salida, reducidas a lo único que un cambio de color movería:
 * lo que cada una publica. Se leen por su ruta real (o por su función real, en `reportData`), no por
 * una consulta paralela escrita en el test — una consulta paralela probaría el test, no el código.
 */
async function superficies() {
  const dash = await request(app).get('/api/dashboard').set('Authorization', `Bearer ${token}`);
  expect(dash.status).toBe(200);

  const records: Record<string, string[]> = {};
  for (const color of ['verde', 'amarillo', 'rojo', 'gris']) {
    const r = await request(app).get(`/api/records?result=${color}`).set('Authorization', `Bearer ${token}`);
    expect(r.status).toBe(200);
    records[color] = (r.body as Array<{ mawbReference: string }>).map((x) => x.mawbReference).sort();
  }

  const cons = await request(app)
    .get('/api/consolidated.xlsx?period=2026-03')
    .set('Authorization', `Bearer ${token}`)
    .buffer(true)
    .parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    });
  expect(cons.status).toBe(200);
  const wb = XLSX.read(cons.body as Buffer, { type: 'buffer' });
  const consolidado = (XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]) as Record<string, unknown>[])
    .map((r) => ({ Guia: r.Guia, Resultado: r.Resultado ?? '', Valida: r.Valida }))
    .sort((a, b) => String(a.Guia).localeCompare(String(b.Guia)));

  const loaded = await loadShipments(manifestId);
  const pantalla = buildRiskScreenRows(loaded)
    .map((r) => ({ guide: r.guide, resultado: r.resultado, motivo: r.motivo }))
    .sort((a, b) => a.guide.localeCompare(b.guide));
  const libro = buildRiskXlsxRows(loaded)
    .map((r) => ({ Guia: r.Guia, Resultado: r.Resultado, Motivo: r.Motivo }))
    .sort((a, b) => a.Guia.localeCompare(b.Guia));

  return {
    dashboard: { manifests: dash.body.manifests, distribution: dash.body.distribution },
    records,
    consolidado,
    pantalla,
    libro,
  };
}

/**
 * CAPTURADO CONTRA EL CÓDIGO ANTERIOR A ESTA FASE, ejecutando el mismo montaje de arriba antes de
 * tocar una sola de las cuatro superficies. No es una expectativa escrita a mano sobre lo que
 * *debería* pasar: es lo que el sistema respondía, congelado. Ése es todo el valor que tiene.
 */
const PARIDAD = {
  dashboard: { manifests: 1, distribution: { verde: 1, amarillo: 1, rojo: 1, gris: 1 } },
  records: { verde: [MAWB], amarillo: [MAWB], rojo: [MAWB], gris: [] },
  consolidado: [
    { Guia: 'P-AMARILLO', Resultado: 'amarillo', Valida: false },
    { Guia: 'P-GRIS', Resultado: 'gris', Valida: false },
    { Guia: 'P-ROJO', Resultado: 'rojo', Valida: false },
    { Guia: 'P-VERDE', Resultado: 'verde', Valida: true },
  ],
  pantalla: [
    { guide: 'P-AMARILLO', resultado: 'amarillo', motivo: 'Demasiados productos; Valor declarado incorrecto (muy bajo)' },
    { guide: 'P-GRIS', resultado: 'gris', motivo: 'Falta RFC/CURP; Valor declarado incorrecto (muy bajo)' },
    { guide: 'P-ROJO', resultado: 'rojo', motivo: 'Artículos prohibidos (pistola)' },
    { guide: 'P-VERDE', resultado: 'verde', motivo: '' },
  ],
  libro: [
    { Guia: 'P-AMARILLO', Resultado: 'amarillo', Motivo: 'Demasiados productos; Valor declarado incorrecto (muy bajo)' },
    { Guia: 'P-GRIS', Resultado: 'gris', Motivo: 'Falta RFC/CURP; Valor declarado incorrecto (muy bajo)' },
    { Guia: 'P-ROJO', Resultado: 'rojo', Motivo: 'Artículos prohibidos (pistola)' },
    { Guia: 'P-VERDE', Resultado: 'verde', Motivo: '' },
  ],
};

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(
    `INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'admin') RETURNING id`,
    [hash],
  );
  userId = u.rows[0].id;
  token = signToken({ userId, role: 'admin', tv: 0 });
  const m = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by, created_at, ingestion_status)
     VALUES ($1,'Cliente P',$2,'2026-03-15T12:00:00Z','promoted') RETURNING id`,
    [MAWB, userId],
  );
  manifestId = m.rows[0].id;
});

describe('paridad: sin disposiciones, nada cambió', () => {
  it('las cuatro superficies devuelven exactamente lo de antes de esta fase', async () => {
    await sembrar();
    expect(await superficies()).toEqual(PARIDAD);
  });

  it('y las tres columnas efectivas quedan en NULL, que es lo que significa "manda el motor"', async () => {
    await sembrar();
    const { rows } = await query<{ n: string }>(
      `SELECT count(*)::int AS n FROM shipments
        WHERE manifest_id=$1
          AND (risk_color_efectivo IS NOT NULL OR risk_score_efectivo IS NOT NULL
               OR risk_disposiciones IS NOT NULL)`,
      [manifestId],
    );
    expect(Number(rows[0].n)).toBe(0);
  });
});

describe('risk_insufficient_data', () => {
  it('se persiste: es lo único que impide que suprimir una bandera convierta gris en verde', async () => {
    await sembrar();
    expect((await fila('P-GRIS')).risk_insufficient_data).toBe(true);
    expect((await fila('P-VERDE')).risk_insufficient_data).toBe(false);
  });
});

describe('limpieza del color anterior tras una corrección', () => {
  it('se borra el acarreo que resultó no ser un cambio, y sólo ése', async () => {
    // `aplicarVersion` copia el color viejo a `risk_*_anterior` ANTES de saber cuál será el nuevo:
    // es la única ventana en que el viejo existe. Aquí ya se sabe, y anular los que coinciden deja
    // la regla que la UI necesita — si `risk_color_anterior` no es NULL, hubo cambio de verdad.
    await sembrar();
    const marcar = (guia: string, color: string) => query(
      `UPDATE shipments SET risk_color_anterior=$2, risk_score_anterior=7, risk_version_anterior=1
        WHERE manifest_id=$1 AND data->>'guideId'=$3`,
      [manifestId, color, guia],
    );
    await marcar('P-VERDE', 'verde');     // el motor vuelve a decir verde: no hubo cambio
    await marcar('P-ROJO', 'amarillo');   // el motor ahora dice rojo: sí lo hubo

    await correrRiesgo();

    const { rows } = await query<{ guia: string; anterior: string | null; score: number | null; version: number | null }>(
      `SELECT data->>'guideId' AS guia, risk_color_anterior AS anterior,
              risk_score_anterior AS score, risk_version_anterior AS version
         FROM shipments WHERE manifest_id=$1 ORDER BY 1`,
      [manifestId],
    );
    const porGuia = Object.fromEntries(rows.map((r) => [r.guia, r]));
    expect(porGuia['P-VERDE']).toMatchObject({ anterior: null, score: null, version: null });
    expect(porGuia['P-ROJO']).toMatchObject({ anterior: 'amarillo', score: 7, version: 1 });
  });
});

describe('materializarRiesgoEfectivo', () => {
  it('un falso positivo baja el color efectivo y NO toca una sola columna del motor', async () => {
    await sembrar();
    const antes = columnasDelMotor(await fila('P-ROJO'));

    await disponer('P-ROJO', 'prohibidos');
    const res = await materializarRiesgoEfectivo(query, { manifestId });
    expect(res).toEqual({ filas: 4, conDisposicion: 1 });

    const despues = await fila('P-ROJO');
    // La invariante de todo el diseño: el motor dijo rojo y sigue diciendo rojo, byte a byte.
    expect(columnasDelMotor(despues)).toEqual(antes);
    expect(despues.risk_color).toBe('rojo');
    expect(despues.risk_color_efectivo).toBe('verde');
    expect(despues.risk_score_efectivo).toBe(0);
    expect(despues.risk_disposiciones).toMatchObject({
      suprimidas: ['prohibidos'],
      revalidacionPendiente: false,
      caducadas: [],
    });
  });

  it('`confirmado` aplica y no suprime: el efectivo iguala al motor', async () => {
    await sembrar();
    await disponer('P-ROJO', 'prohibidos', 'confirmado');
    await materializarRiesgoEfectivo(query, { manifestId });

    const f = await fila('P-ROJO');
    expect(f.risk_color_efectivo).toBe('rojo');
    expect(f.risk_disposiciones).toMatchObject({ suprimidas: [] });
  });

  it('GRIS SE CONSERVA al suprimir un forzado-rojo sobre una fila sin datos', async () => {
    // La línea trae artículo prohibido Y le faltan valor y RFC. Quitar la bandera no puede devolver
    // "todo en orden": lo honesto es "no se pudo evaluar". Convertir falta de datos en aprobación es
    // el peor error que esta capa podría cometer, y por eso `risk_insufficient_data` se persiste.
    await insertarLinea({
      guia: 'P-ROJO-SIN-DATOS', nombre: 'Eva Incompleta', descripcion: 'pistola',
      cantidad: 1, valor: null, direccion: 'Calle 5',
    });
    await correrRiesgo();
    expect((await fila('P-ROJO-SIN-DATOS')).risk_color).toBe('rojo');

    await disponer('P-ROJO-SIN-DATOS', 'prohibidos');
    await materializarRiesgoEfectivo(query, { manifestId });
    expect((await fila('P-ROJO-SIN-DATOS')).risk_color_efectivo).toBe('gris');
  });

  it('CADUCA SOLA cuando el ruleset cambia y la señal es forzada — sin ninguna escritura', async () => {
    await sembrar();
    await disponer('P-ROJO', 'prohibidos', 'falso_positivo', { rulesetHash: 'un-ruleset-anterior' });
    await materializarRiesgoEfectivo(query, { manifestId });

    const f = await fila('P-ROJO');
    // Una afirmación hecha contra la lista de prohibidos ANTERIOR no puede seguir tapando un golpe
    // contra la nueva. Sin disposición vigente vuelve a mandar el motor, y eso se dice con NULL.
    expect(f.risk_color_efectivo).toBeNull();
    expect(f.risk_disposiciones).toBeNull();
  });

  it('LA FÓRMULA ES ABSOLUTA: re-materializar no acumula, y una retractación devuelve el color', async () => {
    await sembrar();
    await disponer('P-ROJO', 'prohibidos');
    await materializarRiesgoEfectivo(query, { manifestId });
    const unaVez = await fila('P-ROJO');
    await materializarRiesgoEfectivo(query, { manifestId });
    await materializarRiesgoEfectivo(query, { manifestId });
    expect(await fila('P-ROJO')).toEqual(unaVez);

    // Retractarse es INSERTAR (la tabla es append-only), y gana la última fila por clave.
    await disponer('P-ROJO', 'prohibidos', 'confirmado');
    await materializarRiesgoEfectivo(query, { manifestId });
    expect((await fila('P-ROJO')).risk_color_efectivo).toBe('rojo');
  });

  it('volver a correr el motor re-materializa: el efectivo nunca queda describiendo datos viejos', async () => {
    await sembrar();
    await disponer('P-ROJO', 'prohibidos');
    await correrRiesgo();
    expect((await fila('P-ROJO')).risk_color_efectivo).toBe('verde');
  });

  it('acepta una sola línea sin tocar las demás', async () => {
    await sembrar();
    await disponer('P-ROJO', 'prohibidos');
    const objetivo = await fila('P-ROJO');
    const res = await materializarRiesgoEfectivo(query, { shipmentId: objetivo.id });
    expect(res).toEqual({ filas: 1, conDisposicion: 1 });
    expect((await fila('P-AMARILLO')).risk_color_efectivo).toBeNull();
  });
});

describe('las cuatro superficies SÍ ven la disposición', () => {
  it('el color efectivo manda en dashboard, records, consolidado y pantalla', async () => {
    await sembrar();
    await disponer('P-ROJO', 'prohibidos');
    await materializarRiesgoEfectivo(query, { manifestId });

    const s = await superficies();
    expect(s.dashboard.distribution).toEqual({ verde: 2, amarillo: 1, rojo: 0, gris: 1 });
    expect(s.records.rojo).toEqual([]);
    expect(s.consolidado.find((r) => r.Guia === 'P-ROJO')).toEqual({
      Guia: 'P-ROJO', Resultado: 'verde', Valida: true,
    });
    expect(s.pantalla.find((r) => r.guide === 'P-ROJO')?.resultado).toBe('verde');
    // El MOTIVO sigue siendo el del motor: la palabra del motor no desaparece de ningún sitio.
    expect(s.pantalla.find((r) => r.guide === 'P-ROJO')?.motivo).toBe('Artículos prohibidos (pistola)');
  });
});

describe('la afirmación humana sobrevive a la corrección que borra su línea', () => {
  it('borrar el shipment pone `shipment_id` en NULL y deja la fila en pie', async () => {
    // El caso para el que se desnormalizó `idempotency_key`: `aplicarVersion` borra del oro las
    // líneas que una versión nueva retira. El trigger append-only permite ese SET NULL y sólo ése.
    await sembrar();
    const disposicionId = await disponer('P-ROJO', 'prohibidos');
    const objetivo = await fila('P-ROJO');
    await query('DELETE FROM shipments WHERE id=$1', [objetivo.id]);

    const { rows } = await query<{ shipment_id: string | null; idempotency_key: string; motivo: string }>(
      'SELECT shipment_id, idempotency_key, motivo FROM riesgo_disposiciones WHERE id=$1',
      [disposicionId],
    );
    expect(rows[0].shipment_id).toBeNull();
    expect(rows[0].idempotency_key).toBe(`${MAWB}|P-ROJO`);
    expect(rows[0].motivo).toBe('revisado con el cliente');
  });

  it('pero editar la afirmación sigue siendo imposible', async () => {
    await sembrar();
    const disposicionId = await disponer('P-ROJO', 'prohibidos');
    await expect(
      query('UPDATE riesgo_disposiciones SET motivo=$2 WHERE id=$1', [disposicionId, 'otra cosa']),
    ).rejects.toThrow(/append-only/);
  });
});
