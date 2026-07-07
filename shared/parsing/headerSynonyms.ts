// Maps a raw spreadsheet header (any casing/accents) to a canonical path.
const TABLE: Record<string, string> = {
  'no de registro t1': 'core.t1RegistryId',
  'patente': 'core.patente',
  'no pedimento': 'core.pedimentoNumber',
  'descripcion de la mercancia': 'core.description',
  'fraccion arancelaria': 'core.hsCode',
  'cantidad de la mercancia': 'core.quantity',
  'unidad de medida': 'core.unit',
  'valor en aduana declarado': 'core.customsValueUsd',
  'moneda': 'core.currency',
  'pais de procedencia': 'core.procedenceCountry',
  'fecha de arribo a territorio nacional': 'core.arrivalDate',
  'no de guia aerea o documento de transporte': 'core.guideId',
  'tasa global o cuota aplicada': 'core.appliedRate',
  'regulaciones y restricciones no arancelarias': 'core.rrnaNote',
  'clave de aduana de entrada': 'core.customsEntryCode',
  'clave de aduana de despacho': 'core.customsClearanceCode',
  'nombre denominacion o razon social': 'consignee.name',
  'rfc': 'consignee.rfc',
  'curp': 'consignee.curp',
  'id fiscal de pais de residencia': 'consignee.foreignTaxId',
  'no de seguridad social': 'consignee.socialSecurity',
  'no de pasaporte': 'consignee.passport',
  'domicilio': 'consignee.address',
  'telefono': 'consignee.phone',
  'correo electronico': 'consignee.email',
  'remitente nombre': 'sender.name',
  'id fiscal del remitente': 'sender.taxId',
  'remitente domicilio': 'sender.address',
  'remitente telefono': 'sender.phone',
  'remitente correo': 'sender.email',
  'nombre comercial': 'platform.commercialName',
  'pais de origen': 'platform.countryOfOrigin',
  'denominacion o razon social': 'platform.legalName',
  'plataforma correo': 'platform.email',
  // --- real input-manifest headers (MANIFEST_TEST.xlsx, 28 columns) ---
  'mwb': 'core.mawb',
  'numero de guia de embarque': 'core.guideId',
  'expedidor': 'sender.name',
  'direccion del remitente': 'sender.address',
  'nombre de la ciudad del remitente': 'sender.city',
  'codigo de ciudad del remitente': 'sender.cityCode',
  'nombre del pais del remitente': 'sender.countryName',
  'codigo de pais del remitente': 'sender.countryCode',
  'id': 'consignee.taxId', // generic ID — classified (RFC vs CURP) & routed at parse time
  'destinatario cnne': 'consignee.name',
  'email': 'consignee.email',
  'direccion de cnne': 'consignee.address',
  'nombre de la ciudad de cnne': 'consignee.city',
  'numero de telefono de cnne': 'consignee.phone',
  'codigo postal de cnne': 'consignee.postalCode',
  // Source typo: header reads "CNEE" (not CNNE) — mapped as-is on purpose.
  'nombre del pais cnee': 'consignee.countryName',
  'codigo de pais de cnne': 'consignee.countryCode',
  'peso': 'core.weight',
  'unidad de peso': 'core.weightUnit',
  'descripcion del producto': 'core.description',
  'codigo hs': 'core.hsCode',
  'precio unitario declarado de las mercancias': 'core.unitPrice',
  'numero de productos': 'core.quantity',
  'divisa': 'core.currency',
  'valor total declarado': 'core.customsValueUsd',
  'bulto': 'core.bulto',
  'n de pedido del cliente': 'core.clientOrderId',
  'url': 'platform.url',
};

export function normalize(h: string): string {
  return h
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Distinct canonical paths the static table can produce — the option set for the per-client
// mapping UI (a spreadsheet header may only be mapped onto one of these known paths).
export const CANONICAL_PATHS: string[] = [...new Set(Object.values(TABLE))].sort();

// Resolve a raw header to a canonical path. `extra` is an optional per-client override table keyed
// by the NORMALIZED header (normalize()); it is consulted BEFORE the static table so a client's
// saved mapping wins over any built-in synonym. Zero-arg behavior is identical to the static table.
export function resolveHeader(raw: string, extra?: Record<string, string>): string | null {
  const n = normalize(raw);
  if (extra && n in extra) return extra[n];
  return TABLE[n] ?? null;
}
