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

// ---- Manifest ↔ pedimento reconciliation ----
import type { SubdivisionInfo } from '../pedimento/subdivision';

export interface ExtractedPedimentoLine {
  guia: string;
  valueUsd: number | null;
  consigneeName: string | null;
  id: string | null;            // RFC or CURP as printed
  fraccion?: string | null;     // firmed up by positional pass
  valAduanaUsd?: number | null;
}

export interface ExtractedPedimentoHeader {
  numeroPedimento: string | null;
  clave: string | null;
  importerRfc: string | null;
  agentRfc: string | null;
  customsClearanceCode: string | null;
  tipoCambio: number | null;
  totalBultos: number | null;
}

export interface ExtractedPedimento {
  header: ExtractedPedimentoHeader;
  lines: ExtractedPedimentoLine[];
  extractionMethod: 'deterministic' | 'ai';
  usedPositional: boolean;
  confidence: number;           // 0..1
  warnings: string[];
  subdivision: SubdivisionInfo;
  coveredGuias: string[];
}

/** Built from the manifest's shipments (+ optional import data) — the "should be" side. */
export interface ExpectedPedimento {
  header: Partial<ExtractedPedimentoHeader>;
  lines: { guia: string; valueUsd: number; consigneeName: string; id: string }[];
}

export interface FieldDiff {
  field: string;
  expected: string | number | null;
  actual: string | number | null;
  ok: boolean;
}

export interface LineResult {
  guia: string;
  status: 'matched' | 'mismatch' | 'missing_in_pedimento' | 'extra_in_pedimento';
  diffs: FieldDiff[];           // valorUsd, nombre, rfcCurp
}

export interface ReconciliationReport {
  generatedAt: string;
  extractionMethod: 'deterministic' | 'ai';
  usedPositional: boolean;
  confidence: number;
  header: FieldDiff[];
  totals: FieldDiff[];
  lines: LineResult[];
  summary: {
    matched: number;
    mismatched: number;
    missingInPedimento: number;
    extraInPedimento: number;
    color: RiskResultado;       // reuse 'verde' | 'amarillo' | 'rojo' | 'gris'
  };
  notes: string[];
}
