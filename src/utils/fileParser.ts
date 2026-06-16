/**
 * T1 Manifest File Parser
 *
 * Parses Excel (.xlsx/.xls), CSV, and JSON files into T1Shipment objects.
 * Enhanced for real T1 pedimento requirements:
 *   - Consignee RFC capture
 *   - Origin country detection
 *   - Transport mode detection
 *   - MAWB reference extraction
 *   - Auto-assignment of generic HS codes
 */

import * as XLSX from 'xlsx';
import { T1Shipment, TransportMode } from '../types/t1';
import { assignGenericHsCode } from '../constants/genericHscodes';
import { detectRRNA } from '../engine/rrnaDetector';
import { normalizeCountryCode, generateShipmentId } from '../utils/formatters';

// ============================================================================
// Column Header Synonyms (multilingual: ES / EN)
// ============================================================================

const HEADER_SYNONYMS = {
  guideId: ['guia', 'guía', 'id', 'guideid', 'ref', 'referencia', 'num', 'numero', 'nro', 'guide', 'guide_id', 'no_guia', 'tracking', 'awb', 'airway_bill'],
  consigneeName: ['consignee', 'consignatario', 'destinatario', 'cliente', 'cliente_nombre', 'razon_social', 'razonSocial', 'importer', 'importador', 'receiver', 'recipient', 'nombre'],
  consigneeRfc: ['rfc', 'consignee_rfc', 'destinatario_rfc', 'cliente_rfc', 'tax_id', 'taxid', 'rfc_destinatario'],
  description: ['desc', 'description', 'descripcion', 'descripción', 'mercancia', 'mercancía', 'producto', 'product', 'item', 'goods', 'contenido'],
  declaredValueUsd: ['value', 'declaredvalue', 'valor', 'monto', 'usd', 'valor_usd', 'declared_value', 'valordeclarado', 'precio', 'amount', 'cost'],
  quantity: ['qty', 'quantity', 'cantidad', 'cant', 'pzas', 'piezas', 'unidades', 'units', 'bultos', 'bulto', 'pcs'],
  unit: ['unit', 'unidad', 'uom', 'um', 'medida', 'unidad_medida', 'uom_code', 'measure'],
  weightKg: ['weight', 'peso', 'kg', 'kgs', 'kilogramos', 'weight_kg', 'peso_kg', 'netweight', 'net_weight'],
  originCountry: ['origin', 'pais_origen', 'país_origen', 'country', 'origen', 'pais', 'país', 'source_country', 'from'],
  transportMode: ['mode', 'transporte', 'transport_mode', 'modalidad', 'tipo_transporte', 'via'],
  mawbReference: ['mawb', 'master', 'guia_maestra', 'master_awb', 'mawb_reference', 'master_reference'],
};

// ============================================================================
// Header Matching
// ============================================================================

function findBestHeaderMatch(headers: string[], possibleNames: string[]): string | null {
  const normalizedHeaders = headers.map((h) =>
    h.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  );

  for (const name of possibleNames) {
    const lowerName = name.toLowerCase().trim().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // Exact match
    const exactIdx = normalizedHeaders.indexOf(lowerName);
    if (exactIdx >= 0) return headers[exactIdx];

    // Substring match
    const subIdx = normalizedHeaders.findIndex(
      (h) => h.includes(lowerName) || lowerName.includes(h)
    );
    if (subIdx >= 0) return headers[subIdx];
  }
  return null;
}

function matchHeaders(headers: string[]) {
  const keys = Object.keys(HEADER_SYNONYMS) as (keyof typeof HEADER_SYNONYMS)[];
  const matched: Record<keyof typeof HEADER_SYNONYMS, string | null> = {} as any;

  for (const key of keys) {
    matched[key] = findBestHeaderMatch(headers, HEADER_SYNONYMS[key]);
  }
  return matched;
}

// ============================================================================
// Row Processing
// ============================================================================

function getCellValue(row: Record<string, unknown>, matchedKey: string | null, fallbackKeys: string[]): string {
  if (matchedKey && row[matchedKey] !== undefined) {
    return String(row[matchedKey]).trim();
  }
  for (const key of fallbackKeys) {
    if (row[key] !== undefined) {
      return String(row[key]).trim();
    }
  }
  return '';
}

