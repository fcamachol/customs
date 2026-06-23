import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { scanActiveContent } from '../../src/services/pdfScan/activeContent';
import { classifyQrPayload } from '../../src/services/pdfScan/qrScan';
import { DEFAULT_SCAN_POLICY, scanPedimentoPdf } from '../../src/services/pdfScan';

const MINIMAL_PDF = Buffer.from(
  '%PDF-1.1\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
    '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
    '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\n' +
    'trailer<</Root 1 0 R>>\n%%EOF',
  'latin1',
);

const OPENACTION_JS_PDF = Buffer.from(
  '%PDF-1.5\n1 0 obj<</OpenAction<</S/JavaScript/JS(app.alert\\(1\\))>>>>endobj\n%%EOF',
  'latin1',
);

const LAUNCH_PDF = Buffer.from(
  '%PDF-1.5\n1 0 obj<</A<</S/Launch/F(calc.exe)>>>>endobj\n%%EOF',
  'latin1',
);

const MZ_STREAM_PDF = Buffer.concat([
  Buffer.from('%PDF-1.5\n1 0 obj<</Length 10>>\nstream\n', 'latin1'),
  Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'latin1'),
  Buffer.from('\nendstream\nendobj\n%%EOF', 'latin1'),
]);

describe('scanActiveContent (RF-08)', () => {
  it('flags /OpenAction + /JavaScript as critical pdf_openaction_js', () => {
    const findings = scanActiveContent(OPENACTION_JS_PDF);
    const f = findings.find((x) => x.code === 'pdf_openaction_js');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('critical');
  });

  it('flags /Launch as critical pdf_launch', () => {
    const findings = scanActiveContent(LAUNCH_PDF);
    const f = findings.find((x) => x.code === 'pdf_launch');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('critical');
  });

  it('flags an MZ-prefixed stream as pdf_embedded_executable', () => {
    const findings = scanActiveContent(MZ_STREAM_PDF);
    const f = findings.find((x) => x.code === 'pdf_embedded_executable');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('critical');
  });

  it('returns no findings for a clean minimal PDF', () => {
    expect(scanActiveContent(MINIMAL_PDF)).toEqual([]);
  });
});

describe('classifyQrPayload (RF-10)', () => {
  it('flags javascript: scheme as critical', () => {
    const f = classifyQrPayload('javascript:alert(1)');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('critical');
    expect(f!.code).toBe('qr_suspicious_scheme');
  });

  it('flags an .exe URL as critical', () => {
    const f = classifyQrPayload('http://1.2.3.4/x.exe');
    expect(f).toBeTruthy();
    expect(f!.severity).toBe('critical');
    expect(f!.code).toBe('qr_executable_url');
  });

  it('flags a file:// payload', () => {
    const f = classifyQrPayload('file:///etc/passwd');
    expect(f).toBeTruthy();
    expect(f!.code).toBe('qr_suspicious_scheme');
  });

  it('flags an IP-literal host', () => {
    const f = classifyQrPayload('http://1.2.3.4/index');
    expect(f).toBeTruthy();
    expect(f!.code).toBe('qr_ip_host');
  });

  it('returns null for a benign https URL', () => {
    expect(classifyQrPayload('https://anam.gob.mx/ok')).toBeNull();
  });
});

describe('scanPedimentoPdf (orchestrator)', () => {
  it('returns suspicious for a dirty PDF under default flag policy', async () => {
    const result = await scanPedimentoPdf(OPENACTION_JS_PDF, DEFAULT_SCAN_POLICY);
    expect(result.verdict).toBe('suspicious');
    expect(result.motors.rf08).toBe('suspicious');
  });

  it('returns blocked for a dirty PDF when onActiveContent is block', async () => {
    const result = await scanPedimentoPdf(OPENACTION_JS_PDF, { ...DEFAULT_SCAN_POLICY, onActiveContent: 'block' });
    expect(result.verdict).toBe('blocked');
    expect(result.motors.rf08).toBe('blocked');
  });

  it('returns clean for a minimal PDF', async () => {
    const result = await scanPedimentoPdf(MINIMAL_PDF, DEFAULT_SCAN_POLICY);
    expect(result.verdict).toBe('clean');
    expect(result.motors.rf08).toBe('clean');
  });
});
