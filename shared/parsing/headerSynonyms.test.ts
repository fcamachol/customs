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
