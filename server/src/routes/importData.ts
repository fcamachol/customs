import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { computeLock } from '../services/manifestLock';

export const importDataRouter = Router();

const FIELDS = [
  'cveT1',
  'patente',
  'agenteAduanal',
  'tasaImportacion',
  'fechaEntrada',
  'claveAduanaEntrada',
  'claveAduanaDespacho',
] as const;

interface TasaVigencia { startDate?: string; originType?: string; rate?: number }

/** Parse a captured tasa into a 0..1 fraction; accepts "0.335", "33.5", "33.5%". */
function toFraction(raw: unknown): number | null {
  if (raw == null || raw === '') return null;
  const n = parseFloat(String(raw).replace('%', '').replace(',', '.').trim());
  if (!Number.isFinite(n)) return null;
  return n > 1 ? n / 100 : n;
}

/**
 * §10 consistency check (non-blocking, parametrizable — never hard-coded). Compares the captured
 * tasa against the set of currently-effective vigencia rates (latest per originType where
 * startDate <= today). Returns a warning string when it matches none, else null. Empty catalog =>
 * no opinion (null).
 */
function checkTasaConsistency(captured: unknown, vigencias: TasaVigencia[] | undefined): string | null {
  const frac = toFraction(captured);
  if (frac == null || !Array.isArray(vigencias) || vigencias.length === 0) return null;
  const today = new Date().toISOString().slice(0, 10);
  const latestByOrigin = new Map<string, TasaVigencia>();
  for (const v of vigencias) {
    if (typeof v?.rate !== 'number') continue;
    if (v.startDate && v.startDate > today) continue; // not yet in effect
    const key = v.originType ?? 'GENERAL';
    const prev = latestByOrigin.get(key);
    if (!prev || (v.startDate ?? '') >= (prev.startDate ?? '')) latestByOrigin.set(key, v);
  }
  const expected = [...latestByOrigin.values()].map((v) => (v.rate! > 1 ? v.rate! / 100 : v.rate!));
  if (expected.length === 0) return null;
  const matches = expected.some((e) => Math.abs(e - frac) < 0.005);
  if (matches) return null;
  const pretty = expected.map((e) => `${(e * 100).toFixed(1)}%`).join(' / ');
  return `Tasa capturada (${(frac * 100).toFixed(1)}%) no coincide con la vigencia actual (${pretty}). Verificar.`;
}

importDataRouter.post(
  '/:id/import-data',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = Object.fromEntries(FIELDS.map((f) => [f, body[f] ?? null]));
    const before = await query<{
      import_data: Record<string, unknown> | null;
      import_data_version: number;
      prevalidation: { status?: string } | null;
      file_id: string | null;
    }>('SELECT import_data, import_data_version, prevalidation, file_id FROM manifests WHERE id=$1', [req.params.id]);
    if (!before.rows.length) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Edit-before-lock: once the pedimento is finalized the declaration is immutable.
    const lock = computeLock(before.rows[0]);
    if (!lock.editable) {
      res.status(409).json({ error: lock.reason, locked: true });
      return;
    }

    // §10: non-blocking tasa-global consistency warning against the parametrizable vigencias catalog.
    const cfg = await query<{ value: TasaVigencia[] }>("SELECT value FROM config WHERE key='tasa_vigencias'");
    const tasaWarning = checkTasaConsistency(data.tasaImportacion, cfg.rows[0]?.value);
    data.tasaWarning = tasaWarning;

    // Optimistic concurrency: when the client sends the version it loaded, reject if it changed.
    const expected = body.version;
    const versionGuard = typeof expected === 'number' ? ' AND import_data_version=$3' : '';
    const params: unknown[] = [JSON.stringify(data), req.params.id];
    if (typeof expected === 'number') params.push(expected);

    // Single atomic statement: write data, bump version, bust the cached report, and flag risk stale
    // (only when a risk run exists). report_file_id=NULL forces the downloaded Reporte General to
    // regenerate from the new import-data so it can never be served stale.
    const upd = await query<{ import_data_version: number }>(
      `UPDATE manifests
         SET import_data=$1,
             import_data_version=import_data_version+1,
             report_file_id=NULL,
             risk_stale=(risk_file_id IS NOT NULL)
       WHERE id=$2${versionGuard}
       RETURNING import_data_version`,
      params,
    );
    if (!upd.rows.length) {
      res.status(409).json({ error: 'El registro fue modificado por otro usuario. Recargue e intente de nuevo.', conflict: true });
      return;
    }

    await recordAudit({
      userId: req.user!.userId,
      action: 'CAPTURE_IMPORT_DATA',
      entity: 'manifest',
      entityId: req.params.id,
      before: before.rows[0].import_data,
      after: data,
      ip: req.ip,
    });
    res.json({ ok: true, importData: data, version: upd.rows[0].import_data_version });
  },
);
