// Shared contract for the on-screen report bundle (Riesgo / Reporte General / Layout).
// The row arrays are byte-for-byte the same data that goes into the downloadable .xlsx files,
// produced by the same pure builders (toLayoutRows / buildReportRows), so the screen and the
// Excel never diverge.

export type RiskResultado = 'verde' | 'amarillo' | 'rojo' | 'gris';

/** Risk view row — the richer shape the on-screen table renders (not the 4-col xlsx artifact). */
export interface RiskScreenRow {
  mwb: string;
  guide: string;
  consignee: string;
  senderCity: string;
  senderCountry: string;
  resultado: RiskResultado;
  motivo: string;
}

/** Whether import-data may still be edited, and if not, why. */
export interface ReportLockState {
  editable: boolean;
  reason: string | null;
}

export interface ReportsBundle {
  /** Risk view (exception-first). */
  risk: RiskScreenRow[];
  /** Reporte General — 36 columns keyed by header. */
  report: Record<string, string>[];
  /** Layout — 34 columns keyed by header. */
  layout: Record<string, string>[];
  /** Edit lock derived from pedimento finalization state. */
  lock: ReportLockState;
  /** True when import-data changed after the last risk run (score no longer matches data). */
  riskStale: boolean;
  /** True when identity PII was masked for this viewer (autoridad, no reveal). */
  masked: boolean;
  /** ISO timestamp the bundle was built. */
  generatedAt: string;
  /** sha256 of the canonical bundle content — recorded in the audit row for dispute reproducibility. */
  contentHash: string;
}
