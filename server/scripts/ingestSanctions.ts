#!/usr/bin/env tsx
/**
 * ingestSanctions.ts — F18: Sanctions list ingestion script.
 *
 * PURPOSE
 * -------
 * Parse a local OFAC SDN CSV file into DeniedPartyEntry[] and upsert into the
 * `denied_parties` config key. Safe to run repeatedly — uses ON CONFLICT upsert.
 *
 * USAGE (sandbox / CI)
 * ---------------------
 *   npx tsx server/scripts/ingestSanctions.ts \
 *     --source OFAC \
 *     --file server/scripts/fixtures/ofac_sdn_sample.csv
 *
 * PRODUCTION REFRESH PATH (documented — not implemented here to avoid flaky net calls)
 * --------------------------------------------------------------------------------------
 * Replace --file with a live download step. Recommended cron approach:
 *
 *   1. OFAC SDN (XML format, more structured):
 *      https://www.treasury.gov/ofac/downloads/sdn.xml  (daily update)
 *      curl -s https://www.treasury.gov/ofac/downloads/sdn.xml -o /tmp/ofac_sdn.xml
 *
 *   2. BIS Entity List (CSV):
 *      https://www.bis.doc.gov/index.php/policy-guidance/lists-of-parties-of-concern/entity-list
 *      (download CSV, then pass --source BIS --file /tmp/bis_entity_list.csv)
 *
 *   3. EU CFSP Consolidated List (XML/CSV):
 *      https://webgate.ec.europa.eu/fsd/fsf/public/files/csvFullSanctionsList/content
 *
 *   4. UN Consolidated List (XML):
 *      https://scsanctions.un.org/resources/xml/en/consolidated.xml
 *
 * Schedule this via the repo's cron infra (see CronCreate / scheduled-tasks) to run daily.
 * After download, call this script with the saved local file. Do NOT add live network calls
 * to the test path — always parse a pre-downloaded fixture in CI.
 *
 * OUTPUT
 * ------
 * Upserts the parsed list into config table key `denied_parties` as a JSONB array.
 * The list is immediately active for the next risk scoring run.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeDeniedPartyEntry } from '../src/services/deniedParties';
import type { DeniedPartyEntry } from '../../shared/risk/lists';

// ─── Simple CSV parser for OFAC SDN format ───────────────────────────────────
// The OFAC SDN CSV uses the schema:
//   ent_num, SDN_Name, SDN_Type, Program, Title, Call_Sign, Vess_type, Tonnage, GRT, Vess_flag, Vess_owner, Remarks
// The `Remarks` field sometimes contains id records of the form "id RFC XXXXXX".

function parseOfacCsv(csvText: string): DeniedPartyEntry[] {
  const lines = csvText.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return [];

  // Detect header row
  const firstLine = lines[0].toLowerCase();
  const startIndex = firstLine.includes('sdn_name') || firstLine.includes('ent_num') ? 1 : 0;

  const entries: DeniedPartyEntry[] = [];

  for (const line of lines.slice(startIndex)) {
    // Simple CSV split — handles quoted fields with commas
    const cols = splitCsvLine(line);
    if (cols.length < 4) continue;

    const name = cols[1]?.replace(/^"|"$/g, '').trim();
    const program = cols[3]?.replace(/^"|"$/g, '').trim();
    const remarks = cols[11]?.replace(/^"|"$/g, '').trim() ?? '';

    if (!name) continue;

    // Extract IDs from remarks — format: "id RFC ABCDEF123456"
    const ids: string[] = [];
    const idMatches = remarks.matchAll(/\bid\s+(?:RFC|CURP|TAX|NIT|EIN)\s+([A-Z0-9]+)/gi);
    for (const m of idMatches) {
      ids.push(m[1].trim());
    }

    const entry = normalizeDeniedPartyEntry({ name, ids, source: 'OFAC', program: program || undefined });
    if (entry) entries.push(entry);
  }

  return entries;
}

/** Minimal CSV line splitter that handles double-quoted fields. */
function splitCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  result.push(current);
  return result;
}

// ─── CLI entry point ──────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const fileIdx = args.indexOf('--file');
  const sourceIdx = args.indexOf('--source');

  const filePath = fileIdx >= 0 ? args[fileIdx + 1] : null;
  const source = (sourceIdx >= 0 ? args[sourceIdx + 1] : 'OFAC') as DeniedPartyEntry['source'];

  if (!filePath) {
    console.error('Usage: npx tsx server/scripts/ingestSanctions.ts --source OFAC --file <path>');
    console.error('');
    console.error('See the file header for the production live-download path.');
    process.exit(1);
  }

  const absPath = resolve(process.cwd(), filePath);
  console.log(`[ingestSanctions] Reading ${source} list from: ${absPath}`);

  const text = readFileSync(absPath, 'utf-8');
  let entries: DeniedPartyEntry[];

  if (source === 'OFAC') {
    entries = parseOfacCsv(text);
  } else {
    // BIS / EU / UN parsers follow the same pattern — implement as needed.
    // For now fall back to OFAC CSV format as a placeholder.
    console.warn(`[ingestSanctions] Source ${source} parser not yet implemented — using OFAC CSV parser as fallback.`);
    entries = parseOfacCsv(text);
  }

  console.log(`[ingestSanctions] Parsed ${entries.length} entries from ${source}.`);

  if (entries.length === 0) {
    console.warn('[ingestSanctions] No entries parsed — aborting upsert to avoid wiping existing list.');
    process.exit(0);
  }

  // Upsert into the config table (same SQL the catalogs PUT endpoint uses).
  // Requires DATABASE_URL to be set in the environment.
  const { query } = await import('../src/db/pool');
  await query(
    `INSERT INTO config (key, value, updated_by, updated_at)
     VALUES ('denied_parties', $1, 'ingestSanctions', now())
     ON CONFLICT (key) DO UPDATE SET value=$1, updated_by='ingestSanctions', updated_at=now()`,
    [JSON.stringify(entries)],
  );

  console.log(`[ingestSanctions] Upserted ${entries.length} denied-party entries into config key 'denied_parties'.`);
  process.exit(0);
}

main().catch((err) => {
  console.error('[ingestSanctions] Fatal error:', err);
  process.exit(1);
});

// Export for testing
export { parseOfacCsv, splitCsvLine };