function getNumberValue(row: Record<string, unknown>, matchedKey: string | null, fallbackKeys: string[]): number {
  const raw = getCellValue(row, matchedKey, fallbackKeys);
  if (!raw) return 0;
  const cleaned = raw.replace(/[^0-9.]/g, '');
  const parsed = parseFloat(cleaned);
  return isNaN(parsed) ? 0 : parsed;
}

function parseTransportMode(value: string): TransportMode {
  const normalized = value.toUpperCase().trim();
  if (normalized.startsWith('AIR') || normalized.startsWith('AER') || normalized === '1') return 'AIR';
  if (normalized.startsWith('LAND') || normalized.startsWith('TER') || normalized.startsWith('ROAD') || normalized === '2') return 'LAND';
  return 'AIR'; // Default
}

function processRow(
  row: Record<string, unknown>,
  matched: Record<keyof typeof HEADER_SYNONYMS, string | null>,
  index: number,
  defaultMawb: string
): T1Shipment {
  const guideId = getCellValue(row, matched.guideId, ['_col_0']);
  const consigneeName = getCellValue(row, matched.consigneeName, ['_col_1']);
  const consigneeRfc = getCellValue(row, matched.consigneeRfc, ['_col_2']);
  const description = getCellValue(row, matched.description, ['_col_3']);
  const declaredValueUsd = getNumberValue(row, matched.declaredValueUsd, ['_col_4']);
  const quantity = getNumberValue(row, matched.quantity, ['_col_5']);
  const unit = getCellValue(row, matched.unit, ['_col_6']) || 'PCE';
  const weightKg = getNumberValue(row, matched.weightKg, ['_col_7']);
  const originCountry = normalizeCountryCode(getCellValue(row, matched.originCountry, ['_col_8']) || 'US');
  const transportMode = parseTransportMode(getCellValue(row, matched.transportMode, ['_col_9']));
  const mawbReference = getCellValue(row, matched.mawbReference, ['_col_10']) || defaultMawb;

  const shipment: T1Shipment = {
    id: generateShipmentId(),
    guideId: guideId || `GUIA-${String(90800 + index).padStart(5, '0')}`,
    mawbReference,
    consigneeName: consigneeName || `Consignatario ${index + 1}`,
    consigneeRfc: consigneeRfc || 'XAXX010101000',
    description: description || 'Mercancía General',
    declaredValueUsd,
    quantity: quantity || 1,
    unit: unit.toUpperCase(),
    weightKg: weightKg > 0 ? weightKg : (quantity || 1) * 0.25,
    originCountry,
    transportMode,
    status: 'PENDING',
    genericHsCode: assignGenericHsCode(unit),
    rrnaFlags: [],
  };

  // Run RRNA detection
  shipment.rrnaFlags = detectRRNA(shipment);
  if (shipment.rrnaFlags.length > 0) {
    shipment.status = 'RRNA_BLOCKED';
  }

  // Value threshold check
  if (shipment.declaredValueUsd > 2500) {
    shipment.status = 'EXCEEDS_THRESHOLD';
  }

  return shipment;
}

// ============================================================================
// File Parsers
// ============================================================================

export async function parseManifestFile(file: File): Promise<{
  shipments: T1Shipment[];
  mawbReference: string;
}> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  if (extension === 'json') {
    return parseJSONFile(file);
  } else if (extension === 'csv') {
    return parseCSVFile(file);
  } else if (extension === 'xlsx' || extension === 'xls') {
    return parseExcelFile(file);
  } else {
    return parseCSVFile(file);
  }
}

