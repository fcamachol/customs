/**
 * Formatters — RFC, Pedimento, and customs document formatting utilities
 */

/**
 * Validate a Mexican RFC (Registro Federal de Contribuyentes).
 * Supports both 12-character (moral person) and 13-character (physical person) formats.
 */
export function isValidRFC(rfc: string): boolean {
  if (!rfc) return false;
  const cleaned = rfc.trim().toUpperCase();
  return /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/.test(cleaned);
}

/**
 * Format an RFC with standard spacing (optional).
 */
export function formatRFC(rfc: string): string {
  if (!rfc) return '';
  return rfc.trim().toUpperCase();
}

/**
 * Validate a 15-digit pedimento number format.
 * Format: AA AA AAAA NNNNNNN (e.g., "24 12 3004 0001854")
 */
export function isValidPedimento(pedimento: string): boolean {
  if (!pedimento) return false;
  const cleaned = pedimento.replace(/\s/g, '');
  return /^\d{15}$/.test(cleaned);
}

/**
 * Format a pedimento number with spaces for readability.
 */
export function formatPedimento(pedimento: string): string {
  if (!pedimento) return '';
  const cleaned = pedimento.replace(/\s/g, '');
  if (cleaned.length !== 15) return cleaned;
  return `${cleaned.slice(0, 2)} ${cleaned.slice(2, 4)} ${cleaned.slice(4, 8)} ${cleaned.slice(8)}`;
}

/**
 * Generate a valid 15-digit pedimento number.
 * Format: YY MM AAAA NNNNNNN
 */
export function generatePedimentoNumber(): string {
  const now = new Date();
  const year = now.getFullYear().toString().slice(-2);
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const aduana = '3004'; // Default: AICM
  const serial = String(Math.floor(Math.random() * 9999999)).padStart(7, '0');
  return `${year} ${month} ${aduana} ${serial}`;
}

/**
 * Format a currency value in USD.
 */
export function formatUSD(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
  }).format(value);
}

/**
 * Format a currency value in MXN.
 */
export function formatMXN(value: number): string {
  return new Intl.NumberFormat('es-MX', {
    style: 'currency',
    currency: 'MXN',
    minimumFractionDigits: 2,
  }).format(value);
}

/**
 * Format a date in Mexican Spanish format.
 */
export function formatDateMX(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toLocaleDateString('es-MX', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
}

/**
 * Format a date-time in SAT format (YYYY-MM-DD HH:mm:ss).
 */
export function formatDateTimeSAT(date: Date | string): string {
  const d = typeof date === 'string' ? new Date(date) : date;
  return d.toISOString().replace('T', ' ').substring(0, 19);
}

/**
 * Generate a stable UUID-like ID for shipments.
 */
export function generateShipmentId(): string {
  return `ship_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Normalize country code to ISO alpha-2.
 */
export function normalizeCountryCode(code: string): string {
  const mapping: Record<string, string> = {
    US: 'US',
    USA: 'US',
    'UNITED STATES': 'US',
    'ESTADOS UNIDOS': 'US',
    CA: 'CA',
    CAN: 'CA',
    CANADA: 'CA',
    CN: 'CN',
    CHN: 'CN',
    CHINA: 'CN',
    MX: 'MX',
    MEX: 'MX',
    MEXICO: 'MX',
    'MÉXICO': 'MX',
    JP: 'JP',
    JPN: 'JP',
    JAPAN: 'JP',
    KR: 'KR',
    KOR: 'KR',
    'KOREA': 'KR',
    DE: 'DE',
    DEU: 'DE',
    GERMANY: 'DE',
    GB: 'GB',
    GBR: 'GB',
    'UNITED KINGDOM': 'GB',
    FR: 'FR',
    FRA: 'FR',
    FRANCE: 'FR',
    IN: 'IN',
    IND: 'IN',
    INDIA: 'IN',
    HK: 'HK',
    HKG: 'HK',
    'HONG KONG': 'HK',
    TW: 'TW',
    TWN: 'TW',
    TAIWAN: 'TW',
  };
  return mapping[code.toUpperCase().trim()] || code.toUpperCase().trim().slice(0, 2);
}

/**
 * Get full country name from code.
 */
export function getCountryName(code: string): string {
  const mapping: Record<string, string> = {
    US: 'Estados Unidos',
    CA: 'Canadá',
    CN: 'China',
    MX: 'México',
    JP: 'Japón',
    KR: 'Corea del Sur',
    DE: 'Alemania',
    GB: 'Reino Unido',
    FR: 'Francia',
    IN: 'India',
    HK: 'Hong Kong',
    TW: 'Taiwán',
  };
  return mapping[code.toUpperCase()] || code.toUpperCase();
}
