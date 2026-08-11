import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import {
  buildRiskScreenRows,
  buildRiskXlsxRows,
  loadDatoCambio,
  loadShipments,
  redactarReason,
  resumirRiesgo,
} from '../../src/services/reportData';
import { hallazgoHash } from '../../../shared/risk/efectivo';
import type { ReasonCode } from '../../../shared/risk/signals';

/**
 * EL BUNDLE DE RIESGO DE LA FASE 4 — lo que la pantalla ve y, sobre todo, lo que NO ve.
 *
 * `shipments.risk_reasons` no había salido nunca del servidor. Empieza a salir aquí porque la UI
 * necesita las razones para poder disponer sobre una de ellas, y con ellas viaja `evidence`, que es
 * el único sitio del motor donde hay datos de una persona. Estos tests fijan las dos mitades del
 * contrato: que los campos nuevos llegan, y que el nombre de un sancionado y el RFC en claro no.
 */

beforeEach(truncateAll);

const RFC = 'TOMM020922D40';
const NOMBRE_SANCIONADO = 'ZZ ENTIDAD SANCIONADA SA DE CV';

const RAZONES: ReasonCode[] = [
  { signalId: 'id', points: 30, weight: 30, detail: 'RFC/CURP inválido', evidence: { id: RFC } },
  {
    signalId: 'denied_party',
    points: 100,
    weight: 100,
    detail: 'Coincidencia en lista de sancionados (OFAC)',
    evidence: { matched: NOMBRE_SANCIONADO, source: 'OFAC', program: 'SDNTK' },
    forcesBand: 'rojo',
  },
  { signalId: 'pirateria', points: 100, weight: 100, detail: 'Piratería (nike)', evidence: { matched: 'nike' }, forcesBand: 'rojo' },
];

