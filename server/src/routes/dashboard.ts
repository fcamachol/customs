import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth } from '../auth/middleware';
import { canSeeAll } from '../auth/access';
import { buildDashboardResponse } from './dashboardData';

export const dashboardRouter = Router();

dashboardRouter.get('/', requireAuth, async (req, res) => {
  const all = canSeeAll(req.user!.role);
  const scope = all ? '' : ' WHERE created_by=$1';
  const args = all ? [] : [req.user!.userId];

  const m = await query(`SELECT count(*)::int AS n FROM manifests${scope}`, args);
  // El color que se cuenta es el EFECTIVO: `risk_color_efectivo` cuando un humano dispuso algo sobre
  // la línea, el del motor cuando no. NULL = sin disposición, así que mientras no exista ninguna esto
  // devuelve exactamente la distribución de siempre. El tablero no aprende qué es una disposición.
  const d = await query(
    `SELECT COALESCE(s.risk_color_efectivo, s.risk_color) AS risk_color, count(*)::int AS n
     FROM shipments s JOIN manifests mf ON mf.id=s.manifest_id
     WHERE s.risk_color IS NOT NULL${all ? '' : ' AND mf.created_by=$1'}
     GROUP BY 1`, args);

  let byUserRows;
  if (all) {
    const bu = await query(
      `SELECT mf.created_by AS "userId", u.username,
              (SELECT count(*)::int FROM manifests m2 WHERE m2.created_by=mf.created_by) AS manifests,
              COALESCE(s.risk_color_efectivo, s.risk_color) AS risk_color, count(*)::int AS n
       FROM shipments s
       JOIN manifests mf ON mf.id=s.manifest_id
       JOIN users u ON u.id=mf.created_by
       WHERE s.risk_color IS NOT NULL
       GROUP BY mf.created_by, u.username, COALESCE(s.risk_color_efectivo, s.risk_color)
       ORDER BY u.username`, []);
    byUserRows = bu.rows;
  }

  res.json(buildDashboardResponse({
    manifests: m.rows[0].n as number,
    distRows: d.rows as { risk_color: string; n: number }[],
    byUserRows: byUserRows as { userId: string; username: string; manifests: number; risk_color: string | null; n: number }[] | undefined,
  }));
});
