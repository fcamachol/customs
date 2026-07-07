import { query } from '../db/pool';

export interface HeaderMapping {
  id: string;
  clientId: string | null;
  headerNormalized: string;
  canonicalPath: string;
  createdBy: string | null;
  createdAt: string;
}

export const HEADER_MAPPING_COLS =
  `id, client_id AS "clientId", header_normalized AS "headerNormalized",
   canonical_path AS "canonicalPath", created_by AS "createdBy", created_at AS "createdAt"`;

/**
 * Build the normalized-header → canonical-path override table that feeds ingestion for a given
 * client. Global mappings (client_id NULL) apply to everyone; a client-specific row wins over the
 * global one for the same header. With no clientId only the global rows load.
 */
export async function loadHeaderMappings(clientId?: string | null): Promise<Record<string, string>> {
  const { rows } = await query<{ header_normalized: string; canonical_path: string }>(
    `SELECT header_normalized, canonical_path FROM client_header_mappings
     WHERE client_id IS NULL OR client_id = $1
     ORDER BY client_id NULLS FIRST`,
    [clientId ?? null],
  );
  // Globals come first (NULLS FIRST); a later client-specific row overwrites the same header.
  const out: Record<string, string> = {};
  for (const r of rows) out[r.header_normalized] = r.canonical_path;
  return out;
}
