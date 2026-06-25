import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireRole } from '../auth/middleware';
import { saveFile } from '../storage/files';
import { query } from '../db/pool';
import { isUniqueViolation } from '../db/errors';
import { recordAudit } from '../services/audit';
import { loadScanPolicy, scanPedimentoPdf } from '../services/pdfScan';
import { extractPedimento } from '../services/pdfExtract';
import { normPedimentoNumero } from '../../../shared/pedimento/subdivision';
import type { SubdivisionInfo } from '../../../shared/pedimento/subdivision';
import { loadShipments } from '../services/reportData';
import type { ExtractedPedimento, ReconciliationReport } from '../../../shared/types/reports';
import { buildExpectedFromManifest, reconcile } from '../../../shared/pedimento/reconcile';
import { crossCheckEntities } from '../../../shared/pedimento/entityCrossCheck';
import { loadImporterOfRecord, loadCustomsAgent } from '../services/entityMaster';

const EMPTY_SUBDIVISION: SubdivisionInfo = { masterGuide: null, ordinal: null, isLast: false, siblings: [], bultos: null, pesoBrutoKg: null };

// Fallback when a scan-clean PDF cannot be parsed (see best-effort note at the call site).
const EMPTY_EXTRACTED: ExtractedPedimento = {
  header: { numeroPedimento: null, clave: null, importerRfc: null, agentRfc: null, agencyRfc: null,
    patente: null, customsClearanceCode: null, tipoCambio: null, entryDate: null, paymentDate: null,
    totalBultos: null },
  lines: [],
  extractionMethod: 'deterministic',
  usedPositional: false,
  confidence: 0,
  warnings: [],
  subdivision: EMPTY_SUBDIVISION,
  coveredGuias: [],
};

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
export const pedimentoUploadRouter = Router();

