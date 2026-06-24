#!/usr/bin/env tsx
/**
 * backfill-pii-encryption.ts — F20c: PII encryption + blind-index backfill script.
 *
 * PURPOSE
 * -------
 * Bring existing plaintext rows up to the F20c encrypted state:
 *
 *   (a) shipments / manifest_staging_rows:
 *       Encrypt consignee/sender/platform PII fields (skip rows whose consignee.name
 *       already starts with "v1:" — idempotent). Populate consignee.nameBidx and
 *       consignee.addressBidx sidecars from plaintext BEFORE encrypting.
 *
 *   (b) monthly_history:
 *       Set consignee_name_bidx = rawBlindIndex(consignee_name_norm) WHERE null.
 *       This makes loadHistoryCounts return token keys for all rows, not just new ones.
 *
 * USAGE
 * -----
 *   npx tsx server/scripts/backfill-pii-encryption.ts [--dry-run] [--batch-size=200]
 *
 * FLAGS
 *   --dry-run       Log what would change, make NO mutations. Safe to run anytime.
 *   --batch-size=N  Rows per transaction (default: 200). Larger batches = fewer round-trips
 *                   but longer locks; keep below 500 for prod.
 *
 * RESUMABILITY
 * ------------
 * Each batch processes only rows that still need backfill:
 *   - shipments: WHERE data->'consignee'->>'name' NOT LIKE 'v1:%'
 *   - monthly_history: WHERE consignee_name_bidx IS NULL
 * Re-running after partial failure simply picks up where it left off.
 *
 * REQUIREMENTS
 * ------------
 * Must run with both FIELD_ENCRYPTION_KEY and BLIND_INDEX_PEPPER set.
 * Run AFTER the 1700002400000_monthly_history_bidx migration has been applied.
 *
 * EXAMPLE
 * -------
 *   set -a; source server/.env; set +a
 *   npx tsx server/scripts/backfill-pii-encryption.ts --dry-run
 *   npx tsx server/scripts/backfill-pii-encryption.ts --batch-size=100
 */

import { Pool } from 'pg';
import { encryptShipmentPii } from '../src/crypto/fieldCrypto';
import { rawBlindIndex } from '../src/crypto/blindIndex';
import type { Shipment } from '../../shared/types/shipment';

// ── Argument parsing ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const batchArg = args.find((a) => a.startsWith('--batch-size='));
const BATCH_SIZE = batchArg ? Math.max(1, parseInt(batchArg.split('=')[1], 10)) : 200;

const DB_URL = process.env.DATABASE_URL ?? process.env.TEST_DATABASE_URL;
if (!DB_URL) {
  console.error('[backfill] ERROR: DATABASE_URL (or TEST_DATABASE_URL) is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DB_URL });

// ── Helpers ───────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[backfill${DRY_RUN ? ':dry-run' : ''}] ${msg}`);
}

// ── Phase A: backfill shipments ───────────────────────────────────────────────

async function backfillShipments(): Promise<void> {
  log('Phase A: backfilling shipments PII encryption + bidx sidecars…');

  let total = 0;
  let offset = 0;
  let batchNum = 0;

  while (true) {
    // Fetch a batch of un-encrypted shipment rows (where consignee.name is plaintext)
    const { rows } = await pool.query<{ id: string; data: Shipment }>(
      `SELECT id, data FROM shipments
       WHERE data->'consignee'->>'name' NOT LIKE 'v1:%'
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset],
    );

    if (rows.length === 0) break;
    batchNum++;
    log(`  Batch ${batchNum}: processing ${rows.length} shipment rows…`);

    if (!DRY_RUN) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const encrypted = encryptShipmentPii(row.data);
          await client.query(
            `UPDATE shipments SET data = $1 WHERE id = $2`,
            [JSON.stringify(encrypted), row.id],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      log(`    [dry-run] Would encrypt ${rows.length} shipments.`);
    }

    total += rows.length;
    // In dry-run we don't mutate, so incrementing offset avoids infinite loop
    offset += rows.length;
  }

  log(`Phase A complete: ${total} shipment row(s) ${DRY_RUN ? 'would be' : ''} backfilled.`);
}

// ── Phase B: backfill manifest_staging_rows ───────────────────────────────────

async function backfillStagingRows(): Promise<void> {
  log('Phase B: backfilling manifest_staging_rows PII encryption…');

  let total = 0;
  let offset = 0;
  let batchNum = 0;

  while (true) {
    const { rows } = await pool.query<{ id: string; data: Shipment }>(
      `SELECT id, data FROM manifest_staging_rows
       WHERE data->'consignee'->>'name' NOT LIKE 'v1:%'
       ORDER BY id
       LIMIT $1 OFFSET $2`,
      [BATCH_SIZE, offset],
    );

    if (rows.length === 0) break;
    batchNum++;
    log(`  Batch ${batchNum}: processing ${rows.length} staging rows…`);

    if (!DRY_RUN) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const encrypted = encryptShipmentPii(row.data);
          await client.query(
            `UPDATE manifest_staging_rows SET data = $1 WHERE id = $2`,
            [JSON.stringify(encrypted), row.id],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      log(`    [dry-run] Would encrypt ${rows.length} staging rows.`);
    }

    total += rows.length;
    offset += rows.length;
  }

  log(`Phase B complete: ${total} staging row(s) ${DRY_RUN ? 'would be' : ''} backfilled.`);
}

// ── Phase C: backfill monthly_history bidx ────────────────────────────────────

async function backfillMonthlyHistoryBidx(): Promise<void> {
  log('Phase C: backfilling monthly_history consignee_name_bidx…');

  let total = 0;
  let batchNum = 0;

  while (true) {
    // Fetch a batch of rows with NULL bidx
    const { rows } = await pool.query<{ id: string; consignee_name_norm: string }>(
      `SELECT id, consignee_name_norm FROM monthly_history
       WHERE consignee_name_bidx IS NULL
       ORDER BY id
       LIMIT $1`,
      [BATCH_SIZE],
    );

    if (rows.length === 0) break;
    batchNum++;
    log(`  Batch ${batchNum}: computing bidx for ${rows.length} monthly_history rows…`);

    if (!DRY_RUN) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const bidx = rawBlindIndex(row.consignee_name_norm);
          await client.query(
            `UPDATE monthly_history SET consignee_name_bidx = $1 WHERE id = $2`,
            [bidx, row.id],
          );
        }
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    } else {
      // In dry-run show a sample
      for (const row of rows.slice(0, 3)) {
        const bidx = rawBlindIndex(row.consignee_name_norm);
        log(`    [dry-run] id=${row.id} norm="${row.consignee_name_norm}" → bidx=${bidx.slice(0, 16)}…`);
      }
      if (rows.length > 3) log(`    [dry-run] … and ${rows.length - 3} more.`);
      // In dry-run, break after first batch to avoid infinite loop
      total += rows.length;
      break;
    }

    total += rows.length;
  }

  log(`Phase C complete: ${total} monthly_history row(s) ${DRY_RUN ? 'would be' : ''} backfilled.`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  log(`Starting PII encryption backfill (batch_size=${BATCH_SIZE}, dry_run=${DRY_RUN})`);
  log('');

  try {
    await backfillShipments();
    log('');
    await backfillStagingRows();
    log('');
    await backfillMonthlyHistoryBidx();
    log('');
    log('All phases complete.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[backfill] FATAL:', err);
  process.exit(1);
});
