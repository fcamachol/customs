import * as XLSX from 'xlsx';
import { ParsingRecord, GuideRecord, RiskLevel } from '../types';

/**
 * Intelligent helper to score key match for column headers in multilanguage formats (ES/EN)
 */
function findBestHeaderMatch(headers: string[], possibleNames: string[]): string | null {
  for (const name of possibleNames) {
    const lowerName = name.toLowerCase().trim();
    // 1. Exact match
    const exactMatch = headers.find(h => h.toLowerCase().trim() === lowerName);
    if (exactMatch) return exactMatch;

    // 2. Substring match
    const subMatch = headers.find(h => {
      const normalizedH = h.toLowerCase().trim()
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, ""); // strip accents
      const normalizedName = lowerName
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "");
      return normalizedH.includes(normalizedName) || normalizedName.includes(normalizedH);
    });
    if (subMatch) return subMatch;
  }
  return null;
}

/**
 * Parses any uploaded File object (Excel xlsx/xls, CSV, or JSON)
 * Returns a list of parsed records both in ParsingRecord shape and GuideRecord shape.
 */
export async function parseManifestFile(file: File): Promise<{
  parsingRecords: ParsingRecord[];
  guideRecords: GuideRecord[];
}> {
  const extension = file.name.split('.').pop()?.toLowerCase();

  if (extension === 'json') {
    return parseJSONFile(file);
  } else if (extension === 'csv') {
    return parseCSVFile(file);
  } else if (extension === 'xlsx' || extension === 'xls') {
    return parseExcelFile(file);
  } else {
    // Treat everything else as potential CSV / text
    return parseCSVFile(file);
  }
}

async function parseJSONFile(file: File): Promise<{
  parsingRecords: ParsingRecord[];
  guideRecords: GuideRecord[];
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        const data = JSON.parse(text);
        
        let rawRows: any[] = [];
        if (Array.isArray(data)) {
          rawRows = data;
        } else if (typeof data === 'object' && data !== null) {
          // If JSON contains a key like "records", "items", "data", "guias", inspect those
          const keys = ['records', 'items', 'data', 'guias', 'rows', 'manifests'];
          const foundKey = keys.find(k => Array.isArray(data[k]));
          if (foundKey) {
            rawRows = data[foundKey];
          } else {
            rawRows = [data]; // single object
          }
        }

        const result = processRawRows(rawRows);
        resolve(result);
      } catch (err) {
        reject(new Error("Error al analizar el archivo JSON: formato inválido."));
      }
    };
    reader.onerror = () => reject(new Error("Error de lectura de archivo."));
    reader.readAsText(file);
  });
}

function parseCSVFile(file: File): Promise<{
  parsingRecords: ParsingRecord[];
  guideRecords: GuideRecord[];
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const text = e.target?.result as string;
        // Split by lines, filtering out empty ones
        const lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
        if (lines.length === 0) {
          throw new Error("El archivo CSV está vacío.");
        }

        // Detect delimiter (comma, semicolon, tab)
        const firstLine = lines[0];
        let delimiter = ',';
        const commas = (firstLine.match(/,/g) || []).length;
        const semicolons = (firstLine.match(/;/g) || []).length;
        const tabs = (firstLine.match(/\t/g) || []).length;
        if (semicolons > commas && semicolons > tabs) {
          delimiter = ';';
        } else if (tabs > commas && tabs > semicolons) {
          delimiter = '\t';
        }

        // Helper to parse CSV row correctly considering quotes
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

        const headers = parseCSVRow(lines[0]).map(h => h.replace(/^"|"$/g, '').trim());
        const rawRows: any[] = [];

        for (let i = 1; i < lines.length; i++) {
          const cells = parseCSVRow(lines[i]).map(c => c.replace(/^"|"$/g, '').trim());
          if (cells.length === 0 || (cells.length === 1 && cells[0] === "")) continue;

          const rowObj: any = {};
          headers.forEach((header, colIndex) => {
            rowObj[header] = cells[colIndex] || "";
            // Also store index references just in case headers are wonky
            rowObj[`_col_${colIndex}`] = cells[colIndex] || "";
          });
          rawRows.push(rowObj);
        }

        const result = processRawRows(rawRows, headers);
        resolve(result);
      } catch (err) {
        reject(new Error("Error al analizar el archivo CSV."));
      }
    };
    reader.onerror = () => reject(new Error("Error de lectura de archivo."));
    reader.readAsText(file);
  });
}

