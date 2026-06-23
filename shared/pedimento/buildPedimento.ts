import type { Shipment } from '../types/shipment';
import type { Pedimento, PedimentoHeader, PedimentoPartida } from '../types/pedimento';
import { partidaObservation } from './observation';

export interface BuildOptions {
  numeroPedimento: string;
  importer: PedimentoHeader['importer'];
  agent: PedimentoHeader['agent'];
  tipoCambio: number;
  customsEntryCode: string;
  customsClearanceCode: string;
  entryDate: string;
  paymentDate: string;
  observations?: string;
}

const DEFAULT_OBS =
  'De conformidad con las reglas 1.6.29, 3.1.8 y 3.7.5 de las RGCE. ' +
  'Mercancía exenta de NOM conforme a regla aplicable. Ver manifiesto / guía master.';

export function buildPedimento(shipments: Shipment[], opts: BuildOptions): Pedimento {
  const partidas: PedimentoPartida[] = shipments.map((s, idx) => ({
    secuencia: idx + 1,
    fraccion: s.hsCode.replace(/\./g, ''),
    umc: s.unit || '6', cantidadUmc: s.quantity || 1,
    paisVendedor: s.originCountry, paisOrigenDestino: s.originCountry,
    description: s.description,
    valorAduanaUsd: s.customsValueUsd,
    precioPagado: s.customsValueUsd,
    // T1/IMD pedimentos must carry no contributions (regla de no contribución)
    contribuciones: [],
    observation: partidaObservation({
      guideId: s.guideId, valueUsd: s.customsValueUsd,
      consigneeName: s.consignee.name, id: (s.consignee.curp ?? s.consignee.rfc),
    }),
  }));

  const valorDolares = shipments.reduce((a, s) => a + s.customsValueUsd, 0);
  const valorAduana = Math.round(valorDolares * opts.tipoCambio * 100) / 100;

  const header: PedimentoHeader = {
    numeroPedimento: opts.numeroPedimento, clave: 'T1', regimen: 'IMD', destino: '9',
    tipoCambio: opts.tipoCambio,
    pesoBrutoKg: shipments.reduce((a, s) => a + (Number((s as any).weightKg) || 0), 0),
    totalBultos: shipments.length,
    valorDolares, valorAduana, precioPagado: valorAduana,
    customsEntryCode: opts.customsEntryCode, customsClearanceCode: opts.customsClearanceCode,
    transport: { entrada: '4', arribo: '4', salida: '7' },
    entryDate: opts.entryDate, paymentDate: opts.paymentDate,
    identifiers: { EM: '143' },
    observations: opts.observations ?? DEFAULT_OBS,
    importer: opts.importer, agent: opts.agent, payment: {},
  };

  return { header, partidas };
}
