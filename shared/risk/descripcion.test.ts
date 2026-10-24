// shared/risk/descripcion.test.ts — la señal de descripción genérica
import { describe, expect, it } from 'vitest';
import { analizarDescripcion, GENERICOS_DEFAULT } from './descripcion';
import { gradeSignals } from './signals';
import { scoreManifest } from './classify';
import { RULESET, resolveThresholds, resolveWeights } from './ruleset';
import { hallazgoHash } from './efectivo';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment> = {}): Shipment {
  return {
    id: 'x', mawbReference: 'M', description: 'camisa de algodón para hombre',
    hsCode: '9901000100', quantity: 1, unit: 'PCE', customsValueUsd: 100, currency: 'USD',
    originCountry: 'CN', guideId: 'g',
    consignee: { name: 'Ana Garcia', rfc: 'PERJ800101AA8', address: 'Calle 1' },
    sender: { name: 'Sender Co' }, platform: { commercialName: 'P' },
    ...over,
  } as Shipment;
}

const ctx = () => ({
  thresholds: resolveThresholds(),
  weights: resolveWeights(),
  addressDistinctConsignees: {},
  monthlyNameCount: {},
});

const razonDesc = (s: Shipment) =>
  gradeSignals(s, ctx() as never).find((r) => r.signalId === 'descripcion_generica');

describe('analizarDescripcion — qué cuenta como informativa', () => {
  it('una descripción corta que NOMBRA el objeto es informativa', () => {
    // 15 caracteres, y aun así dice qué es. La regla no mide longitud.
    for (const d of ['anillo de acero', 'Cinturón de plástico', 'Linterna Para iluminar', '1 pelacables']) {
      expect(analizarDescripcion(d).veredicto, d).toBe('informativa');
    }
  });

  it('el sufijo de cantidad del manifiesto no cuenta como contenido', () => {
    // Sin esto, "mercancía * 1" tendría un token ("1") y nunca sería genérica.
    expect(analizarDescripcion('mercancía * 1').veredicto).toBe('solo_generica');
    expect(analizarDescripcion('Auriculares inalámbricos * 2').veredicto).toBe('informativa');
  });

  it('un genérico puro no dice nada, en español o en inglés', () => {
    for (const d of ['artículo', 'MERCANCIA GENERAL', 'varios', 'gift', 'general merchandise',
                     'sample', 'personal effects', 'efectos personales', 'accesorios']) {
      expect(analizarDescripcion(d).veredicto, d).toBe('solo_generica');
    }
  });

  it('sólo relleno de propósito tampoco nombra nada', () => {
    expect(analizarDescripcion('para uso doméstico').veredicto).toBe('solo_generica');
    expect(analizarDescripcion('for daily home use').veredicto).toBe('solo_generica');
  });

  it('nombrar el material sin el objeto es su propio veredicto, no el mismo que decir nada', () => {
    // El caso real del manifiesto golden. Acota el capítulo arancelario; no identifica el producto.
    expect(analizarDescripcion('Plástico de cristal').veredicto).toBe('solo_material');
    expect(analizarDescripcion('acero inoxidable').veredicto).toBe('solo_material');
  });

  it('vacía, espacios o nula responden vacia en vez de lanzar', () => {
    for (const d of ['', '   ', null, undefined, '* 1', '///']) {
      expect(analizarDescripcion(d as string).veredicto, JSON.stringify(d)).toBe('vacia');
    }
  });

  it('la evidencia conserva los tokens que motivaron el veredicto', () => {
    const a = analizarDescripcion('mercancía general');
    expect(a.tokensVacios).toEqual(['mercancia', 'general']);
    expect(a.tokensUtiles).toEqual([]);
  });

  it('el catálogo administrable reemplaza al de fábrica, no se suma', () => {
    // Un cliente que decide que "widget" no le dice nada; y que, al reemplazar, "gift" sí pasa.
    expect(analizarDescripcion('widget', { terminosGenericos: ['widget'] }).veredicto).toBe('solo_generica');
    expect(analizarDescripcion('gift', { terminosGenericos: ['widget'] }).veredicto).toBe('informativa');
  });
});

