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
