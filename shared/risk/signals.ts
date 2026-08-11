import type { Shipment } from '../types/shipment';
import { cleanId, validateTaxId } from '../parsing/taxId';
import { matchesBrand, matchesProhibited, matchesDeniedParty, type DeniedPartyEntry } from './lists';
import { resolveThresholds, type Thresholds, type Weights } from './ruleset';
import { norm as _norm } from './normalize';

export interface RiskContext {
  nameCounts: Record<string, number>;
  addressCounts: Record<string, number>;
  /**
   * Prior monthly operation counts per normalized consignee name, summed across
   * OTHER manifests in the same period (the current manifest is excluded so it is
   * counted once via `nameCounts`). Used by the `bbdd` signal to apply the Ficha
   * 124 ">3 operations/consignee/month" trigger against the full monthly total.
   */
  monthlyHistoryCounts: Record<string, number>;
  /** Optional override list for piracy brand detection */
  piracyBrands?: string[];
  /** Optional override list for prohibited keyword detection */
  prohibitedKeywords?: string[];
  /** Resolved thresholds (admin-configurable overrides already merged over RULESET defaults) */
  thresholds?: Thresholds;
}

export interface SignalResult {
  id: 'id' | 'cantidad' | 'monto' | 'consignatarios' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd';
  flagged: boolean;
  incidence?: string;
}

/**
 * Loose-form normalization: NFD diacritic strip + lowercase. Preserves whitespace.
 * Re-exported from normalize.ts — semantics are identical to the prior inline definition:
 *   (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase()
 * Used for entity keying (bbdd, address, smurfing signals). DO NOT change this to the
 * canonicalize() loose form (which also applies confusable folding) — that would silently
 * shift stored entity keys in the monthly_history DB.
 */
export const norm = _norm;

export function runSignals(s: Shipment, ctx: RiskContext): SignalResult[] {
  const t = ctx.thresholds ?? resolveThresholds();
  const idRaw = cleanId(s.consignee.curp ?? s.consignee.rfc ?? '');
  const idCheck = validateTaxId(idRaw);
  const name = norm(s.consignee.name);
  const addr = norm(s.consignee.address ?? '');
  const brand = matchesBrand(s.description, ctx.piracyBrands);
  const prohibited = matchesProhibited(s.description, ctx.prohibitedKeywords);

  const signals: SignalResult[] = [
    { id: 'id', flagged: !idRaw || !idCheck.shapeValid || !idCheck.checksumValid, incidence: !idRaw ? 'Falta RFC/CURP' : 'RFC/CURP inválido' },
    { id: 'cantidad', flagged: s.quantity > t.cantidad, incidence: 'Demasiados productos' },
    { id: 'monto', flagged: s.customsValueUsd < t.montoMin || s.customsValueUsd > t.montoMax, incidence: 'Valor declarado incorrecto' },
    { id: 'consignatarios', flagged: (ctx.nameCounts[name] ?? 0) >= t.consignatario, incidence: 'Varios paquetes por consignatario' },
    { id: 'direcciones', flagged: !!addr && (ctx.addressCounts[addr] ?? 0) >= t.direccion, incidence: 'Misma dirección de entrega' },
    { id: 'prohibidos', flagged: !!prohibited, incidence: prohibited ? `Artículos prohibidos (${prohibited})` : undefined },
    { id: 'pirateria', flagged: !!brand, incidence: brand ? `Piratería (${brand})` : undefined },
    { id: 'bbdd', flagged: (ctx.monthlyHistoryCounts[name] ?? 0) + (ctx.nameCounts[name] ?? 0) >= t.importacionesMes, incidence: 'Varias importaciones en el mes' },
  ];
  return signals.map((r) => ({ ...r, incidence: r.flagged ? r.incidence : undefined }));
}

// ─── Task 5: Graded, entity-aware signals with reason codes ──────────────────

export type SignalId = 'id' | 'cantidad' | 'monto' | 'agregado' | 'direcciones' | 'prohibidos' | 'pirateria' | 'bbdd' | 'denied_party';

export interface ReasonCode {
  signalId: SignalId;
  points: number;
  weight: number;
  detail: string;
  evidence?: Record<string, unknown>;
  forcesBand?: 'rojo';
}

