// shared/rrna/evaluar.test.ts
import { describe, expect, it } from 'vitest';
import { evaluarRrna } from './evaluar';
import { RRNA_PATTERNS, RRNA_LABELS } from './catalogo';

const cats = (d: string, v?: number) =>
  evaluarRrna({ descripcion: d, valorDeclarado: v }).map((c) => c.categoria);

describe('coincidencias por palabra completa, no por subcadena', () => {
  it('un patrón de tres letras no pega dentro de otra palabra', () => {
    // El catálogo de alimentos trae 'te '. Como subcadena pegaría en todas éstas.
    for (const d of ['telefono movil', 'textil de algodon', 'terminal para computadora']) {
      expect(cats(d), d).not.toContain('COFEPRIS_FOOD');
    }
  });

  it('pero sí pega cuando es la palabra', () => {
    expect(cats('caja de te verde')).toContain('COFEPRIS_FOOD');
  });

  it('los patrones de varias palabras siguen funcionando', () => {
    expect(cats('protector solar para la playa')).toContain('COFEPRIS_COSMETICS');
  });

  it('ignora acentos y mayúsculas', () => {
    expect(cats('CREMA para la cara')).toContain('COFEPRIS_COSMETICS');
    expect(cats('locion corporal')).toContain('COFEPRIS_COSMETICS');
  });
});

describe('una coincidencia por categoría, no una por palabra', () => {
  it('tres palabras de la misma categoría producen UNA entrada', () => {
    // Marcar COFEPRIS tres veces no agrega información y ensucia la columna.
    const m = evaluarRrna({ descripcion: 'crema gel y jabon' });
    expect(m.filter((c) => c.categoria === 'COFEPRIS_COSMETICS')).toHaveLength(1);
  });

  it('categorías distintas sí se acumulan', () => {
    const c = cats('perfume y cuchillo de caza');
    expect(c).toContain('COFEPRIS_COSMETICS');
    expect(c).toContain('SEDENA_WEAPONS');
  });
});

describe('la coincidencia dice QUÉ término la disparó', () => {
  it('sin eso, descartar un falso positivo obligaría a abrir cada guía', () => {
    const [m] = evaluarRrna({ descripcion: 'Pulverizador de perfume de plastico' });
    expect(m.termino).toBe('perfume');
    expect(m.autoridad).toBe(RRNA_LABELS.COFEPRIS_COSMETICS.authority);
    expect(m.label).toBe(RRNA_LABELS.COFEPRIS_COSMETICS.label);
  });
});

describe('ZERO_VALUE es numérico, no de texto', () => {
  it('su lista de patrones está vacía a propósito', () => {
    expect(RRNA_PATTERNS.ZERO_VALUE).toEqual([]);
  });

  it('un valor cero o negativo dispara la categoría', () => {
    expect(cats('camisa de algodon', 0)).toContain('ZERO_VALUE');
    expect(cats('camisa de algodon', -5)).toContain('ZERO_VALUE');
  });

  it('un valor normal no', () => {
    expect(cats('camisa de algodon', 100)).not.toContain('ZERO_VALUE');
  });

  it('SIN valor declarado tampoco: un dato faltante no es un cero', () => {
    // Confundirlos inventaría la infracción de la RGCE 3.7.3 sobre una guía que sólo está
    // incompleta.
    expect(cats('camisa de algodon')).not.toContain('ZERO_VALUE');
    expect(evaluarRrna({ descripcion: 'camisa', valorDeclarado: null }).map((c) => c.categoria))
      .not.toContain('ZERO_VALUE');
  });
});

describe('sin descripción no se inventa nada', () => {
  it('vacía, espacios o nula devuelven lista vacía', () => {
    for (const d of ['', '   ', null, undefined]) {
      expect(evaluarRrna({ descripcion: d as string }), JSON.stringify(d)).toEqual([]);
    }
  });
});

describe('el catálogo es sustituible', () => {
  it('un catálogo propio reemplaza al de fábrica', () => {
    const m = evaluarRrna({ descripcion: 'widget especial' }, { SEDENA_WEAPONS: ['widget'] });
    expect(m.map((c) => c.categoria)).toEqual(['SEDENA_WEAPONS']);
    // Y lo de fábrica deja de aplicar con ese catálogo.
    expect(evaluarRrna({ descripcion: 'perfume' }, { SEDENA_WEAPONS: ['widget'] })).toEqual([]);
  });
});

describe('precisión conocida: esto es triaje, no veredicto', () => {
  /**
   * Medido sobre el manifiesto golden de 501 filas: marca 26 (5.2%), y alrededor de la mitad son
   * falsos positivos. Se fijan aquí, con nombre, para que nadie los descubra en producción creyendo
   * que son hallazgos — y para que si alguien afina el catálogo, el test diga qué cambió.
   *
   * Es exactamente por esto que este módulo NO alimenta el semáforo.
   */
  it('un catálogo por palabra clave produce falsos positivos previsibles', () => {
    expect(cats('Pistola de limpieza para pulverizacion')).toContain('SEDENA_WEAPONS');
    expect(cats('Flor de imitacion de plastico para uso decorativo')).toContain('SENASICA_AGRICULTURAL');
    expect(cats('Cuchara de cafe de acero inoxidable')).toContain('COFEPRIS_FOOD');
    expect(cats('Set de regalo de reloj de acero')).toContain('GENERIC_DESCRIPTION');
  });

  it('y aciertos que valen la columna entera', () => {
    expect(cats('belleza de lapiz labial')).toContain('COFEPRIS_COSMETICS');
    expect(cats('jeringa esteril desechable')).toContain('COFEPRIS_MEDICAL');
  });
});
