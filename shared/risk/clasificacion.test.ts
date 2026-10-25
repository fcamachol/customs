// shared/risk/clasificacion.test.ts — la misma mercancía bajo dos fracciones
import { describe, expect, it } from 'vitest';
import { claveMercancia, fraccionBase, indexarClasificacion } from './clasificacion';
import { scoreManifest } from './classify';
import { RULESET } from './ruleset';
import { hallazgoHash } from './efectivo';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment> = {}): Shipment {
  return {
    id: 'x', mawbReference: 'M', description: 'funda de plástico para teléfono móvil',
    hsCode: '3926909990', quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: 'g',
    consignee: { name: 'Ana Garcia', rfc: 'PERJ800101AA8', address: 'Calle 1' },
    sender: { name: 'Sender Co' }, platform: { commercialName: 'P' },
    ...over,
  } as Shipment;
}

describe('fraccionBase — se compara a 8 dígitos, no a 10', () => {
  it('recorta el NICO: dos NICOs de la misma fracción NO se contradicen', () => {
    // 3926909990 y 3926909910 son la MISMA fracción (39269099) con distinto NICO.
    // Compararlas a 10 dígitos inventaría un hallazgo donde no hay desacuerdo de clasificación.
    expect(fraccionBase('3926909990')).toBe('39269099');
    expect(fraccionBase('3926909910')).toBe('39269099');
  });

  it('ignora puntos y separadores', () => {
    expect(fraccionBase('3926.90.99')).toBe('39269099');
  });

  it('devuelve null cuando no hay 8 dígitos que leer', () => {
    for (const v of ['', '   ', '123', 'abc', null, undefined]) {
      expect(fraccionBase(v as string), JSON.stringify(v)).toBeNull();
    }
  });
});

describe('claveMercancia — conservadora a propósito', () => {
  it('iguala acentos, mayúsculas, espacios y el sufijo de cantidad', () => {
    const a = claveMercancia('Funda de PLÁSTICO  para teléfono móvil * 1');
    expect(a).toBe(claveMercancia('funda de plastico para telefono movil'));
  });

  it('NO agrupa descripciones distintas aunque se parezcan', () => {
    // Agrupar de más no da una señal más sensible: da una acusación falsa.
    expect(claveMercancia('funda de plástico')).not.toBe(claveMercancia('funda de silicón'));
  });

  it('sin descripción no hay clave', () => {
    expect(claveMercancia('')).toBeNull();
    expect(claveMercancia('   * 2')).toBeNull();
  });
});

describe('indexarClasificacion', () => {
  it('sólo guarda los grupos EN CONFLICTO', () => {
    const idx = indexarClasificacion([
      { description: 'camisa', hsCode: '61091000' },
      { description: 'camisa', hsCode: '61091000' },
      { description: 'funda', hsCode: '39269099' },
      { description: 'funda', hsCode: '39264000' },
    ]);
    expect(Object.keys(idx.fraccionesPorMercancia)).toEqual(['funda']);
    expect(idx.fraccionesPorMercancia['funda']).toEqual(['39264000', '39269099']);
  });

  it('una fila sin fracción legible no arrastra a su grupo al conflicto', () => {
    const idx = indexarClasificacion([
      { description: 'funda', hsCode: '39269099' },
      { description: 'funda', hsCode: 'sin dato' },
    ]);
    expect(idx.fraccionesPorMercancia).toEqual({});
  });

  it('las fracciones salen ordenadas, para que la huella no dependa del orden de las filas', () => {
    const a = indexarClasificacion([
      { description: 'f', hsCode: '39269099' }, { description: 'f', hsCode: '39264000' },
    ]);
    const b = indexarClasificacion([
      { description: 'f', hsCode: '39264000' }, { description: 'f', hsCode: '39269099' },
    ]);
    expect(a.fraccionesPorMercancia['f']).toEqual(b.fraccionesPorMercancia['f']);
  });
});