export interface EntityContext {
  thresholds: Thresholds;
  weights: Weights;
  /** Distinct consignee count per normalized address (smurfing indicator). */
  addressDistinctConsignees: Record<string, number>;
  /**
   * Monthly operation count per **dedup token** (history + current) for Ficha-124.
   *
   * Key derivation: `nameToken(norm(name))` where `nameToken` defaults to identity.
   * When F20b blind-index tokenization is active (server passes `nameTokenFn` in
   * ScoreOptions), the key is a HMAC token over the normalized name — opaque but
   * collision-preserving (same norm → same token → same dedup bucket).
   *
   * Do NOT use entityKey here — RFC/CURP keys would never match the name-keyed
   * history loaded from the server (and we want name-based cross-manifest dedup,
   * not identity-based).
   */
  monthlyNameCount: Record<string, number>;
  /**
   * F13: Aggregate customs value (USD) per entity key across all rows of the current
   * manifest. Keyed by `entityKey(consignee, nameToken)` (RFC/CURP when present, else
   * `name:<nameToken(normalized)>`).
   *
   * F20b: now uses the same tokenized name-fallback as entityKey so all per-entity
   * aggregation is consistent when nameTokenFn is injected.
   */
  entityValueTotal?: Record<string, number>;
  piracyBrands?: string[];
  prohibitedKeywords?: string[];
  /**
   * F18: denied-party / sanctions list (OFAC/BIS/EU/UN).
   * Loaded from the `denied_parties` config key and passed through scoreManifest → EntityContext.
   * Screened against: consignee.name, sender.name (normalized token match) and
   * consignee.curp, consignee.rfc, consignee.foreignTaxId, sender.taxId (exact ID match).
   * Fields are available decrypted in-memory at scoring time (risk.ts decrypts before scoreManifest).
   * F18 matches on DECRYPTED names/ids in-memory — UNAFFECTED by F20b tokenization.
   */
  deniedParties?: DeniedPartyEntry[];
  /**
   * F14+F20b: Name-dedup tokenizer for ID-less consignees.
   * Receives `norm(name)` and returns a dedup token that incorporates the fuzzy canonical
   * (so typo variants map to the same bbdd bucket). Defaults to identity when absent.
   *
   * CRITICAL: used ONLY for consignees WITHOUT a valid RFC/CURP. ID-keyed consignees
   * MUST use `nameTokenBase` (below) for their bbdd key so that fuzzy clustering of
   * ID-less names never alters the bbdd count of ID-keyed consignees.
   *
   * CONSTRAINT: shared/risk must NOT import Node's `crypto` — inject only.
   */
  nameToken?: (normalizedName: string) => string;
  /**
   * F20b: Base name tokenizer (no fuzzy canonical). Receives `norm(name)` and
   * returns a HMAC blind-index token (or identity when absent).
   *
   * Used ONLY for RFC/CURP-keyed consignees in the bbdd signal so their key-space
   * is never remapped by the fuzzy cluster map (which only contains ID-less names).
   *
   * When absent, bbdd falls back to identity (norm'd name), preserving exact-match
   * back-compat. When F20b is active (server injects nameTokenFn), this field
   * carries rawBlindIndex — the same function used to tokenize history keys.
   *
   * INVARIANT: nameTokenBase(x) === nameToken(x) for any name that was NOT
   * fuzzily clustered (i.e., for all ID-keyed names and for exact-match ID-less names).
   */
  nameTokenBase?: (normalizedName: string) => string;
}

/**
 * Entity identity: RFC/CURP when present (deterministic), else tokenized normalized name.
 *
 * F20b: accepts an optional `nameTokenFn` to tokenize the name-fallback.
 * RFC/CURP-first path is UNCHANGED — tokenization only affects the name fallback.
 * Default: identity function (no tokenization — back-compat preserved).
 */
