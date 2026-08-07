// Deterministic parser for the inbound prealerta email (PRD-02 R1–R4).
//
// WHY DETERMINISTIC AND VERSIONED, NOT AN LLM: the numbers this extracts (cartones, piezas, peso)
// are the left-hand side of the cotejo that raises red flags against the manifest. A finding has to
// be reproducible on demand — the same email must always yield the same fields and therefore the
// same discrepancies — because the audience for it is Anticorrupción y Buen Gobierno. A model that
// extracts `piezas` slightly differently on a re-run is exactly the thing that gets attacked. So
// this file is plain rules stamped with PREALERTA_PARSER_VERSION, and every parse records which
// version produced it. AGORA's ConversationParser (LLM) is reserved for non-authoritative work such
// as judging whether a free-text client reply resolves a requirement.
//
// TWO EXTRACTION TIERS, on purpose:
//
//   Tier 1 — SHAPE. The MAWB, the IATA route and the flight number are recognized by their form, so
//   they survive any label wording or column order. The client's robot decides those, and per the
//   meeting we cannot ask clients to change their system ("tus clientes no van a cambiar su sistema
//   por ti"), so label independence is a requirement, not a nicety.
//
//   Tier 2 — LABEL. Two dates and three counts cannot be told apart by shape alone: 63 and 1910 are
//   both integers, and ETD and ETA are both dates. Those need the label, resolved through the
//   synonym table below in the same spirit as shared/parsing/headerSynonyms.ts.
//
// HONEST LIMITATION: the Tier 2 synonyms are a best guess. The annotated real sample is still open
// as Q1 in PRD-02, so this vocabulary was assembled from standard air-cargo prealerta wording rather
// than from the actual robot output. Tier 1 needs no revision when the sample lands; Tier 2 probably
// does. Every field the parser cannot fill is reported as a warning instead of being guessed, so a
// vocabulary miss shows up as an explicit gap on the prealerta screen rather than as a wrong number.

import { parseManifestDate, parseNumberStrict } from '../parsing/normalize';
import { normGuia } from '../pedimento/guia';

export const PREALERTA_PARSER_VERSION = '2026-08a';

export interface PrealertaFields {
  /** As printed by the client, for display and human reconciliation. */
  mawbRaw?: string;
  /** normGuia()-normalized, for keying and for matching manifests.mawb_reference. */
  mawb?: string;
  origenIata?: string;
  destinoIata?: string;
  numeroVuelo?: string;
  /** ISO-8601 date. */
  etdOrigen?: string;
  /** ISO-8601 date. */
  etaPais?: string;
  cartones?: number;
  piezas?: number;
  pesoKg?: number;
}

export type PrealertaWarningCode =
  | 'mawb_no_encontrado'
  | 'mawb_multiple'
  | 'ruta_no_encontrada'
  | 'vuelo_no_encontrado'
  | 'etd_no_encontrado'
  | 'eta_no_encontrado'
  | 'fecha_ambigua'
  | 'cartones_no_encontrado'
  | 'piezas_no_encontrado'
  | 'peso_no_encontrado'
  | 'valor_no_numerico';

export interface PrealertaWarning {
  code: PrealertaWarningCode;
  field?: keyof PrealertaFields;
  detail?: string;
}

export interface PrealertaParseResult {
  fields: PrealertaFields;
  warnings: PrealertaWarning[];
  parserVersion: string;
}

/** Canonical field a label maps onto. */
type LabelTarget = 'cartones' | 'piezas' | 'pesoKg' | 'etd' | 'eta' | 'vuelo' | 'mawb' | 'origen' | 'destino';

/**
 * Label synonyms, normalized (lowercased, accents stripped, non-alphanumerics collapsed to single
 * spaces). Longest match wins, so `gross weight` beats `weight` and `fecha de salida` beats `salida`.
 */
