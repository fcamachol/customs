export type ScanVerdict = 'clean' | 'suspicious' | 'blocked' | 'unscannable';
export type FindingSeverity = 'info' | 'warning' | 'critical';

export interface ScanFinding {
  motor: 'RF08_ACTIVE_CONTENT' | 'RF10_QR_TROJAN';
  code: string;
  severity: FindingSeverity;
  message: string; // Spanish, user-facing
  detail?: Record<string, unknown>;
}

export interface ScanPolicy {
  onActiveContent: 'block' | 'flag'; // default 'flag'
  onQrTrojan: 'block' | 'flag'; // default 'flag'
  oversizeBehavior: 'skip' | 'block'; // default 'skip'
  maxBytes: number; // default 25MB
}

export interface ScanResult {
  verdict: ScanVerdict;
  findings: ScanFinding[];
  motors: { rf08: ScanVerdict; rf10: ScanVerdict };
  scannedAt: string; // ISO
  bytesScanned: number;
  policy: ScanPolicy;
}