export function entityKey(
  c: { rfc?: string; curp?: string; name: string },
  nameTokenFn?: (normalizedName: string) => string,
): string {
  const id = cleanId(c.curp ?? c.rfc ?? '');
  if (id) return id;
  const normalizedName = norm(c.name);
  return `name:${nameTokenFn ? nameTokenFn(normalizedName) : normalizedName}`;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/**
 * Graded, entity-aware signal evaluation.
 * Returns one ReasonCode per fired signal (points > 0 only).
 * A normal repeat buyer with a valid ID and in-band values fires nothing.
 */
export function gradeSignals(s: Shipment, ctx: EntityContext): ReasonCode[] {
  const t = ctx.thresholds;
  const w = ctx.weights;
  const out: ReasonCode[] = [];

  const add = (
    signalId: SignalId,
    frac: number,
    detail: string,
    evidence?: Record<string, unknown>,
    forces?: 'rojo',
  ): void => {
    const points = Math.round(w[signalId] * clamp01(frac));
    if (points > 0) {
      out.push({ signalId, points, weight: w[signalId], detail, evidence, forcesBand: forces });
    }
  };

  // id: missing or shape/checksum invalid → full weight
  const idRaw = cleanId(s.consignee.curp ?? s.consignee.rfc ?? '');
  const idCheck = validateTaxId(idRaw);
  if (!idRaw || !idCheck.shapeValid || !idCheck.checksumValid) {
    add('id', 1, !idRaw ? 'Falta RFC/CURP' : 'RFC/CURP inválido', { id: idRaw });
  }

  // cantidad: graded by excess over threshold
  if (s.quantity > t.cantidad) {
    add('cantidad', (s.quantity - t.cantidad) / t.cantidad, 'Demasiados productos', { quantity: s.quantity });
  }

  // monto: below min → full weight; above max → graded by excess.
  //
  // `direccion` es el DISCRIMINADOR, no decoración: hasta ahora las dos variantes sólo se distinguían
  // por el texto de `detail`, y `detail` es copy humano que se edita (i18n, erratas) y por eso queda
  // FUERA de la huella del hallazgo (`shared/risk/efectivo.ts`). Sin este campo, disponer "el valor
  // bajo está justificado" taparía también un valor ALTO posterior sobre la misma línea — dos
  // hallazgos opuestos con la misma huella. No toca `ruleset_hash`: éste cubre umbrales, pesos,
  // bandas y listas, no la forma de la evidencia.
  if (s.customsValueUsd < t.montoMin) {
    add('monto', 1, 'Valor declarado incorrecto (muy bajo)', { value: s.customsValueUsd, direccion: 'bajo' });
  } else if (s.customsValueUsd > t.montoMax) {
    add('monto', (s.customsValueUsd - t.montoMax) / t.montoMax, 'Valor declarado incorrecto (muy alto)', { value: s.customsValueUsd, direccion: 'alto' });
  }

  // agregado (F13): cross-row split-shipment cap — fires when the aggregate value
  // for this entity key across all manifest rows exceeds montoMax (RULESET.montoMax = $2,500).
  // The per-row `monto` cap above is the floor; this is additive.
  // Cross-reference: RULESET.thresholds.montoMax = 2500 (SPLIT_CAP_USD in prevalidate.ts).
  // F20b: entityKey uses ctx.nameToken for the name-fallback (RFC/CURP path unchanged).
  if (ctx.entityValueTotal) {
    const ek = entityKey(s.consignee, ctx.nameToken);
    const total = ctx.entityValueTotal[ek] ?? s.customsValueUsd;
    if (total > t.montoMax) {
      add('agregado', (total - t.montoMax) / t.montoMax, 'Valor agregado por consignatario excede el umbral',
        { entityTotal: total, cap: t.montoMax });
    }
  }

  // direcciones: smurfing signal — distinct entities at one address ≥ threshold
  const normAddr = norm(s.consignee.address ?? '');
  const distinctCount = normAddr ? (ctx.addressDistinctConsignees[normAddr] ?? 0) : 0;
  if (distinctCount >= t.addressDistinctConsignees) {
    add(
      'direcciones',
      (distinctCount - (t.addressDistinctConsignees - 1)) / t.addressDistinctConsignees,
      'Misma dirección de entrega',
      { distinctConsignees: distinctCount },
    );
  }

  // prohibidos: full weight + forces rojo
  const prohibited = matchesProhibited(s.description, ctx.prohibitedKeywords);
  if (prohibited) {
    add('prohibidos', 1, `Artículos prohibidos (${prohibited})`, { matched: prohibited }, 'rojo');
  }

  // pirateria: full weight + forces rojo
  const brand = matchesBrand(s.description, ctx.piracyBrands);
  if (brand) {
    add('pirateria', 1, `Piratería (${brand})`, { matched: brand }, 'rojo');
  }

  // denied_party (F18): OFAC/BIS/EU/UN sanctions screening — full weight + forces rojo.
  // Match on consignee.name + sender.name (normalized token) and exact ID (RFC/CURP/foreignTaxId/sender.taxId).
  // IDs are available decrypted in-memory (risk.ts decrypts before scoreManifest — no encryption coupling here).
  // TODO(F20): align ID keying with F20's blind-index tokenization when that lands.
  const dpMatch = matchesDeniedParty(
    {
      names: [s.consignee.name, s.sender?.name ?? ''].filter(Boolean),
      ids: [
        s.consignee.curp ?? '',
        s.consignee.rfc ?? '',
        s.consignee.foreignTaxId ?? '',
        s.sender?.taxId ?? '',
      ].filter(Boolean),
    },
    ctx.deniedParties,
  );
  if (dpMatch) {
    add(
      'denied_party',
      1,
      `Coincidencia en lista de sancionados (${dpMatch.source ?? 'OFAC/BIS/EU/UN'})`,
      { matched: dpMatch.matched, source: dpMatch.source, program: dpMatch.program },
      'rojo',
    );
  }

  // bbdd (Ficha-124): fires only when monthlyNameCount > 3, graded by excess over 3.
  //
  // F14 CRITICAL: RFC/CURP-keyed consignees MUST use the base tokenizer (no fuzzy canonical)
  // so that fuzzy clustering of ID-less names never remaps an ID-keyed consignee's bbdd key.
  //
  // Key selection:
  //   - ID-keyed (has valid RFC/CURP): use nameTokenBase (base tokenizer, no fuzzy canonical).
  //     This guarantees the bbdd key matches exactly what PASS-1 wrote under rawNorm.
  //   - ID-less: use nameToken (fuzzy-canonical + base tokenizer) so typo variants resolve
  //     to the same cluster bucket that PASS-1 accumulated.
  //
  // Both default to identity when the respective function is absent (exact-match back-compat).
  const normName = norm(s.consignee.name);
  const bbddKey = idRaw
    ? (ctx.nameTokenBase ? ctx.nameTokenBase(normName) : normName)
    : (ctx.nameToken    ? ctx.nameToken(normName)    : normName);
  const mc = ctx.monthlyNameCount[bbddKey] ?? 0;
  if (mc > 3) {
    add('bbdd', (mc - 3) / 3, 'Varias importaciones en el mes', { monthlyCount: mc });
  }

  return out;
}