const LABELS: ReadonlyArray<readonly [string, LabelTarget]> = [
  // counts
  ['cartones', 'cartones'], ['carton', 'cartones'], ['cartons', 'cartones'], ['ctns', 'cartones'],
  ['ctn', 'cartones'], ['cajas', 'cartones'], ['caja', 'cartones'], ['bultos', 'cartones'],
  ['packages', 'cartones'], ['pkgs', 'cartones'], ['colis', 'cartones'],
  ['piezas', 'piezas'], ['pieza', 'piezas'], ['pieces', 'piezas'], ['pcs', 'piezas'],
  ['quantity', 'piezas'], ['qty', 'piezas'], ['units', 'piezas'],
  // weight
  ['gross weight', 'pesoKg'], ['peso bruto', 'pesoKg'], ['weight', 'pesoKg'], ['peso', 'pesoKg'],
  ['kgs', 'pesoKg'], ['kg', 'pesoKg'], ['kilos', 'pesoKg'], ['gw', 'pesoKg'],
  // dates — ETD side
  ['fecha estimada de salida', 'etd'], ['estimated time of departure', 'etd'],
  ['date of departure', 'etd'], ['fecha de salida', 'etd'], ['departure date', 'etd'],
  ['departure', 'etd'], ['salida', 'etd'], ['etd', 'etd'], ['atd', 'etd'], ['dep', 'etd'],
  // dates — ETA side
  ['fecha estimada de arribo', 'eta'], ['fecha estimada de llegada', 'eta'],
  ['estimated time of arrival', 'eta'], ['date of arrival', 'eta'], ['fecha de arribo', 'eta'],
  ['arrival date', 'eta'], ['arrival', 'eta'], ['arribo', 'eta'], ['llegada', 'eta'],
  ['eta', 'eta'], ['ata', 'eta'], ['arr', 'eta'],
  // flight
  ['numero de vuelo', 'vuelo'], ['no de vuelo', 'vuelo'], ['flight no', 'vuelo'],
  ['flight number', 'vuelo'], ['flight', 'vuelo'], ['vuelo', 'vuelo'], ['flt', 'vuelo'],
  // master guide
  ['guia master', 'mawb'], ['guia maestra', 'mawb'], ['master airway bill', 'mawb'],
  ['master awb', 'mawb'], ['mawb', 'mawb'], ['awb', 'mawb'], ['master', 'mawb'], ['guia', 'mawb'],
  // route
  ['origen', 'origen'], ['origin', 'origen'], ['pol', 'origen'], ['aol', 'origen'],
  ['destino', 'destino'], ['destination', 'destino'], ['pod', 'destino'], ['aod', 'destino'],
];

function normLabel(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveLabel(raw: string): LabelTarget | null {
  const n = normLabel(raw);
  if (!n) return null;
  let best: { len: number; target: LabelTarget } | null = null;
  for (const [syn, target] of LABELS) {
    // Word-boundary containment rather than equality: real prealertas wrap the label in noise
    // ("Total Cartons", "ETA (local)"), and equality would miss every one of those.
    const re = new RegExp(`(^|\\s)${syn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|\\s)`);
    if (re.test(n) && (!best || syn.length > best.len)) best = { len: syn.length, target };
  }
  return best?.target ?? null;
}

/**
 * Split a body into label/value pairs. Handles both `Label: value` and the whitespace-aligned
 * pseudo-table that robot mail bodies often use (`Cartons        63`).
 */
function labelledPairs(text: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.match(/^([^:]{1,60}):\s*(.+)$/);
    if (colon) {
      out.push({ label: colon[1], value: colon[2].trim() });
      continue;
    }
    const spaced = line.match(/^(.{1,60}?)\s{2,}(.+)$/);
    if (spaced) out.push({ label: spaced[1], value: spaced[2].trim() });
  }
  return out;
}

// Tier 1 shapes.
// Air waybill: 3-digit airline prefix + 8-digit serial, optionally hyphen/space separated.
const MAWB_RE = /\b(\d{3})[-\s]?(\d{8})\b/g;
// IATA pair: two 3-letter codes joined by a separator that means "to". Requires uppercase in the
// original text, which is what keeps ordinary words from matching.
const ROUTE_RE = /\b([A-Z]{3})\s*(?:-|–|—|\/|>|→|=>|to\b|a\b)\s*([A-Z]{3})\b/;
// Flight: 2-3 char carrier code (letters, or letter+digit like 5X) + 1-5 digits.
const FLIGHT_RE = /\b([A-Z]{2}[A-Z0-9]?)\s?(\d{1,5})\b/;
const FLIGHT_RE_G = new RegExp(FLIGHT_RE.source, 'g');
/**
 * Tokens that look exactly like a carrier code but never are. Without this, "AWB 160-94705516"
 * yields the flight "AWB160" — the shape is genuinely indistinguishable, so the only fix is to know
 * the air-cargo vocabulary that occupies it.
 */
const NOT_A_CARRIER = new Set([
  'AWB', 'MAWB', 'HAWB', 'PCS', 'PKG', 'PKGS', 'CTN', 'CTNS', 'KG', 'KGS', 'GW', 'NW',
  'QTY', 'ETA', 'ETD', 'ATA', 'ATD', 'POL', 'POD', 'AOL', 'AOD', 'REF', 'INV', 'PO',
]);

function firstNumber(value: string): { ok: true; value: number } | { ok: false } {
  // Strip units and any trailing noise, then hand the numeric core to the strict parser so
  // locale-ambiguous forms like "1,000" are rejected rather than silently misread.
  const m = value.replace(/\s+/g, ' ').match(/-?[\d.,]+/);
  if (!m) return { ok: false };
  const parsed = parseNumberStrict(m[0]);
  return parsed.ok ? { ok: true, value: parsed.value } : { ok: false };
}

