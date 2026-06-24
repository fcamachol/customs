/**
 * Seguimiento status — the pedimento lifecycle of a single pedimento row, derived entirely from
 * existing fields (no dedicated status column). Used to split the Seguimiento view into
 * "Sin pedimento" (editable work queue) and "Con pedimento" (finalized) tabs, and to
 * badge each row.
 *
 * `locked` MUST mirror server/src/services/manifestLock.ts:computeLock — a pedimento is
 * locked (and lands in the "Con pedimento" tab) once it is structurally APPROVED or a
 * pedimento PDF is attached. Keep the two in sync.
 */

export type SeguimientoStatus =
  | 'pendiente'    // nothing captured yet
  | 'capturado'    // import data entered, no document yet
  | 'rechazado'    // prevalidation REJECTED — needs correction
  | 'prevalidado'  // prevalidation APPROVED, no PDF — locked
  | 'cargado';     // pedimento PDF uploaded — locked

// Mirror of the RF-08/RF-10 scan verdict (server pdfScan/types.ts) without coupling shared → server.
export type SeguimientoScanVerdict = 'clean' | 'suspicious' | 'blocked' | 'unscannable';

export interface SeguimientoSignals {
  /** manifests.import_data — the captured import-declaration form blob, or null. */
  importData?: unknown | null;
  /** manifests.prevalidation.status — 'APPROVED' | 'REJECTED' | null. */
  prevalidationStatus?: string | null;
  /** manifests.file_id — present once a pedimento PDF is attached. */
  fileId?: string | null;
  /** manifests.pedimento_scan.verdict — RF-08/RF-10 result for an attached PDF. */
  scanVerdict?: SeguimientoScanVerdict | null;
}

export interface SeguimientoStatusResult {
  status: SeguimientoStatus;
  /** APPROVED ∪ file_id — true ⇒ "Con pedimento" tab, false ⇒ "Sin pedimento" tab. */
  locked: boolean;
  scanVerdict: SeguimientoScanVerdict | null;
}

function hasImportData(d: unknown): boolean {
  return !!d && typeof d === 'object' && Object.keys(d as Record<string, unknown>).length > 0;
}

export function computeSeguimientoStatus(signals: SeguimientoSignals): SeguimientoStatusResult {
  const { importData, prevalidationStatus, fileId } = signals;
  const locked = prevalidationStatus === 'APPROVED' || !!fileId;
  const scanVerdict = signals.scanVerdict ?? null;

  let status: SeguimientoStatus;
  if (fileId) status = 'cargado';
  else if (prevalidationStatus === 'APPROVED') status = 'prevalidado';
  else if (prevalidationStatus === 'REJECTED') status = 'rechazado';
  else if (hasImportData(importData)) status = 'capturado';
  else status = 'pendiente';

  return { status, locked, scanVerdict };
}

// Manifest-level coverage status (1 manifest → N pedimentos) lives in ./coverage.
export { computeCoverage } from './coverage';
export type { ManifestCoverageStatus, CoverageResult, PedimentoCoverageInput } from './coverage';
