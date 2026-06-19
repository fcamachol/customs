import { describe, expect, it } from 'vitest';
import { resolveHeader } from './headerSynonyms';

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

describe('real manifest headers', () => {
  it('maps the 28 MANIFEST_TEST input headers', () => {
    expect(resolveHeader('MWB')).toBe('core.mawb');
    expect(resolveHeader('Número de guía de embarque')).toBe('core.guideId');
    expect(resolveHeader('Destinatario (CNNE)')).toBe('consignee.name');
    expect(resolveHeader('ID')).toBe('consignee.rfc');
    expect(resolveHeader('Email')).toBe('consignee.email');
    expect(resolveHeader('Dirección de CNNE')).toBe('consignee.address');
    expect(resolveHeader('Teléfono de CNNE')).toBe('consignee.phone');
    expect(resolveHeader('Peso')).toBe('core.weight');
    expect(resolveHeader('Unidad de peso')).toBe('core.weightUnit');
    expect(resolveHeader('Descripción del Producto')).toBe('core.description');
    expect(resolveHeader('Código HS')).toBe('core.hsCode');
    expect(resolveHeader('Precio unitario declarado')).toBe('core.unitPrice');
    expect(resolveHeader('Número de productos')).toBe('core.quantity');
    expect(resolveHeader('Divisa')).toBe('core.currency');
    expect(resolveHeader('Valor total declarado')).toBe('core.customsValueUsd');
    expect(resolveHeader('Expedidor')).toBe('sender.name');
    expect(resolveHeader('Dirección del remitente')).toBe('sender.address');
    expect(resolveHeader('Nombre/Código de país del remitente')).toBe('sender.countryCode');
    expect(resolveHeader('Bulto')).toBe('core.bulto');
    expect(resolveHeader('URL')).toBe('platform.url');
  });
  it('still maps existing layout headers', () => {
    expect(resolveHeader('Fracción arancelaria')).toBe('core.hsCode');
  });
});
