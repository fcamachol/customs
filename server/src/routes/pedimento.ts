import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { buildPedimento } from '../../../shared/pedimento/buildPedimento';
import { prevalidatePedimento } from '../../../shared/pedimento/prevalidate';
import { loadShipments } from '../services/reportData';
import { upsertAgente, upsertImportador } from '../services/entityMaster';
import { normPedimentoNumero } from '../../../shared/pedimento/subdivision';
import { nextSubStatus, type SubStatus } from '../../../shared/pedimento/subStatus';

export const pedimentoRouter = Router();

const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== '' ? v.trim() : null;

// The patente is digits 5-8 of the 15-digit SAT pedimento number (AA + aduana + PATENTE + …).
// Used to re-derive the agente key when import_data does not carry an explicit patente.
function derivePatente(numero: string | null): string | null {
  const n = normPedimentoNumero(numero ?? '');
  return n.length === 15 ? n.slice(4, 8) : null;
}

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

      const d = (import_data ?? {}) as Record<string, unknown>;

      // Resolve the entities this pedimento identifies, from the catalog tables. Agente by patente
      // (import_data or re-derived from the numero); importador by import_data.importerRfc. 422 only
      // when neither source yields a key to resolve with — naming what is missing.
      const patente = strOrNull(d.patente) ?? derivePatente(numero_pedimento);
      const importerRfc = strOrNull(d.importerRfc);
      const unresolvable = [
        ...(patente ? [] : ['la patente del agente aduanal']),
        ...(importerRfc ? [] : ['el RFC del importador']),
      ];
      if (unresolvable.length) {
        res.status(422).json({ error: `No se puede resolver la entidad: falta ${unresolvable.join(' y ')}.` });
        return;
      }

      // Auto-create the rows if missing (same fill-only-missing upsert as upload) and read back the
      // resolved state. Post-upload these already exist; this covers rows captured out-of-band.
      const [agent, importer] = await Promise.all([
        upsertAgente({
          patente: patente!, name: strOrNull(d.agenteAduanal),
          agentRfc: strOrNull(d.agentRfc), agencyRfc: strOrNull(d.agencyRfc), createdBy: req.user!.userId,
        }),
        upsertImportador({
          rfc: importerRfc!, name: strOrNull(d.importerName),
          fiscalAddress: strOrNull(d.importerAddress), createdBy: req.user!.userId,
        }),
      ]);

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

      // Missing name/address/agencyRfc pass as '' — prevalidatePedimento treats an empty RFC as a
      // warning (entity sin verificar), not an error.
      const opts = {
        numeroPedimento: numero_pedimento,
        importer: { rfc: importer!.rfc, name: importer!.name ?? '', fiscalAddress: importer!.fiscalAddress ?? '' },
        agent: { patente: agent!.patente, name: agent!.name ?? '', agentRfc: agent!.agentRfc ?? '', agencyRfc: agent!.agencyRfc ?? '' },
        tipoCambio: Number(d.tipoCambio),
        customsEntryCode: String(d.claveAduanaEntrada),
        customsClearanceCode: String(d.claveAduanaDespacho),
        entryDate: String(d.fechaEntrada),
        paymentDate: String(d.paymentDate),
      };

      const ped = buildPedimento(subset.map((s) => s.data), opts);
      const prevalidation = prevalidatePedimento(ped);

      // Surface unverified entities as prevalidation warnings naming the entity.
      if (agent && !agent.verified) prevalidation.warnings.push(`Agente aduanal (patente ${agent.patente}) sin verificar.`);
      if (importer && !importer.verified) prevalidation.warnings.push(`Importador (RFC ${importer.rfc}) sin verificar.`);

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
