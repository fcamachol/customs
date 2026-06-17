import { describe, it, expect } from 'vitest';
import type { Pedimento } from './pedimento';

describe('pedimento type', () => {
  it('accepts a fully-populated object', () => {
    const p: Pedimento = {
      header: {
        numeroPedimento: '258516535001684', clave: 'T1', regimen: 'IMD', destino: '9',
        tipoCambio: 20.4568, pesoBrutoKg: 808, totalBultos: 34,
        valorDolares: 21592.68, valorAduana: 441717, precioPagado: 441717,
        customsEntryCode: '4', customsClearanceCode: '850',
        transport: { entrada: '4', arribo: '4', salida: '7' },
        entryDate: '2025-04-04', paymentDate: '2025-04-05',
        identifiers: { EM: '143' }, observations: 'RGCE 3.7.5 ...',
        importer: { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' },
        agent: { patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' },
        payment: { lineaCaptura: '0325 01FM XKP1 4561 1258' },
      },
      partidas: [],
    };
    expect(p.header.clave).toBe('T1');
  });
});
