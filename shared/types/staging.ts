import type { Shipment } from './shipment';

export type RowSeverity = 'error' | 'warning';
export type RowStatus = 'valid' | 'warning' | 'error';

export interface RowIssue {
  rowIndex: number;
  field: string;
  code: string;
  severity: RowSeverity;
  message: string;
  rawValue?: string;
}

export interface StagingRow {
  rowIndex: number;
  status: RowStatus;
  idempotencyKey: string;
  shipment: Shipment;
  errors: RowIssue[];
  warnings: RowIssue[];
}

export interface IngestResult {
  rows: StagingRow[];
  counts: { total: number; valid: number; warning: number; error: number };
  unmappedHeaders: string[];
  duplicateHeaders: string[];
  fileRejected: boolean;
  headerRow: string[];
}
