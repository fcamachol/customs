import type { z } from 'zod';
import { query } from '../db/pool';
import { cleanId, isValidTaxIdStrict } from '../../../shared/parsing/taxId';
import { importerSchema, agentSchema } from '../validation/schemas';

export type ImporterOfRecord = z.infer<typeof importerSchema>;
export type CustomsAgent = z.infer<typeof agentSchema>;

async function loadValidated<T>(key: string, schema: { safeParse(v: unknown): { success: boolean; data?: T } }): Promise<T | null> {
  const { rows } = await query<{ value: unknown }>('SELECT value FROM config WHERE key=$1', [key]);
  if (!rows.length) return null;
  const parsed = schema.safeParse(rows[0].value);
  return parsed.success ? (parsed.data as T) : null;
}

export const loadImporterOfRecord = (): Promise<ImporterOfRecord | null> =>
  loadValidated('importer_of_record', importerSchema);
export const loadCustomsAgent = (): Promise<CustomsAgent | null> =>
  loadValidated('customs_agent', agentSchema);

// ─── Entity catalogs (agentes_aduanales / importadores) ──────────────────────
// camelCase rows — the exact contract the catalogs API and frontend code against.

export interface AgenteAduanal {
  id: string;
  patente: string;
  name: string | null;
  agentRfc: string | null;
  agencyRfc: string | null;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface Importador {
  id: string;
  rfc: string;
  name: string | null;
  fiscalAddress: string | null;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
}

const AGENTE_COLS =
  `id, patente, name, agent_rfc AS "agentRfc", agency_rfc AS "agencyRfc",
   verified, created_at AS "createdAt", updated_at AS "updatedAt"`;
const IMPORTADOR_COLS =
  `id, rfc, name, fiscal_address AS "fiscalAddress",
   verified, created_at AS "createdAt", updated_at AS "updatedAt"`;

/**
 * Drop an extracted RFC that does not survive strict validation (shape + check digit).
 *
 * These values come from OCR over a pedimento PDF, where a single misread character produces a
 * well-shaped but invalid RFC. Persisting it is the worst outcome: `prevalidatePedimento` treats a
 * PRESENT-but-invalid RFC as a blocking error, while a MISSING one is only a warning — so writing
 * the bad value silently arms a hard block further down the flow, long after the person who could
 * fix it has moved on. Dropping it keeps the entity usable and leaves the field to be completed in
 * Configuración → Entidades de pedimento.
 */
function keepOnlyValidRfc(raw: string | null | undefined, label: string, key: string): string | null {
  if (!raw) return null;
  const v = cleanId(raw);
  if (isValidTaxIdStrict(v)) return v;
  console.warn(`[entityMaster] ${label} descartado por dígito verificador inválido (${key}): ${v}`);
  return null;
}

/**
 * Upsert an agente aduanal keyed by patente. Fill-only-missing (COALESCE existing first) so a
 * re-upload never overwrites a value already on the row, and never flips `verified`. Returns the
 * resolved row (post-upsert state). Returns null when no patente is supplied.
 *
 * RFCs that fail strict validation are dropped (see `keepOnlyValidRfc`) — the row is still created
 * so the patente and name are captured.
 */
export async function upsertAgente(a: {
  patente: string;
  name?: string | null;
  agentRfc?: string | null;
  agencyRfc?: string | null;
  createdBy?: string | null;
}): Promise<AgenteAduanal | null> {
  if (!a.patente) return null;
  const agentRfc = keepOnlyValidRfc(a.agentRfc, 'RFC del agente', `patente ${a.patente}`);
  const agencyRfc = keepOnlyValidRfc(a.agencyRfc, 'RFC de la agencia', `patente ${a.patente}`);
  const { rows } = await query<AgenteAduanal>(
    `INSERT INTO agentes_aduanales (patente, name, agent_rfc, agency_rfc, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (patente) DO UPDATE SET
       name       = COALESCE(agentes_aduanales.name, EXCLUDED.name),
       agent_rfc  = COALESCE(agentes_aduanales.agent_rfc, EXCLUDED.agent_rfc),
       agency_rfc = COALESCE(agentes_aduanales.agency_rfc, EXCLUDED.agency_rfc),
       updated_at = now()
     RETURNING ${AGENTE_COLS}`,
    [a.patente, a.name ?? null, agentRfc, agencyRfc, a.createdBy ?? null],
  );
  return rows[0];
}

/**
 * Upsert an importador keyed by rfc. Same fill-only-missing / never-flip-verified semantics as
 * upsertAgente. Returns null when no rfc is supplied.
 *
 * Unlike the agente, the RFC *is* the conflict key here, so an invalid one cannot simply be
 * dropped — it would have nothing left to key on. It is refused instead (returns null), because
 * inserting it creates a permanent phantom: a misread last character yields a brand-new row rather
 * than updating the real importador, leaving two entries for the same company (same name, same
 * fiscal address, RFCs differing by one character). Callers surface this as a 422 so the pedimento
 * is corrected while the person still has the PDF in front of them.
 */
export async function upsertImportador(i: {
  rfc: string;
  name?: string | null;
  fiscalAddress?: string | null;
  createdBy?: string | null;
}): Promise<Importador | null> {
  if (!i.rfc) return null;
  const rfc = cleanId(i.rfc);
  if (!isValidTaxIdStrict(rfc)) {
    console.warn(`[entityMaster] importador rechazado por dígito verificador inválido: ${rfc}`);
    return null;
  }
  const { rows } = await query<Importador>(
    `INSERT INTO importadores (rfc, name, fiscal_address, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (rfc) DO UPDATE SET
       name           = COALESCE(importadores.name, EXCLUDED.name),
       fiscal_address = COALESCE(importadores.fiscal_address, EXCLUDED.fiscal_address),
       updated_at     = now()
     RETURNING ${IMPORTADOR_COLS}`,
    [rfc, i.name ?? null, i.fiscalAddress ?? null, i.createdBy ?? null],
  );
  return rows[0];
}

export async function resolveAgenteByPatente(patente: string): Promise<AgenteAduanal | null> {
  const { rows } = await query<AgenteAduanal>(
    `SELECT ${AGENTE_COLS} FROM agentes_aduanales WHERE patente = $1`, [patente]);
  return rows[0] ?? null;
}

export async function resolveImportadorByRfc(rfc: string): Promise<Importador | null> {
  const { rows } = await query<Importador>(
    `SELECT ${IMPORTADOR_COLS} FROM importadores WHERE rfc = $1`, [rfc]);
  return rows[0] ?? null;
}

export const listAgentes = async (): Promise<AgenteAduanal[]> =>
  (await query<AgenteAduanal>(`SELECT ${AGENTE_COLS} FROM agentes_aduanales ORDER BY patente`)).rows;

export const listImportadores = async (): Promise<Importador[]> =>
  (await query<Importador>(`SELECT ${IMPORTADOR_COLS} FROM importadores ORDER BY rfc`)).rows;

/** Two RFCs of equal length differing in exactly one position — the signature of an OCR misread. */
function differsByOneChar(a: string, b: string): boolean {
  if (a.length !== b.length || a === b) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && ++diff > 1) return false;
  return diff === 1;
}