// Master-guide normalization for the hard gate (decision #2). Master-guide strings carry
// punctuation / prefixes ("GUIA MASTER NO. 369-94268462" → parsed "369-94268462"; manifest
// mawb_reference may be "369-1"). Strip everything that is not a letter or digit and compare
// case-insensitively so formatting differences (dashes, spaces, casing) never trigger a false
// mismatch — only a genuinely different guide does.
function normMasterGuide(s: string): string {
  return (s ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
}

pedimentoUploadRouter.post('/:id/pedimento-pdf', requireAuth, requireRole('admin', 'capturista'), upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'file required' }); return; }

  // RF-08: validate MIME type — must be a PDF
  if (req.file.mimetype !== 'application/pdf') {
    res.status(400).json({ error: 'El archivo debe ser un PDF' });
    return;
  }

  // RF-08: reject empty files
  if (req.file.size <= 0) {
    res.status(400).json({ error: 'El archivo no puede estar vacío' });
    return;
  }

  // RF-08: configurable minimum size (default 0 — does not block small test fixtures)
  const minBytes = parseInt(process.env.PEDIMENTO_MIN_BYTES ?? '0', 10);
  if (minBytes > 0 && req.file.size < minBytes) {
    res.status(400).json({ error: `El archivo debe tener al menos ${minBytes} bytes` });
    return;
  }

  // RF-08/RF-10: scan for active content and QR trojans before persisting.
  const policy = await loadScanPolicy();
  const scan = await scanPedimentoPdf(req.file.buffer, policy);
  const scanSummary = { verdict: scan.verdict, motors: scan.motors, codes: scan.findings.map((f) => f.code) };

  if (scan.verdict === 'blocked') {
    await query(
      'INSERT INTO pedimento_scans (manifest_id, file_id, verdict, result, created_by) VALUES ($1,$2,$3,$4,$5)',
      [req.params.id, null, scan.verdict, JSON.stringify(scan), req.user!.userId],
    );
    await recordAudit({ userId: req.user!.userId, action: 'PEDIMENTO_SCAN_BLOCKED', entity: 'manifest', entityId: req.params.id, after: scanSummary, ip: req.ip });
    res.status(422).json({ error: 'El PDF contiene contenido activo no permitido', scan });
    return;
  }

  // Extract the pedimento: numero, subdivisión metadata and covered guías. This drives the
  // multi-pedimento (subdivisión) row that we now persist instead of manifest columns.
  // Extraction is best-effort: a scan-clean PDF whose text we cannot parse (malformed structure,
  // image-only scan) must still attach — we simply cannot gate or auto-populate from it. We never
  // 500 the upload on a parse failure; the gates below are skipped when fields come back null.
  // Collected non-blocking warnings surfaced in the 201 body (best-effort attach still proceeds).
  const warnings: string[] = [];
  let extracted: ExtractedPedimento;
  try {
    extracted = await extractPedimento(req.file.buffer);
  } catch {
    extracted = EMPTY_EXTRACTED;
    // Signal that extraction yielded nothing, so the masterGuide/duplicate gates were skipped and
    // no numero/subdivisión metadata could be auto-populated — the row is attached unverified.
    warnings.push('pdf_unparseable');
  }
  const numeroPedimento = extracted.header.numeroPedimento;
  const { subdivision } = extracted;

  // Hard-gate (400): the parsed master guide must match the manifest's mawb_reference.
  // If the master guide could not be parsed (null), we cannot verify it — proceed (decision #2).
  const mRows = await query<{ mawb_reference: string | null }>('SELECT mawb_reference FROM manifests WHERE id=$1', [req.params.id]);
  if (!mRows.rows.length) { res.status(404).json({ error: 'Manifest not found' }); return; }
  const mawbReference = mRows.rows[0].mawb_reference;
  if (subdivision.masterGuide && normMasterGuide(subdivision.masterGuide) !== normMasterGuide(mawbReference ?? '')) {
    res.status(400).json({
      error: 'La guía master del pedimento no coincide con el manifiesto',
      masterGuide: subdivision.masterGuide,
      mawbReference,
    });
    return;
  }

  // Duplicate gate (409): a SAT pedimento number belongs to exactly one manifest, so reject if the
  // same normalized numero exists ANYWHERE (this manifest or another). normPedimentoNumero strips
  // non-digits so formatting never masks a dup. Backed by the pedimentos_numero_global_uq index.
  if (numeroPedimento) {
    const norm = normPedimentoNumero(numeroPedimento);
    if (norm) {
      const dup = await query<{ numero_pedimento: string | null }>('SELECT numero_pedimento FROM pedimentos');
      if (dup.rows.some((r) => normPedimentoNumero(r.numero_pedimento ?? '') === norm)) {
        res.status(409).json({ error: 'Ya existe un pedimento con este número', numeroPedimento });
        return;
      }
    }
  }

  // Overlap gate (409, Poka-Yoke): within a manifest each guía is covered by at most one pedimento.
  // Two subdivisiones may not declare the same shipment. Only enforced when guías were extracted.
  if (extracted.coveredGuias.length > 0) {
    const others = await query<{ covered_guias: string[] | null }>(
      'SELECT covered_guias FROM pedimentos WHERE manifest_id=$1', [req.params.id]);
    const alreadyCovered = new Set(others.rows.flatMap((r) => r.covered_guias ?? []));
    const overlap = extracted.coveredGuias.filter((g) => alreadyCovered.has(g));
    if (overlap.length > 0) {
      res.status(409).json({ error: `El pedimento cubre guías ya cubiertas por otro pedimento: ${overlap.join(', ')}`, overlap });
      return;
    }
  }

  const meta = await saveFile({ kind: 'pedimento_pdf', originalName: req.file.originalname, bytes: req.file.buffer, uploadedBy: req.user!.userId });

  // Pre-fill the capture form from the extracted header (best-effort). Store only the non-null
  // fields; null when nothing was extracted, so an unparseable PDF leaves import_data NULL.
  const h = extracted.header;
  const prefillEntries: [string, unknown][] = [
    ['cveT1', h.clave], ['patente', h.patente], ['fechaEntrada', h.entryDate],
    ['tipoCambio', h.tipoCambio], ['paymentDate', h.paymentDate],
  ].filter(([, v]) => v != null) as [string, unknown][];
  const importPrefill = prefillEntries.length ? Object.fromEntries(prefillEntries) : null;

  // Load all manifest shipments once — reused for both the stray-guía check and reconciliation.
  const allShipments = await loadShipments(req.params.id);

  // Advisory reconciliation: expected (manifest, covered-guía subset) vs extracted (PDF). Best-effort.
  let reconciliation: ReconciliationReport | null = null;
  try {
    if (extracted.lines.length > 0 || extracted.coveredGuias.length > 0) {
      const covered = new Set(extracted.coveredGuias);
      const subset = allShipments
        .map((s) => s.data)
        .filter((d) => covered.size === 0 || covered.has(d.guideId));
      const { expected, warnings: bwWarnings } = buildExpectedFromManifest(
        subset.map((d) => ({
          guideId: d.guideId,
          customsValueUsd: d.customsValueUsd,
          consignee: { name: d.consignee.name, rfc: d.consignee.rfc, curp: d.consignee.curp },
        })),
      );
      const [importer, agent] = await Promise.all([loadImporterOfRecord(), loadCustomsAgent()]);
      // crossCheckEntities expects { rfc: string } but the Zod-inferred type with .passthrough()
      // makes the field optional. The schema validates rfc is required, so the cast is safe.
      const xc = crossCheckEntities(
        extracted.header,
        importer ? (importer as { rfc: string }) : null,
        agent ? (agent as { patente: string; agentRfc: string; agencyRfc: string }) : null,
      );
      const notes = [...bwWarnings];
      if (xc.importerRfcMismatch) notes.push('RFC del importador en el PDF no coincide con el importador de registro.');
      if (xc.patenteMismatch) notes.push('La patente del PDF no coincide con el agente aduanal configurado.');
      const report = reconcile(expected, extracted, { notes, generatedAt: new Date().toISOString() });
      report.header = [
        { field: 'importerRfc', expected: importer?.rfc ?? null, actual: extracted.header.importerRfc, ok: !xc.importerRfcMismatch },
        { field: 'patente', expected: agent?.patente ?? null, actual: extracted.header.patente, ok: !xc.patenteMismatch },
      ];
      reconciliation = report;
    }
  } catch {
    reconciliation = null; // advisory — never block the upload
  }

  // INSERT the pedimentos row (decision #1). file_id/pedimento_scan now live here, not on manifests.
  // try/catch backstops the app-level dup check against a concurrent insert hitting
  // pedimentos_numero_global_uq.
  let ins: { rows: { id: string }[] };
  try {
    ins = await query<{ id: string }>(
      `INSERT INTO pedimentos
         (manifest_id, numero_pedimento, master_guide, subdivision_ordinal, is_last_subdivision,
          sibling_numeros, bultos, peso_bruto_kg, covered_guias, file_id, pedimento_scan, created_by,
          import_data, pedimento_reconciliation)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [
        req.params.id,
        numeroPedimento,
        subdivision.masterGuide,
        subdivision.ordinal,
        subdivision.isLast,
        subdivision.siblings,
        subdivision.bultos,
        subdivision.pesoBrutoKg,
        extracted.coveredGuias,
        meta.id,
        JSON.stringify(scan),
        req.user!.userId,
        importPrefill ? JSON.stringify(importPrefill) : null,
        reconciliation ? JSON.stringify(reconciliation) : null,
      ],
    );
  } catch (err) {
    if (isUniqueViolation(err)) {
      res.status(409).json({ error: 'Ya existe un pedimento con este número', numeroPedimento });
      return;
    }
    throw err;
  }

  await query(
    'INSERT INTO pedimento_scans (manifest_id, file_id, verdict, result, created_by) VALUES ($1,$2,$3,$4,$5)',
    [req.params.id, meta.id, scan.verdict, JSON.stringify(scan), req.user!.userId],
  );
  await recordAudit({ userId: req.user!.userId, action: 'ATTACH_PEDIMENTO_PDF', entity: 'manifest', entityId: req.params.id, after: { fileId: meta.id, pedimentoId: ins.rows[0].id }, ip: req.ip });
  const scanAction = scan.verdict === 'clean' ? 'PEDIMENTO_SCAN_CLEAN' : 'PEDIMENTO_SCAN_FLAGGED';
  await recordAudit({ userId: req.user!.userId, action: scanAction, entity: 'manifest', entityId: req.params.id, after: scanSummary, ip: req.ip });

  // Non-blocking warning (decision #4): coveredGuias must be a subset of the manifest's shipment
  // guías. If a pedimento covers a guía not declared on the manifest, surface it but do not reject.
  const manifestGuias = new Set(allShipments.map((s) => s.data.guideId));
  const strayGuias = extracted.coveredGuias.filter((g) => !manifestGuias.has(g));
  if (strayGuias.length > 0) {
    warnings.push(`El pedimento cubre guías que no están declaradas en el manifiesto: ${strayGuias.join(', ')}`);
  }

  // `warnings` carries every code/message; `warning` keeps the single-string field the UI displays.
  const warning = warnings.length > 0 ? warnings.join(' · ') : undefined;
  res.status(201).json({ pedimentoId: ins.rows[0].id, fileId: meta.id, numeroPedimento, scan, warnings, ...(warning ? { warning } : {}) });
});
