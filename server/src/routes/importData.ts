import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { computeLock } from '../services/manifestLock';
import { nextSubStatus } from '../../../shared/pedimento/subStatus';
import type { SubStatus } from '../../../shared/pedimento/subStatus';
import { validate } from '../validation/middleware';
import { importDataBody } from '../validation/schemas';

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

// Capture is now per-pedimento (subdivisión): :pedimentoId addresses a pedimentos row, and
// import_data + lock are read/written on that row. manifests.import_data is no longer written.
importDataRouter.post(
  '/:pedimentoId/import-data',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ body: importDataBody }),
  async (req, res) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const data: Record<string, unknown> = Object.fromEntries(FIELDS.map((f) => [f, body[f] ?? null]));
    const before = await query<{
      manifest_id: string;
      import_data: Record<string, unknown> | null;
      import_data_version: number;
      sub_status: SubStatus;
    }>(
      'SELECT manifest_id, import_data, import_data_version, sub_status FROM pedimentos WHERE id=$1',
      [req.params.pedimentoId],
    );
    if (!before.rows.length) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    // Edit-before-lock: once THIS pedimento is finalized (sub_status='cargado') the declaration is
    // immutable. The source PDF no longer locks; only the lifecycle sub_status gates capture.
    const lock = computeLock({ sub_status: before.rows[0].sub_status });
    if (!lock.editable) {
      res.status(409).json({ error: lock.reason, locked: true });
      return;
    }

    // §10: non-blocking tasa-global consistency warning against the parametrizable vigencias catalog.
    const cfg = await query<{ value: TasaVigencia[] }>("SELECT value FROM config WHERE key='tasa_vigencias'");
    const tasaWarning = checkTasaConsistency(data.tasaImportacion, cfg.rows[0]?.value);
    data.tasaWarning = tasaWarning;

    // Advance sub_status: lock guard already excluded 'cargado', so t.ok is always true here.
    const t = nextSubStatus(before.rows[0].sub_status, 'capture');

    // Optimistic concurrency: when the client sends the version it loaded, reject if it changed.
    // Params: $1=data, $2=id, $3=sub_status_next, [$4=expected_version when provided].
    const expected = body.version;
    const versionGuard = typeof expected === 'number' ? ' AND import_data_version=$4' : '';
    const params: unknown[] = [JSON.stringify(data), req.params.pedimentoId, t.next];
    if (typeof expected === 'number') params.push(expected);

    // Single atomic statement on the pedimentos row: write data + bump version + advance sub_status
    // + bust this pedimento's own cached Reporte General (report_file_id) so the next download
    // regenerates from the new import-data. Risk is no longer keyed on import_data (risk is
    // per-manifest), so we do NOT touch risk_stale here. The report cache is per-pedimento
    // (Task 10), so only THIS row busts.
    const upd = await query<{ import_data_version: number }>(
      `UPDATE pedimentos
         SET import_data=$1,
             import_data_version=import_data_version+1,
             report_file_id=NULL,
             sub_status=$3
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
      entity: 'pedimento',
      entityId: req.params.pedimentoId,
      before: before.rows[0].import_data,
      after: data,
      ip: req.ip,
    });
    res.json({ ok: true, importData: data, version: upd.rows[0].import_data_version });
  },
);
