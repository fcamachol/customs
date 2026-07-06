import type { z } from 'zod';
import { query } from '../db/pool';
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
 * Upsert an agente aduanal keyed by patente. Fill-only-missing (COALESCE existing first) so a
 * re-upload never overwrites a value already on the row, and never flips `verified`. Returns the
 * resolved row (post-upsert state). Returns null when no patente is supplied.
 */
export async function upsertAgente(a: {
  patente: string;
  name?: string | null;
  agentRfc?: string | null;
  agencyRfc?: string | null;
  createdBy?: string | null;
}): Promise<AgenteAduanal | null> {
  if (!a.patente) return null;
  const { rows } = await query<AgenteAduanal>(
    `INSERT INTO agentes_aduanales (patente, name, agent_rfc, agency_rfc, created_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (patente) DO UPDATE SET
       name       = COALESCE(agentes_aduanales.name, EXCLUDED.name),
       agent_rfc  = COALESCE(agentes_aduanales.agent_rfc, EXCLUDED.agent_rfc),
       agency_rfc = COALESCE(agentes_aduanales.agency_rfc, EXCLUDED.agency_rfc),
       updated_at = now()
     RETURNING ${AGENTE_COLS}`,
    [a.patente, a.name ?? null, a.agentRfc ?? null, a.agencyRfc ?? null, a.createdBy ?? null],
  );
  return rows[0];
}

/**
 * Upsert an importador keyed by rfc. Same fill-only-missing / never-flip-verified semantics as
 * upsertAgente. Returns null when no rfc is supplied.
 */
export async function upsertImportador(i: {
  rfc: string;
  name?: string | null;
  fiscalAddress?: string | null;
  createdBy?: string | null;
}): Promise<Importador | null> {
  if (!i.rfc) return null;
  const { rows } = await query<Importador>(
    `INSERT INTO importadores (rfc, name, fiscal_address, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (rfc) DO UPDATE SET
       name           = COALESCE(importadores.name, EXCLUDED.name),
       fiscal_address = COALESCE(importadores.fiscal_address, EXCLUDED.fiscal_address),
       updated_at     = now()
     RETURNING ${IMPORTADOR_COLS}`,
    [i.rfc, i.name ?? null, i.fiscalAddress ?? null, i.createdBy ?? null],
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

export const AGENTE_RETURNING = AGENTE_COLS;
export const IMPORTADOR_RETURNING = IMPORTADOR_COLS;