describe('la señal dentro del motor', () => {
  const contradictorio = () => [
    ship({ id: '1', hsCode: '3926909990' }),
    ship({ id: '2', hsCode: '3926400000' }),
  ];

  it('marca las DOS caras, no sólo la minoritaria', () => {
    // El motor no sabe cuál de las dos clasificaciones es la correcta. Señalar sólo a la minoría
    // sería inventar esa respuesta — a veces la mayoría es la que está mal.
    const out = scoreManifest([...contradictorio(), ship({ id: '3', hsCode: '3926909990' })], {});
    expect(out.filter((r) => r.reasons.some((x) => x.signalId === 'clasificacion_inconsistente'))).toHaveLength(3);
  });

  it('no dispara cuando la mercancía va siempre bajo la misma fracción', () => {
    const out = scoreManifest([ship({ id: '1' }), ship({ id: '2' })], {});
    expect(out.every((r) => !r.reasons.some((x) => x.signalId === 'clasificacion_inconsistente'))).toBe(true);
  });

  it('no dispara por un NICO distinto dentro de la misma fracción', () => {
    const out = scoreManifest(
      [ship({ id: '1', hsCode: '3926909990' }), ship({ id: '2', hsCode: '3926909910' })], {},
    );
    expect(out.every((r) => !r.reasons.some((x) => x.signalId === 'clasificacion_inconsistente'))).toBe(true);
  });

  it('una fila sola nunca se contradice consigo misma', () => {
    const out = scoreManifest([ship()], {});
    expect(out[0].reasons.some((r) => r.signalId === 'clasificacion_inconsistente')).toBe(false);
  });

  it('vale el peso completo y NO fuerza rojo', () => {
    // De dos líneas contradictorias al menos una está mal, pero al menos una está BIEN.
    // Forzar rojo condenaría también a la correcta.
    const r = scoreManifest(contradictorio(), {})[0].reasons
      .find((x) => x.signalId === 'clasificacion_inconsistente');
    expect(r?.points).toBe(RULESET.weights.clasificacion_inconsistente);
    expect(r?.forcesBand).toBeUndefined();
  });

  it('una contradicción sola basta para sacar la fila de verde', () => {
    const out = scoreManifest(contradictorio(), {});
    expect(out[0].reasons.map((r) => r.signalId)).toEqual(['clasificacion_inconsistente']);
    expect(out[0].band).toBe('amarillo');
  });

  it('la evidencia dice qué mercancía, qué fracciones chocan y cuál trae esta fila', () => {
    const r = scoreManifest(contradictorio(), {})[0].reasons
      .find((x) => x.signalId === 'clasificacion_inconsistente');
    expect(r?.evidence?.fracciones).toEqual(['39264000', '39269099']);
    expect(r?.evidence?.fraccionDeEstaFila).toBe('39269099');
    expect(r?.evidence?.clave).toBe('funda de plastico para telefono movil');
  });
});

describe('bandas — la recalibración no escondió señales viejas', () => {
  it('una fila con el RFC mal sigue siendo amarillo con maxPoints=398', () => {
    const [row] = scoreManifest([ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AA9', address: 'C1' } as never })], {});
    expect(row.reasons.map((r) => r.signalId)).toEqual(['id']);
    expect(row.band).toBe('amarillo');
  });

  it('una fila limpia sigue verde', () => {
    expect(scoreManifest([ship()], {})[0].band).toBe('verde');
  });
});

describe('huella del hallazgo', () => {
  const razon = (evidence: Record<string, unknown>) => ({
    signalId: 'clasificacion_inconsistente' as const, points: 25, weight: 25, detail: 'da igual', evidence,
  });

  it('las dos caras de UNA contradicción comparten huella', () => {
    // Si no, disponer sobre la línea de una fracción dejaría viva la otra y el humano
    // tendría que afirmar dos veces lo mismo.
    expect(hallazgoHash(razon({ clave: 'funda', fracciones: ['39264000', '39269099'], fraccionDeEstaFila: '39264000' })))
      .toBe(hallazgoHash(razon({ clave: 'funda', fracciones: ['39264000', '39269099'], fraccionDeEstaFila: '39269099' })));
  });

  it('una TERCERA fracción es un hallazgo nuevo, no el mismo', () => {
    expect(hallazgoHash(razon({ clave: 'funda', fracciones: ['39264000', '39269099'] })))
      .not.toBe(hallazgoHash(razon({ clave: 'funda', fracciones: ['39264000', '39269099', '39269091'] })));
  });

  it('el mismo par de fracciones en OTRA mercancía es otro hallazgo', () => {
    expect(hallazgoHash(razon({ clave: 'funda', fracciones: ['39264000', '39269099'] })))
      .not.toBe(hallazgoHash(razon({ clave: 'cinturon', fracciones: ['39264000', '39269099'] })));
  });
});
