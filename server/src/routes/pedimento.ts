import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { buildPedimento } from '../../../shared/pedimento/buildPedimento';
import { prevalidatePedimento } from '../../../shared/pedimento/prevalidate';
import { loadShipments } from '../services/reportData';
import { loadImporterOfRecord, loadCustomsAgent } from '../services/entityMaster';
import { nextSubStatus, type SubStatus } from '../../../shared/pedimento/subStatus';

export const pedimentoRouter = Router();

// Per-pedimento build + prevalidación (Task 9 cutover).
//
// This pedimento is its own customs submission (subdivisión) over its assigned guía subset; the
// build must operate only on those shipments, not the entire manifest, so downstream SAT/VUCEM
// fields reflect the correct declared values for this subdivision.
//
// Task 1 (Phase 4): the route no longer reads req.body. It assembles BuildOptions from the row's
// numero_pedimento + import_data + configured importer_of_record/customs_agent entities.
// Returns 422 when entities are unconfigured or required import_data fields are missing.
pedimentoRouter.post(
  '/:pedimentoId/pedimento',
  requireAuth,
  requireRole('admin', 'capturista'),
  async (req, res, next) => {
    try {
      const { rows } = await query<{
        manifest_id: string;
        covered_guias: string[] | null;
        sub_status: SubStatus;
        numero_pedimento: string | null;
        import_data: Record<string, unknown> | null;
      }>(
        'SELECT manifest_id, covered_guias, sub_status, numero_pedimento, import_data FROM pedimentos WHERE id=$1',
        [req.params.pedimentoId],
      );
      if (!rows.length) {
        res.status(404).json({ error: 'Pedimento not found' });
        return;
      }
      const { manifest_id, covered_guias, sub_status: current, numero_pedimento, import_data } = rows[0];
      const coveredSet = new Set(covered_guias ?? []);

      // Load all manifest shipments (decrypted), then narrow to this pedimento's guía subset.
      // An empty subset means no shipments are assigned to this subdivision — reject with 400 so
      // the caller can fix covered_guias before retrying (mirrors the old "No shipments for manifest").
      const allShipments = await loadShipments(manifest_id);
      const subset = coveredSet.size > 0
        ? allShipments.filter((s) => coveredSet.has(s.data.guideId))
        : [];

      if (!subset.length) {
        res.status(400).json({
          error: 'No shipments assigned to this pedimento subdivision. Assign covered_guias first.',
        });
        return;
      }

      // Assemble BuildOptions from configured entities + persisted import_data.
      const [importer, agent] = await Promise.all([loadImporterOfRecord(), loadCustomsAgent()]);
      if (!importer || !agent) {
        res.status(422).json({ error: 'Configure el importador de registro y el agente aduanal antes de prevalidar.' });
        return;
      }
      const d = (import_data ?? {}) as Record<string, unknown>;
      const missing = ['tipoCambio', 'claveAduanaEntrada', 'claveAduanaDespacho', 'fechaEntrada', 'paymentDate']
        .filter((k) => d[k] == null || d[k] === '');
      // A zero (or negative) tipoCambio is never valid — treat it the same as missing.
      if (!(Number(d.tipoCambio) > 0) && !missing.includes('tipoCambio')) missing.push('tipoCambio');
      if (!numero_pedimento || missing.length) {
        res.status(422).json({
          error: `Faltan datos para prevalidar: ${[...(numero_pedimento ? [] : ['número de pedimento']), ...missing].join(', ')}.`,
        });
        return;
      }
      const opts = {
        numeroPedimento: numero_pedimento,
        importer: { rfc: String(importer.rfc), name: String(importer.name), fiscalAddress: String(importer.fiscalAddress) },
        agent: { patente: String(agent.patente), name: String(agent.name), agentRfc: String(agent.agentRfc), agencyRfc: String(agent.agencyRfc) },
        tipoCambio: Number(d.tipoCambio),
        customsEntryCode: String(d.claveAduanaEntrada),
        customsClearanceCode: String(d.claveAduanaDespacho),
        entryDate: String(d.fechaEntrada),
        paymentDate: String(d.paymentDate),
      };

      const ped = buildPedimento(subset.map((s) => s.data), opts);
      const prevalidation = prevalidatePedimento(ped);

      // Lifecycle guard: only rows in 'capturado' or 'prevalidado' may transition via prevalidation.
      const event = prevalidation.status === 'APPROVED' ? 'prevalidate_pass' : 'prevalidate_block';
      const t = nextSubStatus(current, event);
      if (!t.ok) {
        res.status(409).json({ error: t.reason });
        return;
      }

      // Write to the pedimentos row — manifests.pedimento / manifests.prevalidation are no longer
      // written after this cutover (Task 9). The manifests columns will be dropped in Task 11.
      await query(
        'UPDATE pedimentos SET pedimento=$1, prevalidation=$2, sub_status=$3 WHERE id=$4',
        [JSON.stringify(ped), JSON.stringify(prevalidation), t.next, req.params.pedimentoId],
      );

      await recordAudit({
        userId: req.user!.userId,
        action: 'GENERATE_PEDIMENTO',
        entity: 'pedimento',
        entityId: req.params.pedimentoId,
        after: { numeroPedimento: ped.header.numeroPedimento, status: prevalidation.status },
        ip: req.ip,
      });

      res.status(201).json({ pedimento: ped, prevalidation });
    } catch (err) {
      next(err);
    }
  },
);