async function seed(campos: Record<string, unknown> = {}): Promise<{ manifestId: string; shipmentId: string }> {
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('disponente','x','admin') RETURNING id`);
  const m = await query(
    `INSERT INTO manifests (mawb_reference, client_name, created_by) VALUES ('369-9','ACME',$1) RETURNING id`,
    [u.rows[0].id]);
  const manifestId = m.rows[0].id as string;
  const s = {
    id: crypto.randomUUID(), mawbReference: '369-9', description: 'TRAJE', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 120, currency: 'USD', originCountry: 'CN', guideId: 'g1',
    consignee: { name: 'Juan', rfc: RFC, address: 'Calle 1' }, sender: { name: 'S' },
    platform: { commercialName: 'P', countryOfOrigin: 'CN' },
  };
  const columnas = {
    risk_color: 'rojo',
    risk_incidences: JSON.stringify(['valor atipico']),
    risk_reasons: JSON.stringify(RAZONES),
    ...campos,
  } as Record<string, unknown>;
  const nombres = ['id', 'manifest_id', 'idempotency_key', 'data', ...Object.keys(columnas)];
  const valores = [s.id, manifestId, 'k1', JSON.stringify(s), ...Object.values(columnas)];
  await query(
    `INSERT INTO shipments (${nombres.join(',')}) VALUES (${nombres.map((_, i) => `$${i + 1}`).join(',')})`,
    valores,
  );
  return { manifestId, shipmentId: s.id };
}

describe('redactarReason — la frontera del servidor', () => {
  it('omite el nombre coincidente de denied_party y conserva detail, source y la huella', () => {
    const pub = redactarReason(RAZONES[1]);
    expect(pub.evidence?.matched).toBeUndefined();
    expect(pub.evidence?.source).toBe('OFAC');
    expect(pub.evidence?.program).toBe('SDNTK');
    expect(pub.detail).toBe('Coincidencia en lista de sancionados (OFAC)');
    // La huella se calcula sobre la razón ÍNTEGRA: si se calculara sobre la redactada, no casaría
    // con la que el servidor escribe en `riesgo_disposiciones` y el arrastre se rompería en silencio.
    expect(pub.hallazgoHash).toBe(hallazgoHash(RAZONES[1]));
  });

  it('omite el RFC/CURP en claro de la señal `id` — la misma disciplina que el resto del bundle', () => {
    const pub = redactarReason(RAZONES[0]);
    expect(pub.evidence?.id).toBeUndefined();
    expect(pub.detail).toBe('RFC/CURP inválido');
  });

  it('conserva `matched` en pirateria: es una marca comercial, no una persona', () => {
    expect(redactarReason(RAZONES[2]).evidence?.matched).toBe('nike');
  });
});

describe('buildRiskScreenRows — los campos nuevos', () => {
  it('el pill lleva el EFECTIVO y el crudo del motor viaja aparte', async () => {
    const { manifestId, shipmentId } = await seed({ risk_color_efectivo: 'verde', risk_score_efectivo: 0 });
    const rows = buildRiskScreenRows(await loadShipments(manifestId));
    expect(rows[0].resultado).toBe('verde');
    expect(rows[0].resultadoMotor).toBe('rojo');
    expect(rows[0].shipmentId).toBe(shipmentId);
  });

  it('sin disposición, efectivo y motor coinciden (COALESCE = comportamiento de siempre)', async () => {
    const { manifestId } = await seed();
    const rows = buildRiskScreenRows(await loadShipments(manifestId));
    expect(rows[0].resultado).toBe('rojo');
    expect(rows[0].resultadoMotor).toBe('rojo');
    expect(rows[0].resultadoAnterior).toBeNull();
    expect(rows[0].disposiciones).toEqual([]);
    expect(rows[0].revalidacionPendiente).toBe(false);
  });

  it('expone las razones redactadas con su huella', async () => {
    const { manifestId } = await seed();
    const rows = buildRiskScreenRows(await loadShipments(manifestId));
    expect(rows[0].reasons.map((r) => r.signalId)).toEqual(['id', 'denied_party', 'pirateria']);
    expect(JSON.stringify(rows[0].reasons)).not.toContain(NOMBRE_SANCIONADO);
    expect(JSON.stringify(rows[0].reasons)).not.toContain(RFC);
    expect(rows[0].reasons.every((r) => r.hallazgoHash.length === 64)).toBe(true);
  });

  it('el tag de corrección sale de las columnas `_anterior`, sin comparar nada', async () => {
    const { manifestId } = await seed({ risk_color_anterior: 'amarillo', risk_version_anterior: 1 });
    const rows = buildRiskScreenRows(await loadShipments(manifestId));
    expect(rows[0].resultadoAnterior).toBe('amarillo');
    expect(rows[0].versionAnterior).toBe(1);
  });

  it('las disposiciones aplicadas llegan con el autor resuelto a nombre legible', async () => {
    const { manifestId } = await seed({
      risk_color_efectivo: 'verde',
      risk_disposiciones: JSON.stringify({
        aplicadas: [{
          id: '11111111-1111-1111-1111-111111111111',
          signalId: 'pirateria',
          hallazgoHash: hallazgoHash(RAZONES[2]),
          estado: 'falso_positivo',
          motivo: 'La marca aparece en la descripción del empaque, no del producto.',
          createdAt: '2026-08-10T12:00:00.000Z',
          createdBy: null,
          revalidacionPendiente: true,
        }],
        suprimidas: ['pirateria'],
        caducadas: [],
        revalidacionPendiente: true,
      }),
    });
    const rows = buildRiskScreenRows(await loadShipments(manifestId), { usuarios: {} });
    expect(rows[0].disposiciones).toHaveLength(1);
    expect(rows[0].disposiciones[0].estado).toBe('falso_positivo');
    expect(rows[0].disposiciones[0].revalidacionPendiente).toBe(true);
    expect(rows[0].revalidacionPendiente).toBe(true);
  });
});

describe('loadDatoCambio — «su dato no cambió; cambió el conjunto»', () => {
  async function stage(manifestId: string, version: number, rowHash: string | null) {
    await query(
      `INSERT INTO manifest_staging_rows (manifest_id, version, row_index, idempotency_key, status, data, row_hash)
       VALUES ($1,$2,$3,'k1','valid','{}'::jsonb,$4)`,
      [manifestId, version, version, rowHash],
    );
  }

  it('devuelve false cuando el row_hash de bronce es idéntico entre las dos versiones', async () => {
    const { manifestId } = await seed({ risk_version_anterior: 1 });
    await query('UPDATE manifests SET version_vigente=2 WHERE id=$1', [manifestId]);
    await stage(manifestId, 1, 'abc');
    await stage(manifestId, 2, 'abc');
    expect(await loadDatoCambio(manifestId)).toEqual({ k1: false });
  });

  it('devuelve true cuando el row_hash cambió', async () => {
    const { manifestId } = await seed({ risk_version_anterior: 1 });
    await query('UPDATE manifests SET version_vigente=2 WHERE id=$1', [manifestId]);
    await stage(manifestId, 1, 'abc');
    await stage(manifestId, 2, 'def');
    expect(await loadDatoCambio(manifestId)).toEqual({ k1: true });
  });

  it('un row_hash NULL (v1 retro-llenada) no se compara: la pantalla no afirma lo que no puede probar', async () => {
    const { manifestId } = await seed({ risk_version_anterior: 1 });
    await query('UPDATE manifests SET version_vigente=2 WHERE id=$1', [manifestId]);
    await stage(manifestId, 1, null);
    await stage(manifestId, 2, 'def');
    expect(await loadDatoCambio(manifestId)).toEqual({ k1: true });
  });
});

describe('buildRiskXlsxRows — el artefacto de cumplimiento', () => {
  it('`Resultado` sigue siendo la palabra del MOTOR y las disposiciones van en columnas al lado', async () => {
    const { manifestId } = await seed({
      risk_color_efectivo: 'verde',
      risk_color_anterior: 'amarillo',
      risk_version_anterior: 1,
      risk_disposiciones: JSON.stringify({
        aplicadas: [{
          id: '22222222-2222-2222-2222-222222222222',
          signalId: 'pirateria',
          hallazgoHash: hallazgoHash(RAZONES[2]),
          estado: 'mitigado',
          motivo: 'El cliente acreditó la licencia de marca.',
          createdAt: '2026-08-10T12:00:00.000Z',
          createdBy: null,
          revalidacionPendiente: false,
        }],
        suprimidas: ['pirateria'],
        caducadas: [],
        revalidacionPendiente: false,
      }),
    });
    const [fila] = buildRiskXlsxRows(await loadShipments(manifestId));
    // Un documento que cambia su veredicto porque alguien afirmó algo es un documento que miente.
    expect(fila.Resultado).toBe('rojo');
    expect(fila['Disposición']).toBe('pirateria: Mitigado');
    expect(fila['Motivo de disposición']).toBe('El cliente acreditó la licencia de marca.');
    expect(fila['Resultado anterior']).toBe('amarillo (v1)');
  });

  it('sin disposiciones ni corrección, las tres columnas nuevas quedan vacías', async () => {
    const { manifestId } = await seed();
    const [fila] = buildRiskXlsxRows(await loadShipments(manifestId));
    expect(fila.Resultado).toBe('rojo');
    expect(fila['Disposición']).toBe('');
    expect(fila['Motivo de disposición']).toBe('');
    expect(fila['Resultado anterior']).toBe('');
  });
});

describe('resumirRiesgo', () => {
  it('cuenta el crudo y el efectivo por separado sobre las MISMAS filas', async () => {
    const { manifestId } = await seed({ risk_color_efectivo: 'verde' });
    const rows = buildRiskScreenRows(await loadShipments(manifestId));
    expect(resumirRiesgo(rows, 'resultadoMotor')).toMatchObject({ analizados: 1, validarEnPrevio: 1, aprobados: 0 });
    expect(resumirRiesgo(rows, 'resultado')).toMatchObject({ analizados: 1, validarEnPrevio: 0, aprobados: 1 });
  });
});