export interface ImportadorDuplicado {
  /** The row whose RFC survives strict validation — the one to keep. */
  valido: Importador;
  /** Same company, RFC off by one character — almost always an OCR artifact to delete. */
  sospechoso: Importador;
}

/**
 * Find importador rows that are almost certainly the same company recorded twice.
 *
 * The pair must share a normalized name AND have RFCs that differ in exactly one character, with
 * one side passing strict validation and the other failing it. That combination is not a
 * coincidence: it is what happens when OCR misreads a single character of the RFC and the
 * `ON CONFLICT (rfc)` upsert inserts a new row instead of updating the real one. Pairs where both
 * RFCs are valid are deliberately NOT reported — two valid RFCs one character apart can be two
 * genuinely different companies, and merging those would be worse than leaving them alone.
 */
export async function findImportadoresDuplicados(): Promise<ImportadorDuplicado[]> {
  const rows = await listImportadores();
  const norm = (v: string | null) => (v ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const out: ImportadorDuplicado[] = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i], b = rows[j];
      if (!norm(a.name) || norm(a.name) !== norm(b.name)) continue;
      if (!differsByOneChar(a.rfc, b.rfc)) continue;
      const aOk = isValidTaxIdStrict(a.rfc), bOk = isValidTaxIdStrict(b.rfc);
      if (aOk === bOk) continue; // both valid (real distinct companies) or both junk — not this case
      out.push(aOk ? { valido: a, sospechoso: b } : { valido: b, sospechoso: a });
    }
  }
  return out;
}

export const AGENTE_RETURNING = AGENTE_COLS;
export const IMPORTADOR_RETURNING = IMPORTADOR_COLS;
