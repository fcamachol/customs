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
import { loadImporterOfRecord, loadCustomsAgent, upsertAgente, upsertImportador } from '../services/entityMaster';
import { normGuia, normGuiaSet } from '../../../shared/pedimento/guia';

const EMPTY_SUBDIVISION: SubdivisionInfo = { masterGuide: null, ordinal: null, isLast: false, siblings: [], bultos: null, pesoBrutoKg: null };

// Fallback when a scan-clean PDF cannot be parsed (see best-effort note at the call site).
const EMPTY_EXTRACTED: ExtractedPedimento = {
  header: { numeroPedimento: null, clave: null, importerRfc: null, agentRfc: null, agencyRfc: null,
    patente: null, customsEntryCode: null, customsClearanceCode: null,
    medioTransporteEntrada: null, medioTransporteArribo: null, medioTransporteSalida: null,
    t1RegistryNumber: null, agenteAduanal: null,
    tasaImportacion: null, tipoCambio: null, entryDate: null, paymentDate: null,
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
// mismatch — only a genuinely different guide does. Shares the canonical form with normGuia.
const normMasterGuide = normGuia;

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
  const tScan = performance.now();
  const scan = await scanPedimentoPdf(req.file.buffer, policy);
  console.log(`[pedimento-upload] scan ${(req.file.size / 1024 / 1024).toFixed(1)}MB in ${((performance.now() - tScan) / 1000).toFixed(1)}s (manifest ${req.params.id})`);
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
  const tExtract = performance.now();
  try {
    extracted = await extractPedimento(req.file.buffer);
    console.log(`[pedimento-upload] extract in ${((performance.now() - tExtract) / 1000).toFixed(1)}s (manifest ${req.params.id})`);
  } catch {
    extracted = EMPTY_EXTRACTED;
    // Signal that extraction yielded nothing, so the masterGuide/duplicate gates were skipped and
    // no numero/subdivisión metadata could be auto-populated — the row is attached unverified.
    warnings.push('pdf_unparseable');
  }

  // Fix 3: an image-only PDF does not throw in pdf-parse — it returns an empty text layer, so
  // extraction silently yields all-nulls without tripping pdf_unparseable above. Warn distinctly so
  // the user re-uploads a text-based PDF (detection only; no OCR in this pass). This warning stands
  // in for the generic no-guías message below, mirroring how pdf_unparseable already does.
  const scannedNoText = extracted.scannedNoTextLayer === true;
  if (scannedNoText) {
    warnings.push('El PDF parece ser un documento escaneado sin capa de texto. Vuelve a subir un pedimento en PDF con texto seleccionable para poder leer sus datos.');
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
      // Same expression as the pedimentos_numero_global_uq index, so this stays an
      // index lookup instead of scanning every pedimento on each upload.
      const dup = await query(
        `SELECT 1 FROM pedimentos WHERE regexp_replace(numero_pedimento, '\\D', '', 'g') = $1 LIMIT 1`,
        [norm],
      );
      if (dup.rows.length > 0) {
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
    // Compare by normalized guía so "G-1" and "g1" are recognized as the same shipment; keep the
    // raw extracted values in `overlap` for the Spanish error message.
    const alreadyCovered = normGuiaSet(others.rows.flatMap((r) => r.covered_guias ?? []));
    const overlap = extracted.coveredGuias.filter((g) => alreadyCovered.has(normGuia(g)));
    if (overlap.length > 0) {
      res.status(409).json({ error: `El pedimento cubre guías ya cubiertas por otro pedimento: ${overlap.join(', ')}`, overlap });
      return;
    }
  }

  const meta = await saveFile({ kind: 'pedimento_pdf', originalName: req.file.originalname, bytes: req.file.buffer, uploadedBy: req.user!.userId });

  // Pre-fill the capture form from the extracted header (best-effort). Store only the non-null
  // fields; null when nothing was extracted, so an unparseable PDF leaves import_data NULL.
  const h = extracted.header;

  // Auto-register the agente aduanal (by patente) and importador (by RFC) identified on the
  // pedimento. Best-effort and fill-only-missing: never overwrites existing values, never flips
  // `verified`, and never fails the upload — an upsert error is logged and swallowed.
  try {
    if (h.patente) {
      await upsertAgente({
        patente: h.patente, name: h.agenteAduanal, agentRfc: h.agentRfc,
        agencyRfc: h.agencyRfc, createdBy: req.user!.userId,
      });
    }
    if (h.importerRfc) {
      await upsertImportador({
        rfc: h.importerRfc, name: h.importerName ?? null,
        fiscalAddress: h.importerAddress ?? null, createdBy: req.user!.userId,
      });
    }
  } catch (err) {
    console.error('[pedimentoUpload] entity auto-register failed (non-fatal):', err);
  }

  // Claves de aduana de entrada/despacho carry the MEDIOS DE TRANSPORTE claves (ENTRADA/SALIDA y
  // ARRIBO, Apéndice 3) — client observation — not the aduana-section codes, which stay available
  // on the header as customsEntryCode/customsClearanceCode.
  const prefillEntries: [string, unknown][] = [
    ['cveT1', h.clave], ['patente', h.patente], ['fechaEntrada', h.entryDate],
    ['tipoCambio', h.tipoCambio], ['paymentDate', h.paymentDate],
    ['agenteAduanal', h.agenteAduanal], ['claveAduanaEntrada', h.medioTransporteEntrada],
    ['claveAduanaDespacho', h.medioTransporteArribo], ['tasaImportacion', h.tasaImportacion],
    ['noRegistro', h.t1RegistryNumber],
    ['noPedimento', h.numeroPedimento ? h.numeroPedimento.slice(-7) : null],
    ['importerRfc', h.importerRfc], ['importerName', h.importerName ?? null],
  ].filter(([, v]) => v != null) as [string, unknown][];
  const importPrefill = prefillEntries.length ? Object.fromEntries(prefillEntries) : null;

  // Load all manifest shipments once — reused for both the stray-guía check and reconciliation.
  const allShipments = await loadShipments(req.params.id);

  // Advisory reconciliation: expected (manifest, covered-guía subset) vs extracted (PDF). Best-effort.
  let reconciliation: ReconciliationReport | null = null;
  try {
    if (extracted.lines.length > 0 || extracted.coveredGuias.length > 0) {
      const covered = normGuiaSet(extracted.coveredGuias);
      const subset = allShipments
        .map((s) => s.data)
        .filter((d) => covered.size === 0 || covered.has(normGuia(d.guideId)));
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

  // Compute the remaining attach-time warnings BEFORE the INSERT so the full array is persisted on
  // the row (Fix 4), not just the pre-gate codes. These are non-blocking — the row still attaches.
  //
  // coveredGuias must be a subset of the manifest's shipment guías; a guía not declared on the
  // manifest is surfaced but not rejected (decision #4).
  const manifestGuias = normGuiaSet(allShipments.map((s) => s.data.guideId));
  const strayGuias = extracted.coveredGuias.filter((g) => !manifestGuias.has(normGuia(g)));
  if (strayGuias.length > 0) {
    warnings.push(`El pedimento cubre guías que no están declaradas en el manifiesto: ${strayGuias.join(', ')}`);
  }

  // Prevalidation intersects covered_guias with the manifest's shipments, so either side being
  // empty guarantees a block at step 3. Say so now, at attach time, instead of letting the user
  // capture a pedimento that cannot prevalidate. (pdf_unparseable / pdf_sin_texto already explain
  // the empty extraction — don't stack the generic no-guías message on top of either.)
  if (allShipments.length === 0) {
    warnings.push('El manifiesto no tiene guías (embarques) cargadas; la prevalidación quedará bloqueada.');
  }
  if (extracted.coveredGuias.length === 0 && !warnings.includes('pdf_unparseable') && !scannedNoText) {
    warnings.push('No se encontraron guías cubiertas en el PDF del pedimento; la prevalidación quedará bloqueada hasta subir un PDF legible.');
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
          import_data, pedimento_reconciliation, extraction_confidence, extraction_warnings)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
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
        extracted.confidence,
        JSON.stringify(warnings),
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

  // `warnings` carries every code/message; `warning` keeps the single-string field the UI displays.
  const warning = warnings.length > 0 ? warnings.join(' · ') : undefined;
  res.status(201).json({ pedimentoId: ins.rows[0].id, fileId: meta.id, numeroPedimento, scan, warnings, ...(warning ? { warning } : {}) });
});