async function parseJSONFile(file: File): Promise<{ shipments: T1Shipment[]; mawbReference: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);

        let rawRows: unknown[] = [];
        if (Array.isArray(data)) {
          rawRows = data;
        } else if (typeof data === 'object' && data !== null) {
          const keys = ['records', 'items', 'data', 'guias', 'rows', 'manifests', 'shipments'];
          const foundKey = keys.find((k) => Array.isArray((data as Record<string, unknown>)[k]));
          if (foundKey) {
            rawRows = (data as Record<string, unknown>)[foundKey] as unknown[];
          } else {
            rawRows = [data];
          }
        }

        const mawbRef = (data as Record<string, unknown>)?.mawbReference as string ||
                        (data as Record<string, unknown>)?.mawb as string ||
                        `MAWB-${Date.now().toString().slice(-8)}`;

        const result = processRawRows(rawRows, mawbRef);
        resolve(result);
      } catch {
        reject(new Error('Error al analizar el archivo JSON: formato inválido.'));
      }
    };
    reader.onerror = () => reject(new Error('Error de lectura de archivo.'));
    reader.readAsText(file);
  });
}

function parseCSVFile(file: File): Promise<{ shipments: T1Shipment[]; mawbReference: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length === 0) throw new Error('El archivo CSV está vacío.');

        // Detect delimiter
        const firstLine = lines[0];
        const commas = (firstLine.match(/,/g) || []).length;
        const semicolons = (firstLine.match(/;/g) || []).length;
        const tabs = (firstLine.match(/\t/g) || []).length;
        let delimiter = ',';
        if (semicolons > commas && semicolons > tabs) delimiter = ';';
        else if (tabs > commas && tabs > semicolons) delimiter = '\t';

        const parseCSVRow = (rowText: string): string[] => {
          const cells: string[] = [];
          let currentCell = '';
          let insideQuotes = false;
          for (let i = 0; i < rowText.length; i++) {
            const char = rowText[i];
            if (char === '"') {
              insideQuotes = !insideQuotes;
            } else if (char === delimiter && !insideQuotes) {
              cells.push(currentCell.trim());
              currentCell = '';
            } else {
              currentCell += char;
            }
          }
          cells.push(currentCell.trim());
          return cells;
        };

        const headers = parseCSVRow(lines[0]).map((h) => h.replace(/^"|"$/g, '').trim());
        const rawRows: Record<string, unknown>[] = [];

        for (let i = 1; i < lines.length; i++) {
          const cells = parseCSVRow(lines[i]).map((c) => c.replace(/^"|"$/g, '').trim());
          if (cells.length === 0 || (cells.length === 1 && cells[0] === '')) continue;

          const rowObj: Record<string, unknown> = {};
          headers.forEach((header, colIndex) => {
            rowObj[header] = cells[colIndex] || '';
            rowObj[`_col_${colIndex}`] = cells[colIndex] || '';
          });
          rawRows.push(rowObj);
        }

        const mawbRef = `MAWB-${Date.now().toString().slice(-8)}`;
        const result = processRawRows(rawRows, mawbRef);
        resolve(result);
      } catch (err) {
        reject(new Error('Error al analizar el archivo CSV.'));
      }
    };
    reader.onerror = () => reject(new Error('Error de lectura de archivo.'));
    reader.readAsText(file);
  });
}

function parseExcelFile(file: File): Promise<{ shipments: T1Shipment[]; mawbReference: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' }) as Record<string, unknown>[];

        const mawbRef = `MAWB-${Date.now().toString().slice(-8)}`;
        const result = processRawRows(rawRows, mawbRef);
        resolve(result);
      } catch {
        reject(new Error('Error al procesar el archivo Excel. Asegúrese de que no esté corrupto.'));
      }
    };
    reader.onerror = () => reject(new Error('Error de lectura de archivo.'));
    reader.readAsArrayBuffer(file);
  });
}

// ============================================================================
// Raw Row Processing
// ============================================================================

function processRawRows(
  rawRows: unknown[],
  defaultMawb: string
): { shipments: T1Shipment[]; mawbReference: string } {
  if (rawRows.length === 0) {
    return { shipments: [], mawbReference: defaultMawb };
  }

  const sampleRow = rawRows[0] as Record<string, unknown>;
  const headers = Object.keys(sampleRow).filter((k) => !k.startsWith('_col_'));
  const matched = matchHeaders(headers);

  const shipments: T1Shipment[] = rawRows.map((row, index) =>
    processRow(row as Record<string, unknown>, matched, index, defaultMawb)
  );

  return { shipments, mawbReference: defaultMawb };
}
