// shared/parsing/validateManifest.ts
import type { IngestResult, RowIssue, RowStatus, StagingRow } from '../types/staging';
import { mapRowToShipment } from './manifestParser';
import { resolveHeader } from './headerSynonyms';
import { resolveCountry, resolveCurrency } from './catalogs';
import { parseNumberStrict, convertWeight, parseManifestDate } from './normalize';

const str = (v: unknown): string => String(v ?? '').trim();

export function validateManifest(headerRow: string[], dataRows: unknown[][], mawb: string): IngestResult {
  // Duplicate mapped headers → ambiguous provenance → whole-file rejection.
  const seen = new Map<string, number>();
  const duplicateHeaders: string[] = [];
  const unmapped = new Set<string>();
  for (const h of headerRow) {
    const path = resolveHeader(h);
    if (!path) { unmapped.add(h); continue; }
    seen.set(path, (seen.get(path) ?? 0) + 1);
    if (seen.get(path) === 2) duplicateHeaders.push(h);
  }
  if (duplicateHeaders.length) {
    return { rows: [], counts: { total: 0, valid: 0, warning: 0, error: 0 }, unmappedHeaders: [...unmapped], duplicateHeaders, fileRejected: true, headerRow };
  }

  const lineSeq = new Map<string, number>();
  const rows: StagingRow[] = dataRows.map((cells, rowIndex) => {
    const record: Record<string, unknown> = {};
    headerRow.forEach((h, i) => { record[h] = cells[i]; });
    const shipment = mapRowToShipment(record);
    shipment.mawbReference = mawb;

    const errors: RowIssue[] = [];
    const warnings: RowIssue[] = [];
    const err = (field: string, code: string, message: string, rawValue?: string) => errors.push({ rowIndex, field, code, severity: 'error', message, rawValue });
    const warn = (field: string, code: string, message: string, rawValue?: string) => warnings.push({ rowIndex, field, code, severity: 'warning', message, rawValue });

    const get = (path: string): string => {
      for (const h of headerRow) if (resolveHeader(h) === path) return str(record[h]);
      return '';
    };

    // Required text
    if (!str(shipment.description)) err('description', 'description_required', 'Descripción de la mercancía requerida');
    if (!str(shipment.hsCode)) err('hsCode', 'hscode_required', 'Código HS requerido');
    else if (!/^\d{8}$|^\d{10}$/.test(str(shipment.hsCode).replace(/\./g, ''))) warn('hsCode', 'hscode_format', 'Código HS debe ser de 8 o 10 dígitos', str(shipment.hsCode));
    if (!str(shipment.guideId)) err('guideId', 'guide_required', 'Número de guía requerido');

    // Required numbers (strict — no silent coercion)
    const valueRaw = get('core.customsValueUsd');
    const v = parseNumberStrict(valueRaw);
    if (!v.ok) {
      const vErr = v as { ok: false; code: 'not_a_number' | 'ambiguous_locale' };
      err('customsValueUsd', vErr.code === 'ambiguous_locale' ? 'value_ambiguous' : 'value_not_a_number',
        vErr.code === 'ambiguous_locale' ? 'Valor ambiguo (separador de miles/decimal)' : 'Valor declarado no numérico', valueRaw);
    } else if (v.value <= 0) {
      err('customsValueUsd', 'value_non_positive', 'Valor debe ser > 0 (declare valor reconstruido si es muestra sin valor comercial)', valueRaw);
    }

    const qtyRaw = get('core.quantity');
    const q = parseNumberStrict(qtyRaw);
    if (!q.ok) {
      const qErr = q as { ok: false; code: 'not_a_number' | 'ambiguous_locale' };
      err('quantity', qErr.code === 'ambiguous_locale' ? 'quantity_ambiguous' : 'quantity_not_a_number', 'Cantidad no numérica', qtyRaw);
    } else if (q.value <= 0) {
      err('quantity', 'quantity_non_positive', 'Cantidad debe ser > 0', qtyRaw);
    }

    // Currency
    const currencyRaw = get('core.currency');
    const cur = resolveCurrency(currencyRaw);
    if (!str(currencyRaw)) err('currency', 'currency_required', 'Moneda requerida');
    else if (!cur) err('currency', 'currency_unknown', `Moneda no reconocida: ${currencyRaw}`, currencyRaw);
    else shipment.currency = cur;

    // Procedence country (sender) — required
    const procRaw = get('core.procedenceCountry') || str(shipment.sender?.countryCode) || str(shipment.sender?.countryName);
    if (!str(procRaw)) err('procedenceCountry', 'procedence_required', 'País de procedencia requerido');
    else if (!resolveCountry(procRaw)) err('procedenceCountry', 'procedence_unknown', `País de procedencia no reconocido: ${procRaw}`, procRaw);

    // Origin country (manufactured) — WARNING at ingestion (hard-gated in Phase B)
    if (!str(shipment.originCountry)) warn('originCountry', 'origin_undeclared', 'País de origen no declarado (requerido al generar el pedimento)');

    // Weight unit (only when a weight is present)
    const weightUnitRaw = get('core.weightUnit');
    if (shipment.weight != null && str(weightUnitRaw)) {
      const w = convertWeight(shipment.weight, weightUnitRaw);
      if (!w.ok) err('weightUnit', 'weight_unit_unknown', `Unidad de peso no reconocida: ${weightUnitRaw}`, weightUnitRaw);
      else shipment.weightKg = w.kg;
    }

    // Date (only when present)
    const dateRaw = get('core.arrivalDate');
    if (str(dateRaw)) {
      const d = parseManifestDate(record[headerRow.find((h) => resolveHeader(h) === 'core.arrivalDate') ?? '']);
      if (!d.ok) err('arrivalDate', 'date_invalid', `Fecha inválida: ${dateRaw}`, dateRaw);
      else shipment.arrivalDate = d.iso;
    }

    // Consignee identity — presence required, but missing/invalid is a WARNING (generic-RFC path)
    const idRaw = str(shipment.consignee.rfc) || str(shipment.consignee.curp);
    if (!idRaw) warn('consignee.id', 'identity_missing', 'Identidad del destinatario ausente (se podrá usar RFC genérico)');

    // Idempotency key: per-line within the guide
    const guide = str(shipment.guideId);
    const next = (lineSeq.get(guide) ?? 0) + 1;
    lineSeq.set(guide, next);
    const idempotencyKey = `${mawb}|${guide}|${next}|${str(shipment.hsCode)}`;

    const status: RowStatus = errors.length ? 'error' : warnings.length ? 'warning' : 'valid';
    return { rowIndex, status, idempotencyKey, shipment, errors, warnings };
  });

  const counts = {
    total: rows.length,
    valid: rows.filter((r) => r.status === 'valid').length,
    warning: rows.filter((r) => r.status === 'warning').length,
    error: rows.filter((r) => r.status === 'error').length,
  };
  return { rows, counts, unmappedHeaders: [...unmapped], duplicateHeaders: [], fileRejected: false, headerRow };
}
