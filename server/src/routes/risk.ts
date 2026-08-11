import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { runRiskForManifest } from '../services/riskService';
import { scoreLegacyParity } from '../../../shared/risk/legacyParity';
import { traducirDescripcion } from '../../../shared/i18n/descripcionEs';
import { validate } from '../validation/middleware';
import { riskBody } from '../validation/schemas';

export const riskRouter = Router();

/**
 * POST /api/manifests/:id/risk — human-triggered scoring.
 *
 * The scoring itself now lives in services/riskService.ts so the prealerta pipeline can run exactly
 * the same code unattended. What stays here is what belongs to the HTTP surface: the role gate, the
 * legacy-parity column the UI renders alongside the current engine, and the response shape.
 */
riskRouter.post(
  '/:id/risk',
  requireAuth,
  requireRole('admin', 'capturista'),
  validate({ body: riskBody }),
  async (req, res) => {
    const period: string = req.body.period ?? new Date().toISOString().slice(0, 7);
    const result = await runRiskForManifest({
      manifestId: req.params.id,
      period,
      userId: req.user!.userId,
    });

    if (!result) {
      // No promoted shipments. Previously this produced an empty-but-successful score; saying so
      // explicitly is more useful, because the usual cause is a manifest whose rows all failed
      // validation and therefore never reached the gold layer.
      const vacio = { analizados: 0, aprobados: 0, noIdentificados: 0, validarEnPrevio: 0, sinDatos: 0 };
      res.json({ rows: [], summary: vacio, summaryEfectivo: vacio });
      return;
    }

    const { scored, shipments, summary, summaryEfectivo } = result;

    await recordAudit({
      userId: req.user!.userId,
      action: 'RUN_RISK',
      entity: 'manifest',
      entityId: req.params.id,
      after: summary,
      ip: req.ip,
    });

    // Legacy parity expects a Set of pre-normalized PLAINTEXT names (norm(name)). The history counts
    // the engine consumes are token-keyed (F20c), so this queries consignee_name_norm separately —
    // the two key spaces are not interchangeable.
    const { rows: normRows } = await query<{ consignee_name_norm: string }>(
      `SELECT DISTINCT consignee_name_norm FROM monthly_history WHERE period=$1 AND (manifest_id IS NULL OR manifest_id <> $2)`,
      [period, req.params.id],
    );
    const monthlyDbNames = new Set(normRows.map((r) => r.consignee_name_norm));
    const legacyRows = scoreLegacyParity(shipments, monthlyDbNames);

    res.json({
      rows: scored.map((s, i) => ({
        mwb: s.shipment.mawbReference,
        guide: s.shipment.guideId,
        consignee: s.shipment.consignee.name,
        senderCity: s.shipment.sender.address ?? '',
        senderCountry: s.shipment.platform.countryOfOrigin ?? s.shipment.originCountry,
        description: traducirDescripcion(s.shipment.description ?? ''),
        resultado: s.color,
        resultadoLegacy: legacyRows[i].resultado,
        motivo: s.incidences.join('; '),
      })),
      summary,
      // El resumen tras las disposiciones humanas vigentes. Idéntico a `summary` mientras no exista
      // ninguna —el estado normal— y distinto justo después de sustituir un manifiesto que sí las
      // tenía: la pantalla del alta necesita poder enseñar los dos sin volver a preguntar.
      summaryEfectivo,
    });
  },
);
