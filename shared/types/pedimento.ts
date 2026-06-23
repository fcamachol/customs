// Full T1 pedimento model — fields from the real Pedimento.pdf (header p.1 + partida anexo).

export interface ImporterFiscal {            // Datos del importador
  rfc: string;
  curp?: string;
  name: string;
  fiscalAddress: string;
}

export interface AgentIdentity {             // Cierre / agente aduanal
  patente: string;
  name: string;
  agentRfc: string;
  agencyRfc: string;
  curp?: string;
  certificateSerial?: string;
}

export interface PaymentBlock {              // Línea de captura / depósito referenciado
  lineaCaptura?: string;
  bank?: string;
  bankOperationNumber?: string;
  satTransactionNumber?: string;
  amountPaidMxn?: number;
  paymentDate?: string;                      // YYYY-MM-DD
  presentationMethod?: string;
}

export interface Incrementables {
  seguros?: number; fletes?: number; embalajes?: number; otros?: number;
}
export interface Decrementables {
  transporte?: number; seguro?: number; carga?: number; descarga?: number; otros?: number;
}

export interface TransportTriad {            // Medios de transporte
  entrada: string;                           // e.g. '4'
  arribo: string;                            // e.g. '4'
  salida: string;                            // e.g. '7'
}

export interface PedimentoHeader {
  numeroPedimento: string;                   // 15-digit
  clave: 'T1';
  regimen: 'IMD';
  destino: '9';
  tipoCambio: number;                        // e.g. 20.4568 — ON the pedimento
  pesoBrutoKg: number;                       // aggregate
  totalBultos: number;                       // aggregate
  valorDolares: number;
  valorAduana: number;
  precioPagado: number;
  customsEntryCode: string;                  // aduana entrada
  customsClearanceCode: string;              // aduana despacho
  transport: TransportTriad;
  entryDate: string;                         // fecha de entrada
  paymentDate: string;                       // fecha de pago
  coveAcuseValor?: string;                   // COVE / número de acuse de valor
  incoterm?: string;                         // DDP
  vinculacion?: boolean;
  masterGuide?: string;                      // no. guía / orden embarque
  identifiers: Record<string, string>;       // SO/CR/EM/ED → value
  observations: string;                      // mandatory pedimento-level legal text
  importer: ImporterFiscal;
  agent: AgentIdentity;
  payment: PaymentBlock;
  incrementables?: Incrementables;
  decrementables?: Decrementables;
}

export interface PedimentoPartida {
  secuencia: number;
  fraccion: string;                          // 9901.00.01 → '99010001'
  numIdentificacionComercial?: string;       // '00'
  vinc?: string;                             // '0'
  metVal?: string;                           // '1'
  umc: string; cantidadUmc: number;
  umt?: string; cantidadUmt?: number;
  paisVendedor: string;                      // P. V/C
  paisOrigenDestino: string;                 // P. O/D
  description: string;
  valorAduanaUsd: number;
  precioPagado?: number;
  precioUnitario?: number;
  valorAgregado?: number;
  marca?: string; modelo?: string; codigoProducto?: string;
  noms?: string[];                           // NOM citations
  identifiers?: string[];                    // EP/EN/XP + codes
  contribuciones: { concepto: string; tasa: number; importe: number }[];
  observation: string;                       // GUIA … VALOR … USD NOMBRE … RFC-CURP …
  /**
   * F13: entity key for this consignee (set by `buildPedimento` via `entityKey()`).
   * Optional so already-persisted pedimentos without this field still parse correctly.
   * The prevalidator falls back to parsing the RFC-CURP segment from `observation`,
   * then `seq:<secuencia>`, so both new and legacy pedimentos aggregate correctly.
   */
  consigneeKey?: string;
}

export interface Pedimento {
  header: PedimentoHeader;
  partidas: PedimentoPartida[];
}
