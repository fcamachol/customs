import { query } from '../../db/pool';
import { scanActiveContent } from './activeContent';
import { scanQrTrojans } from './qrScan';
import type { ScanFinding, ScanPolicy, ScanResult, ScanVerdict } from './types';

export type { ScanFinding, ScanPolicy, ScanResult, ScanVerdict } from './types';
export { scanActiveContent } from './activeContent';
export { classifyQrPayload, scanQrTrojans } from './qrScan';

export const DEFAULT_SCAN_POLICY: ScanPolicy = {
  onActiveContent: 'flag',
  onQrTrojan: 'flag',
  oversizeBehavior: 'skip',
  maxBytes: 25 * 1024 * 1024,
};

// Read the operator-configured scan policy from the config table and deep-merge
// it over the defaults. Missing/invalid rows fall back to DEFAULT_SCAN_POLICY.
export async function loadScanPolicy(): Promise<ScanPolicy> {
  try {
    const { rows } = await query<{ value: unknown }>(
      `SELECT value FROM config WHERE key='pedimento_scan_policy'`,
    );
    const value = rows[0]?.value;
    if (value && typeof value === 'object') {
      return { ...DEFAULT_SCAN_POLICY, ...(value as Partial<ScanPolicy>) };
    }
  } catch {
    // Config table unavailable — fall back to defaults rather than blocking uploads.
  }
  return { ...DEFAULT_SCAN_POLICY };
}

function rf08Verdict(findings: ScanFinding[], policy: ScanPolicy): ScanVerdict {
  const hasCritical = findings.some((f) => f.severity === 'critical');
  if (hasCritical && policy.onActiveContent === 'block') return 'blocked';
  if (findings.length > 0) return 'suspicious';
  return 'clean';
}

function rf10Verdict(findings: ScanFinding[], policy: ScanPolicy): ScanVerdict {
  if (findings.length === 0) return 'clean';
  const onlyUnavailable = findings.every((f) => f.code === 'qr_scan_unavailable');
  if (onlyUnavailable) return 'unscannable';
  const real = findings.filter((f) => f.code !== 'qr_scan_unavailable');
  const hasCritical = real.some((f) => f.severity === 'critical');
  if (hasCritical && policy.onQrTrojan === 'block') return 'blocked';
  return 'suspicious';
}

export async function scanPedimentoPdf(pdf: Buffer, policy: ScanPolicy): Promise<ScanResult> {
  const scannedAt = new Date().toISOString();
  const bytesScanned = pdf.length;

  if (pdf.length > policy.maxBytes) {
    const oversize: ScanFinding = {
      motor: 'RF08_ACTIVE_CONTENT',
      code: 'scan_skipped_oversize',
      severity: policy.oversizeBehavior === 'block' ? 'critical' : 'info',
      message:
        policy.oversizeBehavior === 'block'
          ? 'El PDF excede el tamaño máximo permitido para análisis de seguridad'
          : 'El PDF excede el tamaño de análisis; se omitió el escaneo de seguridad',
      detail: { bytes: pdf.length, maxBytes: policy.maxBytes },
    };
    const rf08: ScanVerdict = policy.oversizeBehavior === 'block' ? 'blocked' : 'unscannable';
    return {
      verdict: rf08 === 'blocked' ? 'blocked' : 'unscannable',
      findings: [oversize],
      motors: { rf08, rf10: 'unscannable' },
      scannedAt,
      bytesScanned,
      policy,
    };
  }

  const activeFindings = scanActiveContent(pdf);
  const qrFindings = await scanQrTrojans(pdf);

  const rf08 = rf08Verdict(activeFindings, policy);
  const rf10 = rf10Verdict(qrFindings, policy);

  let verdict: ScanVerdict;
  if (rf08 === 'blocked' || rf10 === 'blocked') verdict = 'blocked';
  else if (rf08 === 'suspicious' || rf10 === 'suspicious') verdict = 'suspicious';
  else if (rf08 === 'clean' && rf10 === 'unscannable') verdict = 'clean';
  else verdict = 'clean';

  return {
    verdict,
    findings: [...activeFindings, ...qrFindings],
    motors: { rf08, rf10 },
    scannedAt,
    bytesScanned,
    policy,
  };
}
