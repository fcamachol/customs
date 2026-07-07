// LayOut_sistema — 35-column flat register (cols 31–35 = Plataforma block incl. URL).
import type { Shipment } from '../types/shipment';
import { GENERIC_T1_FRACTION_LAYOUT } from '../pedimento/fraction';

export const LAYOUT_HEADERS = [
  'No. de registro T1', 'Patente AA', 'No. pedimento', 'Descripción de la mercancía',
  'Fracción arancelaria', 'Cantidad de la mercancía', 'Unidad de medida', 'Valor en Aduana declarado',
  'Moneda', 'País de procedencia', 'Fecha de arribo a territorio nacional', 'No. de guía aérea',
  'Tasa global o cuota aplicada', 'Regulaciones y restricciones no arancelarias',
  'Clave de Aduana de entrada', 'Clave de Aduana de despacho',
  'Consignatario Nombre/razón social', 'Consignatario RFC', 'Consignatario CURP',
  'Consignatario ID Fiscal país residencia', 'Consignatario No. Seguridad Social',
  'Consignatario No. pasaporte', 'Consignatario Domicilio', 'Consignatario Teléfono', 'Consignatario Correo',
  'Remitente Nombre/razón social', 'Remitente Id fiscal', 'Remitente Domicilio', 'Remitente Teléfono', 'Remitente Correo',
  'Plataforma Nombre comercial', 'Plataforma País de origen', 'Plataforma Razón social', 'Plataforma Correo', 'Plataforma URL',
] as const;

export function toLayoutRows(shipments: Shipment[]): Record<string, string>[] {
  return shipments.map((s) => {
    const v = [
      s.t1RegistryId ?? '', s.patente ?? '', s.pedimentoNumber ?? '', s.description,
      GENERIC_T1_FRACTION_LAYOUT, String(s.quantity), 'PCS', String(s.customsValueUsd),
      // País de procedencia = código de país del remitente del manifiesto (shipped-from), not the
      // manufactured-in país de origen. Falls back to originCountry for manifests without sender.
      s.currency, s.procedenceCountry || s.originCountry, s.arrivalDate ?? '', s.guideId,
      s.appliedRate != null ? String(s.appliedRate) : '', 'N/A',
      s.customsEntryCode ?? '', s.customsClearanceCode ?? '',
      s.consignee.name, s.consignee.rfc, s.consignee.curp ?? '',
      s.consignee.foreignTaxId ?? '', s.consignee.socialSecurity ?? '',
      s.consignee.passport ?? '', s.consignee.address ?? '', s.consignee.phone ?? '', s.consignee.email ?? '',
      s.sender.name, s.sender.taxId ?? '', s.sender.address ?? '', s.sender.phone ?? '', s.sender.email ?? '',
      s.platform.commercialName, s.platform.countryOfOrigin ?? '', s.platform.legalName ?? '', s.platform.email ?? '', s.platform.url ?? '',
    ];
    return Object.fromEntries(LAYOUT_HEADERS.map((h, i) => [h, v[i]]));
  });
}
