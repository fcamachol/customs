import { describe, expect, it } from 'vitest';
import { resolveHeader, normalize, CANONICAL_PATHS } from './headerSynonyms';

describe('resolveHeader', () => {
  it('maps Spanish consignee headers', () => {
    expect(resolveHeader('RFC')).toBe('consignee.rfc');
    expect(resolveHeader('CURP')).toBe('consignee.curp');
    expect(resolveHeader('Domicilio')).toBe('consignee.address');
  });
  it('maps sender (remitente) headers', () => {
    expect(resolveHeader('Remitente Nombre')).toBe('sender.name');
    expect(resolveHeader('Id fiscal del remitente')).toBe('sender.taxId');
  });
  it('maps platform headers', () => {
    expect(resolveHeader('Nombre comercial')).toBe('platform.commercialName');
    expect(resolveHeader('País de origen')).toBe('platform.countryOfOrigin');
  });
  it('maps arrival date', () => {
    expect(resolveHeader('Fecha de arribo a territorio nacional')).toBe('core.arrivalDate');
  });
  it('returns null for unknown headers', () => {
    expect(resolveHeader('Columna Rara')).toBeNull();
  });
});

describe('resolveHeader with a per-client override mapping', () => {
  it('maps a header the static table does not know', () => {
    const extra = { [normalize('Clave del Producto')]: 'core.hsCode' };
    expect(resolveHeader('Clave del Producto')).toBeNull();
    expect(resolveHeader('Clave del Producto', extra)).toBe('core.hsCode');
  });

  it('lets a client override win over the static synonym', () => {
    // "RFC" resolves to consignee.rfc by default; a client remaps it.
    expect(resolveHeader('RFC')).toBe('consignee.rfc');
    const extra = { [normalize('RFC')]: 'sender.taxId' };
    expect(resolveHeader('RFC', extra)).toBe('sender.taxId');
  });

  it('is accent/case-insensitive on the override key', () => {
    const extra = { [normalize('Código Interno')]: 'core.description' };
    expect(resolveHeader('  CÓDIGO   interno ', extra)).toBe('core.description');
  });

  it('falls through to the static table for headers not in the override', () => {
    const extra = { [normalize('Algo Raro')]: 'core.hsCode' };
    expect(resolveHeader('Fracción arancelaria', extra)).toBe('core.hsCode');
    expect(resolveHeader('Otra Cosa', extra)).toBeNull();
  });
});

describe('CANONICAL_PATHS', () => {
  it('exposes the distinct canonical paths as a de-duplicated list', () => {
    expect(CANONICAL_PATHS).toContain('core.hsCode');
    expect(CANONICAL_PATHS).toContain('consignee.rfc');
    expect(new Set(CANONICAL_PATHS).size).toBe(CANONICAL_PATHS.length);
  });
});

// The 28 REAL headers, verbatim (accents + punctuation), from the first row
// of MANIFEST_TEST.xlsx. The whole point of Task 1 is to read THIS file, so
// every one of these must resolve to a non-null canonical path.
const REAL_MANIFEST_HEADERS = [
  'MWB',
  'Número de guía de embarque',
  'Expedidor',
  'Dirección del remitente',
  'Nombre de la ciudad del remitente',
  'Código de ciudad del remitente',
  'Nombre del país del remitente',
  'Código de país del remitente',
  'ID',
  'Destinatario (CNNE)',
  'Email',
  'Dirección de CNNE',
  'Nombre de la ciudad de CNNE',
  'Número de teléfono de CNNE',
  'Código postal de CNNE',
  'Nombre del país CNEE',
  'Código de país de CNNE',
  'Peso',
  'Unidad de peso',
  'Descripción del Producto',
  'Código HS',
  'Precio unitario declarado de las mercancías',
  'Número de productos',
  'Divisa',
  'Valor total declarado',
  'Bulto',
  'N° de pedido del cliente',
  'URL',
];

describe('real manifest headers (MANIFEST_TEST.xlsx)', () => {
  it('resolves all 28 real input headers to a non-null canonical path', () => {
    for (const h of REAL_MANIFEST_HEADERS) {
      expect(resolveHeader(h), `header "${h}" should resolve`).not.toBeNull();
    }
  });

  it('maps the previously-wrong headers to the correct canonical path', () => {
    expect(resolveHeader('Número de teléfono de CNNE')).toBe('consignee.phone');
    expect(resolveHeader('Precio unitario declarado de las mercancías')).toBe('core.unitPrice');
    expect(resolveHeader('Nombre de la ciudad del remitente')).toBe('sender.city');
    expect(resolveHeader('Código de país de CNNE')).toBe('consignee.countryCode');
    expect(resolveHeader('Destinatario (CNNE)')).toBe('consignee.name');
  });

  it('still maps existing layout headers', () => {
    expect(resolveHeader('Fracción arancelaria')).toBe('core.hsCode');
  });
});
