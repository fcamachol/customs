#!/usr/bin/env tsx
/**
 * backfill-pedimento-import-data.ts — re-derive the import_data prefill fields whose sourcing
 * changed after the client's Reporte General observations (2026-07):
 *
 *   - claveAduanaEntrada / claveAduanaDespacho — now the MEDIOS DE TRANSPORTE claves
 *     (ENTRADA/SALIDA y ARRIBO, Apéndice 3), not the aduana-section codes (e.g. 7/7, not 240/850).
 *   - noRegistro  — COMPLEMENTO 1 of the pedimento-level EM identifier (e.g. "147").
 *   - noPedimento — consecutivo of NUM. PEDIMENTO (e.g. "6001719").
 *
 * For every pedimentos row with a stored PDF, re-runs the extractor over the blob and overwrites
 * ONLY those four keys (plus fechaEntrada when it was never captured), then busts the cached
 * report_file_id so the next Reporte General download regenerates. Rows whose PDF cannot be
 * parsed are left untouched and reported.
 *
 * USAGE
 *   npx tsx server/scripts/backfill-pedimento-import-data.ts [--dry-run]
 */
import { readFile } from 'node:fs/promises';
import { query, pool } from '../src/db/pool';
import { extractPedimento } from '../src/services/pdfExtract';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const { rows } = await query<{
    id: string;
    numero_pedimento: string | null;
    import_data: Record<string, unknown> | null;
    storage_path: string | null;
  }>(
    `SELECT p.id, p.numero_pedimento, p.import_data, f.storage_path
       FROM pedimentos p LEFT JOIN files f ON f.id = p.file_id`,
  );
  let updated = 0, skipped = 0;
  for (const r of rows) {
    if (!r.storage_path) { skipped++; console.warn(`- ${r.id}: sin PDF adjunto, se omite`); continue; }
    let extracted;
    try {
      extracted = await extractPedimento(await readFile(r.storage_path));
    } catch (err) {
      skipped++;
      console.warn(`- ${r.id}: PDF ilegible (${(err as Error).message}), se omite`);
      continue;
    }
    const h = extracted.header;
    const next: Record<string, unknown> = { ...(r.import_data ?? {}) };
    if (h.medioTransporteEntrada != null) next.claveAduanaEntrada = h.medioTransporteEntrada;
    if (h.medioTransporteArribo != null) next.claveAduanaDespacho = h.medioTransporteArribo;
    if (h.t1RegistryNumber != null) next.noRegistro = h.t1RegistryNumber;
    const numero = h.numeroPedimento ?? r.numero_pedimento;
    if (numero) next.noPedimento = numero.replace(/\D/g, '').slice(-7);
    if (next.fechaEntrada == null && h.entryDate != null) next.fechaEntrada = h.entryDate;

    const changed = JSON.stringify(next) !== JSON.stringify(r.import_data ?? {});
    if (!changed) { skipped++; continue; }
    console.log(`${dryRun ? '[dry-run] ' : ''}${r.id} (${numero ?? 'sin número'}):`, {
      claveAduanaEntrada: next.claveAduanaEntrada, claveAduanaDespacho: next.claveAduanaDespacho,
      noRegistro: next.noRegistro, noPedimento: next.noPedimento,
    });
    if (!dryRun) {
      await query(
        `UPDATE pedimentos
            SET import_data=$1, import_data_version=import_data_version+1, report_file_id=NULL
          WHERE id=$2`,
        [JSON.stringify(next), r.id],
      );
    }
    updated++;
  }
  console.log(`\n${dryRun ? '[dry-run] ' : ''}actualizados: ${updated} · sin cambios/omitidos: ${skipped}`);
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => pool.end());