export function parsePrealerta(input: {
  subject?: string | null;
  textBody?: string | null;
}): PrealertaParseResult {
  const subject = input.subject ?? '';
  const body = input.textBody ?? '';
  const all = `${subject}\n${body}`;
  const fields: PrealertaFields = {};
  const warnings: PrealertaWarning[] = [];

  // ---- Tier 1: shape ----
  const mawbs = new Set<string>();
  for (const m of all.matchAll(MAWB_RE)) mawbs.add(`${m[1]}-${m[2]}`);
  if (mawbs.size === 0) {
    warnings.push({ code: 'mawb_no_encontrado', field: 'mawb' });
  } else {
    // Deterministic choice when a thread quotes several: take the first by document order, and say
    // so, rather than silently picking one.
    const first = [...mawbs][0];
    fields.mawbRaw = first;
    fields.mawb = normGuia(first);
    if (mawbs.size > 1) {
      warnings.push({ code: 'mawb_multiple', field: 'mawb', detail: [...mawbs].join(', ') });
    }
  }

  const route = all.match(ROUTE_RE);
  if (route) {
    fields.origenIata = route[1];
    fields.destinoIata = route[2];
  } else {
    warnings.push({ code: 'ruta_no_encontrada' });
  }

  // ---- Tier 2: labels ----
  const pairs = labelledPairs(body || subject);
  for (const { label, value } of pairs) {
    const target = resolveLabel(label);
    if (!target) continue;
    switch (target) {
      case 'cartones':
      case 'piezas': {
        if (fields[target] !== undefined) break;
        const n = firstNumber(value);
        if (n.ok) fields[target] = Math.round(n.value);
        else warnings.push({ code: 'valor_no_numerico', field: target, detail: value });
        break;
      }
      case 'pesoKg': {
        if (fields.pesoKg !== undefined) break;
        const n = firstNumber(value);
        if (n.ok) fields.pesoKg = n.value;
        else warnings.push({ code: 'valor_no_numerico', field: 'pesoKg', detail: value });
        break;
      }
      case 'etd':
      case 'eta': {
        const key = target === 'etd' ? 'etdOrigen' : 'etaPais';
        if (fields[key] !== undefined) break;
        const d = parseManifestDate(value);
        if (d.ok) {
          fields[key] = d.iso;
          // dd/mm vs mm/dd is unresolvable from the value alone. The ETA drives the whole risk
          // deadline window (R18), so a silently wrong month is worse than a flagged one.
          if (d.ambiguous) warnings.push({ code: 'fecha_ambigua', field: key, detail: value });
        }
        break;
      }
      case 'vuelo': {
        if (fields.numeroVuelo !== undefined) break;
        const f = value.match(FLIGHT_RE);
        // A labelled flight field may hold only digits ("160"); trust the label in that case.
        fields.numeroVuelo = f ? `${f[1]}${f[2]}` : value.trim() || undefined;
        break;
      }
      case 'origen':
        if (!fields.origenIata) {
          const m = value.match(/\b([A-Z]{3})\b/);
          if (m) fields.origenIata = m[1];
        }
        break;
      case 'destino':
        if (!fields.destinoIata) {
          const m = value.match(/\b([A-Z]{3})\b/);
          if (m) fields.destinoIata = m[1];
        }
        break;
      case 'mawb':
        // Already covered by the shape pass, which is strictly more reliable here.
        break;
    }
  }

  // Fall back to a bare shape match for the flight only after labels had their chance, since
  // FLIGHT_RE is loose enough to match fragments of other identifiers. Two guards make the fallback
  // safe: the MAWB occurrences are removed first (otherwise "AWB 160-94705516" reads as flight
  // "AWB160"), and any token in the air-cargo vocabulary is skipped rather than accepted.
  if (!fields.numeroVuelo) {
    const haystack = all.replace(MAWB_RE, ' ');
    for (const f of haystack.matchAll(FLIGHT_RE_G)) {
      if (NOT_A_CARRIER.has(f[1])) continue;
      fields.numeroVuelo = `${f[1]}${f[2]}`;
      break;
    }
    if (!fields.numeroVuelo) warnings.push({ code: 'vuelo_no_encontrado', field: 'numeroVuelo' });
  }

  if (fields.cartones === undefined) warnings.push({ code: 'cartones_no_encontrado', field: 'cartones' });
  if (fields.piezas === undefined) warnings.push({ code: 'piezas_no_encontrado', field: 'piezas' });
  if (fields.pesoKg === undefined) warnings.push({ code: 'peso_no_encontrado', field: 'pesoKg' });
  if (fields.etdOrigen === undefined) warnings.push({ code: 'etd_no_encontrado', field: 'etdOrigen' });
  if (fields.etaPais === undefined) warnings.push({ code: 'eta_no_encontrado', field: 'etaPais' });

  return { fields, warnings, parserVersion: PREALERTA_PARSER_VERSION };
}
