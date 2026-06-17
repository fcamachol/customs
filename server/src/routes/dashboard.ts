import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';

export const dashboardRouter = Router();

dashboardRouter.get('/', requireAuth, async (req, res) => {
  const uid = req.user!.userId;
  const m = await query(`SELECT count(*)::int AS n FROM manifests WHERE created_by=$1`, [uid]);
  const d = await query(
    `SELECT s.risk_color, count(*)::int AS n
     FROM shipments s JOIN manifests mf ON mf.id=s.manifest_id
     WHERE mf.created_by=$1 AND s.risk_color IS NOT NULL GROUP BY s.risk_color`, [uid]);
  const distribution: Record<string, number> = { verde: 0, amarillo: 0, rojo: 0 };
  for (const row of d.rows) distribution[row.risk_color] = row.n;
  res.json({ manifests: m.rows[0].n, distribution });
});
