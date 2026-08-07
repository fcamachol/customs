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
//   synonym table below in the same spirit as shared/parsing/headerSynonyms.ts. Layout-agnostic: it
//   reads `Label: value`, whitespace-aligned pairs, AND header-row/value-row tables, because robot
//   mail bodies use all three.
//
//   Tier 2b — CLIENT VOCABULARY. Unknown wording is taught once per client through the same
//   `client_header_mappings` table and admin UI the manifest parser already uses, instead of needing a
//   code change per client. Caller passes the resolved overrides in as `extraMappings`.
//
//   Tier 3 — SEMANTIC INFERENCE, for when no label matched at all. Two facts about the world do the
//   work labels would have: ETD necessarily precedes ETA, so of two unlabelled dates the earlier IS
//   the departure; and of the counts, weight is the one carrying a mass unit or a decimal, pieces
//   outnumber cartons because a carton holds pieces. Every inferred field is recorded as inferred in
//   `provenance`, so the UI can show it as an inference rather than as something the client stated —
//   an inferred value must never be indistinguishable from a declared one.
//
// HONEST LIMITATION: the Tier 2 synonyms are a best guess. The annotated real sample is still open
// as Q1 in PRD-02, so this vocabulary was assembled from standard air-cargo prealerta wording rather
// than from the actual robot output. Tier 1 needs no revision when the sample lands; Tier 2 probably
// does. Every field the parser cannot fill is reported as a warning instead of being guessed, so a
// vocabulary miss shows up as an explicit gap on the prealerta screen rather than as a wrong number.

import { parseManifestDate, parseNumberStrict } from '../parsing/normalize';
import { normGuia } from '../pedimento/guia';

export const PREALERTA_PARSER_VERSION = '2026-08b';

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

/**
 * How a field's value was obtained. Surfaced so the UI can distinguish what the client actually
 * declared from what we deduced — the cotejo's authority depends on that line staying visible.
 */
export type FieldSource =
  | 'forma'
  | 'etiqueta'
  | 'etiqueta_cliente'
  | 'tabla'
  | 'inferido_orden'
  | 'inferido_propiedad';

export interface PrealertaParseResult {
  fields: PrealertaFields;
  provenance: Partial<Record<keyof PrealertaFields, FieldSource>>;
  warnings: PrealertaWarning[];
  parserVersion: string;
}

/** Canonical field a label maps onto. */
export type LabelTarget = 'cartones' | 'piezas' | 'pesoKg' | 'etd' | 'eta' | 'vuelo' | 'mawb' | 'origen' | 'destino';

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
 * Split a body into label/value pairs. Three layouts, because robot mail uses all of them:
 *   1. `Label: value`
 *   2. whitespace-aligned pairs — `Cartons        63`
 *   3. header row over value row — `Cartons  Pieces  Weight` / `63  1910  52.64`, including
 *      pipe- and tab-delimited variants, which is what an HTML table flattens to
 *
 * Layout 3 is the one that made the parser look order-dependent: the values are nowhere near their
 * labels on the same line, so a pair-only reader finds nothing at all.
 */
function labelledPairs(text: string): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  for (const line of lines) {
    const colon = line.match(/^([^:]{1,60}):\s*(.+)$/);
    if (colon) {
      out.push({ label: colon[1], value: colon[2].trim() });
      continue;
    }
    const spaced = line.match(/^(.{1,60}?)\s{2,}(.+)$/);
    // Only treat it as a pair when the right side is a single value; two or more further gaps mean
    // this is a table row, handled below.
    if (spaced && !/\s{2,}/.test(spaced[2].trim())) {
      out.push({ label: spaced[1], value: spaced[2].trim() });
    }
  }

  out.push(...tablePairs(lines));
  return out;
}

/** Split a line into cells on pipes, tabs, or runs of 2+ spaces. */
function cells(line: string): string[] {
  return line
    .split(/\s*\|\s*|\t+|\s{2,}/)
    .map((c) => c.trim())
    .filter((c) => c !== '');
}

