// shared/operaciones/leadTimesPeriodo.test.ts — cortes de periodo y comparativo anual
import { describe, expect, it } from 'vitest';
import { calcularLeadTimes, resumirPorPeriodo, compararAnios, type LeadTimes } from './leadTimes';
import { PERIODO_SIN_FECHA } from './periodos';

/** Una fila con un tiempo de almacén conocido, anclada al instante dado. */
function fila(ancla: string | null, almacenHoras: number | null) {
  const lt: LeadTimes = calcularLeadTimes({
    arriboVueloAt: ancla,
    disponibleAt: ancla && almacenHoras != null
      ? new Date(new Date(ancla).getTime() + almacenHoras * 3600_000).toISOString()
      : null,
    modulacionAt: null, salidaRojoAt: null, citaAt: null, ingresoPatioAt: null,
    ingresoAduanaAt: null, inicioCargaAt: null, finCargaAt: null, salidaAt: null,
    etaCalculado: null, arriboReal: null, podFirmadoAt: null,
  });
  return { ancla, leadTimes: lt };
}

describe('resumirPorPeriodo', () => {
  it('agrupa por mes y cuenta el volumen de cada cubeta', () => {
    const out = resumirPorPeriodo(
      [fila('2026-09-10T15:00:00Z', 2), fila('2026-09-20T15:00:00Z', 4), fila('2026-08-01T15:00:00Z', 6)],
      'mes',
    );
    expect(out.map((c) => [c.periodo, c.operaciones])).toEqual([['2026-08', 1], ['2026-09', 2]]);
  });

  it('el promedio de la cubeta se calcula SOLO con sus filas', () => {
    const out = resumirPorPeriodo(
      [fila('2026-09-10T15:00:00Z', 2), fila('2026-09-20T15:00:00Z', 4), fila('2026-08-01T15:00:00Z', 60)],
      'mes',
    );
    const sep = out.find((c) => c.periodo === '2026-09')!;
    expect(sep.resumen.almacenMin.promedioMin).toBe(180); // (2h + 4h) / 2
    expect(sep.resumen.almacenMin.muestras).toBe(2);
  });

  it('una fila sin ancla NO se descarta: cae en sin-fecha y al final', () => {
    // Descartarlas haría que la suma de las cubetas fuera menor que el total sin que nadie sepa
    // por qué; meterlas en una cubeta cualquiera sería peor.
    const out = resumirPorPeriodo([fila('2026-09-10T15:00:00Z', 2), fila(null, null)], 'mes');
    expect(out.map((c) => c.periodo)).toEqual(['2026-09', PERIODO_SIN_FECHA]);
    expect(out.reduce((a, c) => a + c.operaciones, 0)).toBe(2);
  });

  it('las cubetas salen en orden cronológico aunque las filas lleguen revueltas', () => {
    const out = resumirPorPeriodo(
      [fila('2026-10-01T15:00:00Z', 1), fila('2026-02-01T15:00:00Z', 1), fila('2026-09-01T15:00:00Z', 1)],
      'mes',
    );
    expect(out.map((c) => c.periodo)).toEqual(['2026-02', '2026-09', '2026-10']);
  });

  it('el corte local decide la cubeta, no el UTC del instante', () => {
    // 2026-10-01 01:00 UTC = 2026-09-30 19:00 CDMX → septiembre, no octubre.
    const out = resumirPorPeriodo([fila('2026-10-01T01:00:00Z', 1)], 'mes');
    expect(out[0].periodo).toBe('2026-09');
  });
});

describe('compararAnios', () => {
  const cubetas = (pares: Array<[string, number]>) =>
    pares.map(([periodo, operaciones]) => ({ periodo, operaciones, resumen: {} as never }));

  it('alinea el mismo mes entre años y calcula la variación', () => {
    const out = compararAnios(cubetas([['2025-09', 100], ['2026-09', 143]]), 'mes');
    expect(out).toHaveLength(1);
    expect(out[0].periodo).toBe('09');
    expect(out[0].porAnio).toEqual({ '2025': 100, '2026': 143 });
    expect(out[0].variacionPct).toBe(43);
    expect(out[0].anioBase).toBe('2025');
    expect(out[0].anioComparado).toBe('2026');
  });

  it('una caída se reporta negativa, con un decimal', () => {
    const out = compararAnios(cubetas([['2025-09', 120], ['2026-09', 100]]), 'mes');
    expect(out[0].variacionPct).toBe(-16.7);
  });

  it('sin año anterior no hay variación — null, no 0 ni +100%', () => {
    const out = compararAnios(cubetas([['2026-09', 143]]), 'mes');
    expect(out[0].variacionPct).toBeNull();
    expect(out[0].anioBase).toBeNull();
  });

  it('con el año base en cero tampoco: dividir entre cero inventaría la comparación', () => {
    const out = compararAnios(cubetas([['2025-09', 0], ['2026-09', 143]]), 'mes');
    expect(out[0].variacionPct).toBeNull();
    expect(out[0].porAnio).toEqual({ '2025': 0, '2026': 143 });
  });

  it('compara contra el año INMEDIATO anterior, no contra el más viejo', () => {
    const out = compararAnios(cubetas([['2024-09', 10], ['2025-09', 100], ['2026-09', 150]]), 'mes');
    expect(out[0].anioBase).toBe('2025');
    expect(out[0].variacionPct).toBe(50);
  });

  it('con corte anual no hay nada que alinear: devuelve vacío', () => {
    // El periodo ES el año; comparar sería enfrentar un año contra sí mismo.
    expect(compararAnios(cubetas([['2025', 100], ['2026', 143]]), 'anio')).toEqual([]);
  });

  it('sin-fecha no entra al comparativo', () => {
    const out = compararAnios(cubetas([['2026-09', 10], [PERIODO_SIN_FECHA, 5]]), 'mes');
    expect(out).toHaveLength(1);
    expect(out[0].periodo).toBe('09');
  });

  it('alinea semanas ISO igual que meses', () => {
    const out = compararAnios(cubetas([['2025-W38', 80], ['2026-W38', 92]]), 'semana');
    expect(out[0].periodo).toBe('W38');
    expect(out[0].variacionPct).toBe(15);
  });
});
