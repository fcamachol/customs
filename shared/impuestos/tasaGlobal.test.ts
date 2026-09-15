import { describe, expect, it } from 'vitest';
import { estimarImpuesto, resolverTasa, tipoOrigenDe, type TasaVigencia } from './tasaGlobal';

const TABLA: TasaVigencia[] = [
  { startDate: '2025-01-01', originType: 'GENERAL', rate: 19 },
  { startDate: '2026-01-01', originType: 'GENERAL', rate: 33.5 },
  { startDate: '2026-01-01', originType: 'TMEC', rate: 0 },
];

describe('tipoOrigenDe', () => {
  it('clasifica los países del T-MEC', () => {
    expect(tipoOrigenDe('MX')).toBe('TMEC');
    expect(tipoOrigenDe('us')).toBe('TMEC');
    expect(tipoOrigenDe('CN')).toBe('GENERAL');
  });

  // Un origen desconocido NO puede abaratar el estimado: subestimar el impuesto le daría al
  // cliente una expectativa que la autoridad va a desmentir.
  it('un código ausente o desconocido cae en GENERAL, la tasa más alta', () => {
    expect(tipoOrigenDe(null)).toBe('GENERAL');
    expect(tipoOrigenDe('')).toBe('GENERAL');
    expect(tipoOrigenDe('XX')).toBe('GENERAL');
  });
});

describe('resolverTasa', () => {
  // La razón entera de leer la tabla en vez de multiplicar por una constante.
  it('un documento viejo se estima con la tasa que estaba vigente entonces', () => {
    expect(resolverTasa(TABLA, '2025-06-15', 'GENERAL').vigencia?.rate).toBe(19);
    expect(resolverTasa(TABLA, '2026-09-15', 'GENERAL').vigencia?.rate).toBe(33.5);
  });

  it('distingue GENERAL de TMEC', () => {
    expect(resolverTasa(TABLA, '2026-09-15', 'TMEC').vigencia?.rate).toBe(0);
  });

  // Nunca caer a un valor por defecto: un estimado calculado con una tasa que nadie configuró se
  // ve igual de creíble que uno real y no lo es.
  it('sin tabla o sin vigencia devuelve null CON motivo, no una tasa inventada', () => {
    expect(resolverTasa([], '2026-09-15', 'GENERAL')).toEqual({ vigencia: null, motivo: 'sin_tabla' });
    expect(resolverTasa(TABLA, '2020-01-01', 'GENERAL')).toEqual({
      vigencia: null, motivo: 'sin_vigencia_para_la_fecha',
    });
  });
});

describe('estimarImpuesto', () => {
  it('estima por partida con la tasa que corresponde a su origen', () => {
    const r = estimarImpuesto(
      [
        { guia: 'A', valorUsd: 100, codigoPaisRemitente: 'CN' },
        { guia: 'B', valorUsd: 200, codigoPaisRemitente: 'US' },
      ],
      TABLA,
      '2026-09-15',
    );
    expect(r.partidas[0].impuestoUsd).toBe(33.5);
    expect(r.partidas[1].impuestoUsd).toBe(0);
    expect(r.totalImpuestoUsd).toBe(33.5);
    expect(r.totalValorUsd).toBe(300);
  });

  // El total no puede aparentar cubrir lo que no cubrió.
  it('cuenta las partidas que no se pudieron estimar', () => {
    const r = estimarImpuesto([{ guia: 'A', valorUsd: 100 }], [], '2026-09-15');
    expect(r.partidas[0].impuestoUsd).toBeNull();
    expect(r.partidas[0].motivo).toBe('sin_tabla');
    expect(r.sinEstimar).toBe(1);
    expect(r.totalImpuestoUsd).toBe(0);
  });

  it('reporta las tasas usadas para poder citarlas en pantalla', () => {
    const r = estimarImpuesto([{ guia: 'A', valorUsd: 100, codigoPaisRemitente: 'CN' }], TABLA, '2026-09-15');
    expect(r.tasasUsadas).toEqual([{ origen: 'GENERAL', tasaPct: 33.5, desde: '2026-01-01' }]);
  });
});