/**
 * Find header-row/value-row pairs. A row qualifies as a header when at least two of its cells resolve
 * to known labels; the next row with the same cell count supplies the values. Requiring two matches
 * is what stops an ordinary prose line from being read as a table header.
 */
function tablePairs(lines: string[]): Array<{ label: string; value: string }> {
  const out: Array<{ label: string; value: string }> = [];
  for (let i = 0; i < lines.length - 1; i++) {
    const header = cells(lines[i]);
    if (header.length < 2) continue;
    const resolved = header.map((h) => resolveLabel(h));
    if (resolved.filter(Boolean).length < 2) continue;

    const values = cells(lines[i + 1]);
    if (values.length !== header.length) continue;
    // A second header row is not a value row.
    if (values.map((v) => resolveLabel(v)).filter(Boolean).length >= 2) continue;

    header.forEach((h, j) => out.push({ label: h, value: values[j] }));
    i++; // consume the value row
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

/** Every date-like token in the text, with its position, for the ordering inference. */
function dateCandidates(text: string): Array<{ iso: string; ambiguous: boolean; at: number }> {
  const out: Array<{ iso: string; ambiguous: boolean; at: number }> = [];
  const re = /\b\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\b|\b\d{1,2}[ -][A-Za-z]{3,}[ -]\d{2,4}\b/g;
  for (const m of text.matchAll(re)) {
    const d = parseManifestDate(m[0]);
    if (d.ok) out.push({ iso: d.iso, ambiguous: Boolean(d.ambiguous), at: m.index ?? 0 });
  }
  return out;
}

/**
 * Tier 3 for dates: ETD necessarily precedes ETA. So when labels resolved neither, two distinct
 * dates in the body are unambiguous by ORDER OF TIME, not order of appearance — which is exactly the
 * kind of inference that survives the client reordering their template.
 */
function inferDates(
  fields: PrealertaFields,
  provenance: Partial<Record<keyof PrealertaFields, FieldSource>>,
  warnings: PrealertaWarning[],
  text: string,
): void {
  if (fields.etdOrigen && fields.etaPais) return;
  const found = dateCandidates(text);
  const distinct = [...new Map(found.map((d) => [d.iso, d])).values()].sort((a, b) =>
    a.iso.localeCompare(b.iso),
  );
  if (distinct.length < 2) return;

  const earliest = distinct[0];
  const latest = distinct[distinct.length - 1];
  if (!fields.etdOrigen) {
    fields.etdOrigen = earliest.iso;
    provenance.etdOrigen = 'inferido_orden';
    if (earliest.ambiguous) warnings.push({ code: 'fecha_ambigua', field: 'etdOrigen', detail: earliest.iso });
  }
  if (!fields.etaPais) {
    fields.etaPais = latest.iso;
    provenance.etaPais = 'inferido_orden';
    if (latest.ambiguous) warnings.push({ code: 'fecha_ambigua', field: 'etaPais', detail: latest.iso });
  }
}

/**
 * Tier 3 for the counts. Uses properties of the quantities themselves rather than their labels:
 *   - weight is the number carrying a mass unit, or failing that the only non-integer
 *   - of the remaining integers, pieces exceed cartons, because a carton contains pieces
 *
 * Only fills fields no label reached, and only when the shape of the evidence is unambiguous — two
 * bare integers with nothing to separate them stay unfilled rather than being guessed at 50/50.
 */
function inferCounts(
  fields: PrealertaFields,
  provenance: Partial<Record<keyof PrealertaFields, FieldSource>>,
  text: string,
): void {
  const needWeight = fields.pesoKg === undefined;
  const needPiezas = fields.piezas === undefined;
  const needCartones = fields.cartones === undefined;
  if (!needWeight && !needPiezas && !needCartones) return;

  // Weight first: a mass unit adjacent to a number is decisive.
  if (needWeight) {
    const m = text.match(/(-?[\d.,]+)\s*(kgs?|kilos?|lbs?|pounds?)\b/i);
    if (m) {
      const n = firstNumber(m[1]);
      if (n.ok) {
        const unit = m[2].toLowerCase();
        const kg = unit.startsWith('lb') || unit.startsWith('pound') ? n.value * 0.45359237 : n.value;
        fields.pesoKg = Number(kg.toFixed(3));
        provenance.pesoKg = 'inferido_propiedad';
      }
    }
  }

  const used = new Set<number>([fields.pesoKg, fields.piezas, fields.cartones].filter(
    (v): v is number => typeof v === 'number',
  ));
  const numbers: number[] = [];
  for (const m of text.matchAll(/-?[\d.,]+/g)) {
    const n = firstNumber(m[0]);
    // Exclude anything that looks like part of an identifier or a year, which are not quantities.
    if (n.ok && n.value > 0 && n.value < 1e7 && !used.has(n.value)) numbers.push(n.value);
  }

  if (fields.pesoKg === undefined) {
    const decimals = numbers.filter((n) => !Number.isInteger(n));
    if (decimals.length === 1) {
      fields.pesoKg = decimals[0];
      provenance.pesoKg = 'inferido_propiedad';
    }
  }

  const integers = [...new Set(numbers.filter((n) => Number.isInteger(n) && n !== fields.pesoKg))];
  if (integers.length >= 2 && (needPiezas || needCartones)) {
    integers.sort((a, b) => a - b);
    const smallest = integers[0];
    const largest = integers[integers.length - 1];
    // Require a real separation before claiming one is cartons and the other pieces; 63 vs 64 tells
    // us nothing, whereas 63 vs 1910 does.
    if (largest >= smallest * 2) {
      if (needCartones) {
        fields.cartones = smallest;
        provenance.cartones = 'inferido_propiedad';
      }
      if (needPiezas) {
        fields.piezas = largest;
        provenance.piezas = 'inferido_propiedad';
      }
    }
  }
}

export function parsePrealerta(input: {
  subject?: string | null;
  textBody?: string | null;
  /**
   * Per-client label overrides, in the same `normalized label -> canonical key` shape the manifest
   * pipeline already uses. Lets an unknown client vocabulary be taught once through the existing admin
   * UI instead of requiring a code change per client.
   */
  extraMappings?: Record<string, LabelTarget>;
}): PrealertaParseResult {
  const subject = input.subject ?? '';
  const body = input.textBody ?? '';
  const all = `${subject}\n${body}`;
  const fields: PrealertaFields = {};
  const provenance: Partial<Record<keyof PrealertaFields, FieldSource>> = {};
  const warnings: PrealertaWarning[] = [];

  // ---- Tier 1: shape. Independent of labels and of order by construction.
  const mawbs = new Set<string>();
  for (const m of all.matchAll(MAWB_RE)) mawbs.add(`${m[1]}-${m[2]}`);
  if (mawbs.size === 0) {
    warnings.push({ code: 'mawb_no_encontrado', field: 'mawb' });
  } else {
    const first = [...mawbs][0];
    fields.mawbRaw = first;
    fields.mawb = normGuia(first);
    provenance.mawb = 'forma';
    provenance.mawbRaw = 'forma';
    if (mawbs.size > 1) {
      warnings.push({ code: 'mawb_multiple', field: 'mawb', detail: [...mawbs].join(', ') });
    }
  }

  const route = all.match(ROUTE_RE);
  if (route) {
    fields.origenIata = route[1];
    fields.destinoIata = route[2];
    provenance.origenIata = 'forma';
    provenance.destinoIata = 'forma';
  }

  // ---- Tier 2 + 2b: labels, in any layout, with per-client overrides taking precedence.
  const pairs = labelledPairs(body || subject);
  for (const { label, value } of pairs) {
    const custom = input.extraMappings?.[normLabel(label)];
    const target = custom ?? resolveLabel(label);
    if (!target) continue;
    const src: FieldSource = custom ? 'etiqueta_cliente' : 'etiqueta';
    switch (target) {
      case 'cartones':
      case 'piezas': {
        if (fields[target] !== undefined) break;
        const n = firstNumber(value);
        if (n.ok) {
          fields[target] = Math.round(n.value);
          provenance[target] = src;
        } else {
          warnings.push({ code: 'valor_no_numerico', field: target, detail: value });
        }
        break;
      }
      case 'pesoKg': {
        if (fields.pesoKg !== undefined) break;
        const n = firstNumber(value);
        if (n.ok) {
          // Convert when the value states pounds; kilos and bare numbers pass through.
          const lb = /\b(lbs?|pounds?)\b/i.test(value);
          fields.pesoKg = Number((lb ? n.value * 0.45359237 : n.value).toFixed(3));
          provenance.pesoKg = src;
        } else {
          warnings.push({ code: 'valor_no_numerico', field: 'pesoKg', detail: value });
        }
        break;
      }
      case 'etd':
      case 'eta': {
        const key = target === 'etd' ? 'etdOrigen' : 'etaPais';
        if (fields[key] !== undefined) break;
        const d = parseManifestDate(value);
        if (d.ok) {
          fields[key] = d.iso;
          provenance[key] = src;
          if (d.ambiguous) warnings.push({ code: 'fecha_ambigua', field: key, detail: value });
        }
        break;
      }
      case 'vuelo': {
        if (fields.numeroVuelo !== undefined) break;
        const f = value.match(FLIGHT_RE);
        const v = f ? `${f[1]}${f[2]}` : value.trim() || undefined;
        if (v) {
          fields.numeroVuelo = v;
          provenance.numeroVuelo = src;
        }
        break;
      }
      case 'origen':
      case 'destino': {
        const key = target === 'origen' ? 'origenIata' : 'destinoIata';
        if (fields[key]) break;
        const m = value.match(/\b([A-Z]{3})\b/);
        if (m) {
          fields[key] = m[1];
          provenance[key] = src;
        }
        break;
      }
      case 'mawb':
        // The shape pass is strictly more reliable for this one.
        break;
    }
  }

  if (!fields.origenIata || !fields.destinoIata) warnings.push({ code: 'ruta_no_encontrada' });

  // Unlabelled flight fallback: strip the MAWB first and skip the air-cargo vocabulary that shares a
  // carrier code's shape.
  if (!fields.numeroVuelo) {
    const haystack = all.replace(MAWB_RE, ' ');
    for (const f of haystack.matchAll(FLIGHT_RE_G)) {
      if (NOT_A_CARRIER.has(f[1])) continue;
      fields.numeroVuelo = `${f[1]}${f[2]}`;
      provenance.numeroVuelo = 'forma';
      break;
    }
  }

  // ---- Tier 3: semantic inference for whatever labels could not reach.
  inferDates(fields, provenance, warnings, body || subject);
  // Strip the identifiers before inferring quantities. The MAWB's airline prefix (160) and a flight
  // number's digits are numerals but not amounts, and leaving them in makes the magnitude heuristic
  // pick an identifier as the piece count — which is exactly the kind of confidently-wrong answer
  // this parser must never produce.
  let numericHaystack = (body || subject).replace(MAWB_RE, ' ');
  if (fields.numeroVuelo) {
    numericHaystack = numericHaystack.replace(
      new RegExp(fields.numeroVuelo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      ' ',
    );
    const digits = fields.numeroVuelo.match(/\d+/)?.[0];
    if (digits) numericHaystack = numericHaystack.replace(new RegExp(`\\b${digits}\\b`, 'g'), ' ');
  }
  inferCounts(fields, provenance, numericHaystack);

  if (fields.numeroVuelo === undefined) warnings.push({ code: 'vuelo_no_encontrado', field: 'numeroVuelo' });
  if (fields.cartones === undefined) warnings.push({ code: 'cartones_no_encontrado', field: 'cartones' });
  if (fields.piezas === undefined) warnings.push({ code: 'piezas_no_encontrado', field: 'piezas' });
  if (fields.pesoKg === undefined) warnings.push({ code: 'peso_no_encontrado', field: 'pesoKg' });
  if (fields.etdOrigen === undefined) warnings.push({ code: 'etd_no_encontrado', field: 'etdOrigen' });
  if (fields.etaPais === undefined) warnings.push({ code: 'eta_no_encontrado', field: 'etaPais' });

  return { fields, provenance, warnings, parserVersion: PREALERTA_PARSER_VERSION };
}