function parseExcelFile(file: File): Promise<{
  parsingRecords: ParsingRecord[];
  guideRecords: GuideRecord[];
}> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer);
        const workbook = XLSX.read(data, { type: 'array' });
        
        // Grab the first sheet
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        
        // Convert to array of arrays or json objects
        const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: "" });
        
        // Extract headers from sheet range to assist matching if needed
        const headers: string[] = [];
        const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:A1');
        for (let C = range.s.c; C <= range.e.c; ++C) {
          const address = XLSX.utils.encode_cell({ r: range.s.r, c: C });
          const cell = sheet[address];
          if (cell && cell.v) headers.push(String(cell.v));
        }

        const result = processRawRows(rawRows, headers);
        resolve(result);
      } catch (err) {
        reject(new Error("Error al procesar el archivo Excel. Asegúrese de que no esté corrupto."));
      }
    };
    reader.onerror = () => reject(new Error("Error de lectura de archivo."));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Normalizes and processes raw rows extracted from Excel/CSV/JSON
 */
function processRawRows(rawRows: any[], headerNames: string[] = []): {
  parsingRecords: ParsingRecord[];
  guideRecords: GuideRecord[];
} {
  const parsingRecords: ParsingRecord[] = [];
  const guideRecords: GuideRecord[] = [];

  // Try to find matching headers
  let sampleRow: any = rawRows[0] || {};
  let keys = Object.keys(sampleRow);

  // Synonyms mapping
  const idSynonyms = ['guia', 'guía', 'id', 'manifestid', 'ref', 'referencia', 'num', 'numero', 'nro', 'guide', 'guideid', 'manifest_id', 'no_guia'];
  const htsSynonyms = ['hscode', 'hts', 'fraccion', 'fracción', 'arancel', 'codigo', 'código', 'hts_code', 'fraccion_arancelaria'];
  const descSynonyms = ['desc', 'description', 'descripcion', 'descripción', 'mercancia', 'mercancía', 'producto', 'product', 'item'];
  const qtySynonyms = ['qty', 'quantity', 'cantidad', 'cant', 'pzas', 'piezas', 'unidades', 'units', 'bultos', 'bulto'];
  const unitSynonyms = ['unit', 'unidad', 'uom', 'um', 'medida', 'unidad_medida'];
  const weightSynonyms = ['weight', 'peso', 'kg', 'kgs', 'kilogramos', 'weight_kg', 'peso_kg', 'netweight'];
  const importerSynonyms = ['importer', 'importador', 'cliente', 'cliente_nombre', 'razon_social', 'razonSocial', 'importername', 'destinatario'];
  const valSynonyms = ['value', 'declaredvalue', 'valor', 'monto', 'usd', 'valor_usd', 'declared_value', 'valordeclarado', 'precio'];

  const matchedKeys = {
    id: findBestHeaderMatch(keys, idSynonyms) || findBestHeaderMatch(headerNames, idSynonyms),
    hts: findBestHeaderMatch(keys, htsSynonyms) || findBestHeaderMatch(headerNames, htsSynonyms),
    desc: findBestHeaderMatch(keys, descSynonyms) || findBestHeaderMatch(headerNames, descSynonyms),
    qty: findBestHeaderMatch(keys, qtySynonyms) || findBestHeaderMatch(headerNames, qtySynonyms),
    unit: findBestHeaderMatch(keys, unitSynonyms) || findBestHeaderMatch(headerNames, unitSynonyms),
    weight: findBestHeaderMatch(keys, weightSynonyms) || findBestHeaderMatch(headerNames, weightSynonyms),
    importer: findBestHeaderMatch(keys, importerSynonyms) || findBestHeaderMatch(headerNames, importerSynonyms),
    value: findBestHeaderMatch(keys, valSynonyms) || findBestHeaderMatch(headerNames, valSynonyms),
  };

  rawRows.forEach((row, i) => {
    // 1. Recover values with key lookup, index lookup, or defaults
    let manifestId = '';
    if (matchedKeys.id && row[matchedKeys.id] !== undefined) {
      manifestId = String(row[matchedKeys.id]).trim();
    } else if (row['_col_0'] !== undefined) {
      manifestId = String(row['_col_0']).trim();
    }
    if (!manifestId) {
      manifestId = `GUIA-USR-${90800 + i}`;
    }

    let hsCode = '8517.13.01'; // DEFAULT
    if (matchedKeys.hts && row[matchedKeys.hts] !== undefined) {
      hsCode = String(row[matchedKeys.hts]).trim();
    } else if (row['_col_1'] !== undefined) {
      hsCode = String(row['_col_1']).trim();
    }
    // format HSCode (e.g., ensure dots or normalize clean digits)
    hsCode = hsCode.replace(/[^0-9.]/g, '');
    if (hsCode.length === 8 && !hsCode.includes('.')) {
      // Format as XX.XX.XX.XX or similar if 8 digits
      hsCode = `${hsCode.slice(0, 4)}.${hsCode.slice(4, 6)}.${hsCode.slice(6, 8)}`;
    }

    let description = 'Mercancías Generales';
    if (matchedKeys.desc && row[matchedKeys.desc] !== undefined) {
      description = String(row[matchedKeys.desc]).trim();
    } else if (row['_col_2'] !== undefined) {
      description = String(row['_col_2']).trim();
    }

    let quantity = 1;
    if (matchedKeys.qty && row[matchedKeys.qty] !== undefined) {
      quantity = parseInt(String(row[matchedKeys.qty]).replace(/[^0-9-]/g, ''), 10);
    } else if (row['_col_3'] !== undefined) {
      quantity = parseInt(String(row['_col_3']).replace(/[^0-9-]/g, ''), 10);
    }
    if (isNaN(quantity)) quantity = 0; // Trigger compliance rule if 0/NaN

    let unit = 'PCE';
    if (matchedKeys.unit && row[matchedKeys.unit] !== undefined) {
      unit = String(row[matchedKeys.unit]).trim().toUpperCase();
    } else if (row['_col_4'] !== undefined) {
      unit = String(row['_col_4']).trim().toUpperCase();
    }
    if (!unit) unit = 'PCE';

    let weight = 1.0;
    if (matchedKeys.weight && row[matchedKeys.weight] !== undefined) {
      weight = parseFloat(String(row[matchedKeys.weight]).replace(/[^0-9.]/g, ''));
    } else if (row['_col_5'] !== undefined) {
      weight = parseFloat(String(row['_col_5']).replace(/[^0-9.]/g, ''));
    }
    if (isNaN(weight) || weight <= 0) weight = quantity * 0.25 || 1.0;

    let importerName = 'Logistics Express SA';
    if (matchedKeys.importer && row[matchedKeys.importer] !== undefined) {
      importerName = String(row[matchedKeys.importer]).trim();
    } else if (row['_col_6'] !== undefined) {
      importerName = String(row['_col_6']).trim();
    }

    let declaredValue = quantity * 125.00;
    if (matchedKeys.value && row[matchedKeys.value] !== undefined) {
      declaredValue = parseFloat(String(row[matchedKeys.value]).replace(/[^0-9.]/g, ''));
    } else if (row['_col_7'] !== undefined) {
      declaredValue = parseFloat(String(row['_col_7']).replace(/[^0-9.]/g, ''));
    }
    if (isNaN(declaredValue) || declaredValue < 0) {
      declaredValue = quantity * 125.00;
    }

    // Determine status of parsing record
    const status = quantity > 0 ? 'READY' : 'ERROR';

    const parsingRec: ParsingRecord = {
      manifestId,
      hsCode,
      description,
      quantity,
      unit,
      weight,
      status
    };

    // Calculate risk level dynamically
    let riskLevel: RiskLevel = 'CLEARED';
    const isProhibited = hsCode.startsWith('2804') || description.toLowerCase().includes('hidrogeno') || description.toLowerCase().includes('explosiv');
    const isZeroQty = quantity === 0;
    const isHighValue = hsCode === '8517.13.01' || description.toLowerCase().includes('smart') || description.toLowerCase().includes('apple') || description.toLowerCase().includes('samsung') || description.toLowerCase().includes('gama alta') || declaredValue > 25000;
    const isWarningGroup = hsCode.startsWith('8708') || description.toLowerCase().includes('auto parts') || description.toLowerCase().includes('incorrecta') || hsCode.startsWith('6204');

    if (isProhibited) {
      riskLevel = 'PROHIBITED';
    } else if (isZeroQty) {
      riskLevel = 'CRITICAL';
    } else if (isHighValue) {
      riskLevel = 'WARNING';
    } else if (isWarningGroup) {
      riskLevel = 'WARNING';
    }

    // Assign flags
    const flags: ('notes' | 'location' | 'wallet' | 'warning')[] = [];
    if (riskLevel === 'PROHIBITED' || riskLevel === 'CRITICAL') {
      flags.push('warning');
    }
    if (isHighValue) {
      flags.push('notes');
    }
    if (isWarningGroup) {
      flags.push('wallet');
    }

    const guideRec: GuideRecord = {
      id: `parsed_guide_${i}_${Date.now()}`,
      guideId: manifestId,
      importerName,
      htsCode: hsCode,
      description,
      declaredValue,
      riskLevel,
      flags
    };

    parsingRecords.push(parsingRec);
    guideRecords.push(guideRec);
  });

  // If we couldn't parse anything usable, use the sample list or return empty
  return {
    parsingRecords,
    guideRecords
  };
}
