// shared/operaciones/periodos.test.ts
import { describe, expect, it } from 'vitest';
import { cubeta, semanaIso, partirPeriodo, PERIODO_SIN_FECHA } from './periodos';

describe('el día es local, no UTC', () => {
  it('un vuelo que aterriza a las 19:30 de CDMX cuenta en ESE día, no en el siguiente', () => {
    // 2026-09-18 19:30 CDMX = 2026-09-19 01:30 UTC. Preguntando en UTC, el vuelo se contaría en
    // un día que el almacén no trabajó. Éste es el off-by-one que sólo aparece de noche.
    const t = new Date('2026-09-19T01:30:00Z');
    expect(t.toISOString().slice(0, 10)).toBe('2026-09-19'); // lo que diría UTC
    expect(cubeta(t, 'dia')).toBe('2026-09-18');             // lo que dice la operación
  });

  it('el corrimiento también mueve el mes y el año cuando toca', () => {
    // 2025-12-31 20:00 CDMX = 2026-01-01 02:00 UTC.
    const t = new Date('2026-01-01T02:00:00Z');
    expect(cubeta(t, 'mes')).toBe('2025-12');
    expect(cubeta(t, 'anio')).toBe('2025');
  });
});

describe('semana ISO', () => {
  it('empieza en lunes: domingo pertenece a la semana que terminó, no a la que empieza', () => {
    expect(semanaIso('2026-09-20')).toEqual(semanaIso('2026-09-14')); // domingo y su lunes
    expect(semanaIso('2026-09-21')).not.toEqual(semanaIso('2026-09-20')); // lunes siguiente
  });

  it('la semana pertenece al año de su JUEVES, no al del 1 de enero', () => {
    // 2027-01-01 es viernes: esa semana (lunes 28-dic-2026 a domingo 3-ene-2027) es W53 de 2026.
    // Etiquetarla 2027-W01 partiría una semana en dos años, y el comparativo anual arrancaría
    // con una semana de tres días contra una de siete.
    expect(semanaIso('2027-01-01')).toEqual({ anio: 2026, semana: 53 });
    expect(semanaIso('2026-12-28')).toEqual({ anio: 2026, semana: 53 });
  });

  it('rechaza lo que no es una fecha civil', () => {
    for (const v of ['', '2026-9-1', 'hoy', '2026/09/01']) expect(semanaIso(v), v).toBeNull();
  });
});

describe('las etiquetas ordenan alfabéticamente igual que cronológicamente', () => {
  it('la semana lleva dos dígitos para que W09 no se cuele después de W10', () => {
    const w9 = cubeta(new Date('2026-02-25T18:00:00Z'), 'semana');
    const w10 = cubeta(new Date('2026-03-04T18:00:00Z'), 'semana');
    expect(w9).toMatch(/^\d{4}-W\d{2}$/);
    expect([w10, w9].sort()).toEqual([w9, w10]);
  });

  it('meses y días también', () => {
    expect(['2026-10', '2026-02', '2026-09'].sort()).toEqual(['2026-02', '2026-09', '2026-10']);
  });
});

describe('sin instante ancla', () => {
  it('no se descarta ni se inventa: cae en sin-fecha', () => {
    for (const v of [null, undefined, '', 'no es fecha']) {
      expect(cubeta(v as string, 'mes'), JSON.stringify(v)).toBe(PERIODO_SIN_FECHA);
    }
  });

  it('sin-fecha no se puede partir en año y resto', () => {
    expect(partirPeriodo(PERIODO_SIN_FECHA)).toBeNull();
  });
});

describe('partirPeriodo', () => {
  it('separa el año del resto, que es lo que se compara entre años', () => {
    expect(partirPeriodo('2026-09')).toEqual({ anio: '2026', resto: '09' });
    expect(partirPeriodo('2026-W38')).toEqual({ anio: '2026', resto: 'W38' });
    expect(partirPeriodo('2026-09-18')).toEqual({ anio: '2026', resto: '09-18' });
  });

  it('un año suelto no tiene resto: el año ENTERO es el periodo', () => {
    expect(partirPeriodo('2026')).toEqual({ anio: '2026', resto: '' });
  });
});
