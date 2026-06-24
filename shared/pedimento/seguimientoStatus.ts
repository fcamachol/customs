// Mirror of the RF-08/RF-10 scan verdict (server pdfScan/types.ts) without coupling shared → server.
// Still imported by SeguimientoView — keep even though computeSeguimientoStatus was removed.
export type SeguimientoScanVerdict = 'clean' | 'suspicious' | 'blocked' | 'unscannable';

// Manifest-level coverage status (1 manifest → N pedimentos) lives in ./coverage.
export { computeCoverage } from './coverage';
export type { ManifestCoverageStatus, CoverageResult, PedimentoCoverageInput } from './coverage';