describe('gradeSignals — descripcion_generica', () => {
  it('no dispara sobre una descripción normal', () => {
    expect(razonDesc(ship())).toBeUndefined();
  });

  it('una descripción genérica vale el peso completo', () => {
    const r = razonDesc(ship({ description: 'artículos varios' }));
    expect(r?.points).toBe(RULESET.weights.descripcion_generica);
    expect(r?.evidence?.veredicto).toBe('solo_generica');
  });

  it('sólo-material vale menos: acota el capítulo arancelario aunque no nombre el producto', () => {
    const r = razonDesc(ship({ description: 'Plástico de cristal' }));
    expect(r?.points).toBe(Math.round(RULESET.weights.descripcion_generica * 0.6));
    expect(r?.points).toBeLessThan(RULESET.weights.descripcion_generica);
  });

  it('NO fuerza rojo: es calidad del dato, no severidad', () => {
    const r = razonDesc(ship({ description: 'gift' }));
    expect(r?.forcesBand).toBeUndefined();
  });

  it('la descripción cruda viaja en la evidencia para que el operador la lea', () => {
    const r = razonDesc(ship({ description: 'GIFT' }));
    expect(r?.evidence?.descripcion).toBe('GIFT');
  });
});

describe('bandas — la recalibración no escondió señales viejas', () => {
  // RFC con la FORMA correcta y el dígito verificador mal. Importa que esté presente: un RFC
  // vacío manda la fila a `gris` por `insufficientData` y nunca llega a puntuar, así que no
  // sirve para medir si la banda amarilla quedó bien.
  const rfcMalDigito = () => ship({ consignee: { name: 'Ana', rfc: 'PERJ800101AA9', address: 'Calle 1' } as never });

  it('una fila con el RFC mal sigue siendo amarillo, no verde', () => {
    // El riesgo de agregar un peso nuevo: maxPoints sube (348 → 373) y comprime los scores. Si
    // amarillo se hubiera quedado en 7, `id` (25 pts de 373 = 6.70) habría caído a verde — o sea
    // que la señal nueva habría escondido una vieja. Descripción informativa a propósito:
    // aquí se mide `id` sola.
    const [row] = scoreManifest([rfcMalDigito()], {});
    expect(row.reasons.map((r) => r.signalId)).toEqual(['id']);
    expect(row.band).toBe('amarillo');
  });

  it('una descripción que no dice nada basta para sacar la fila de verde', () => {
    const [row] = scoreManifest([ship({ description: 'mercancía' })], {});
    expect(row.reasons.map((r) => r.signalId)).toEqual(['descripcion_generica']);
    expect(row.band).toBe('amarillo');
  });

  it('RFC mal Y descripción que no dice nada es rojo: la fila no se puede auditar por ningún lado', () => {
    const [row] = scoreManifest(
      [ship({ description: 'gift', consignee: { name: 'Ana', rfc: 'PERJ800101AA9', address: 'Calle 1' } as never })],
      {},
    );
    expect(row.reasons.map((r) => r.signalId).sort()).toEqual(['descripcion_generica', 'id']);
    expect(row.band).toBe('rojo');
  });

  it('una fila limpia sigue verde', () => {
    expect(scoreManifest([ship()], {})[0].band).toBe('verde');
  });
});

describe('huella del hallazgo', () => {
  const razon = (veredicto: string, descripcion: string) => ({
    signalId: 'descripcion_generica' as const, points: 25, weight: 25,
    detail: 'da igual', evidence: { veredicto, descripcion },
  });

  it('dos textos vagos del mismo tipo son el MISMO hallazgo — no se re-afirma por una mayúscula', () => {
    expect(hallazgoHash(razon('solo_generica', 'gift')))
      .toBe(hallazgoHash(razon('solo_generica', 'GIFT  ')));
  });

  it('disponer sobre sólo-material NO tapa una fila que después ya no dice nada', () => {
    expect(hallazgoHash(razon('solo_material', 'acero')))
      .not.toBe(hallazgoHash(razon('solo_generica', 'acero')));
  });
});

describe('catálogo de fábrica', () => {
  it('no trae entradas duplicadas ni con espacios de sobra', () => {
    const limpio = GENERICOS_DEFAULT.map((t) => t.trim());
    expect(limpio).toEqual([...GENERICOS_DEFAULT]);
    expect(new Set(GENERICOS_DEFAULT).size).toBe(GENERICOS_DEFAULT.length);
  });
});
