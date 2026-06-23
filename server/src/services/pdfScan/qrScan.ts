import type { ScanFinding } from './types';

// RF-10: detect QR codes embedded in a pedimento PDF whose decoded payload is a
// trojan vector (executable scheme, command payload, drive-by URL, etc).

const EXECUTABLE_SCHEMES = ['javascript:', 'data:', 'file:', 'vbscript:'];
const EXECUTABLE_EXTENSIONS = ['.exe', '.scr', '.bat', '.ps1', '.js', '.vbs', '.cmd'];
const COMMAND_TOKENS = ['#!', 'powershell', 'cmd.exe', 'invoke-'];
const MAX_PAYLOAD_LEN = 2048;

function truncate(s: string): string {
  return s.length > 200 ? s.slice(0, 200) : s;
}

// Pure, unit-testable classification of a single decoded QR payload.
export function classifyQrPayload(payload: string): ScanFinding | null {
  const raw = payload ?? '';
  const lower = raw.trim().toLowerCase();
  const detail = { payload: truncate(raw) };

  for (const scheme of EXECUTABLE_SCHEMES) {
    if (lower.startsWith(scheme)) {
      return {
        motor: 'RF10_QR_TROJAN',
        code: 'qr_suspicious_scheme',
        severity: 'critical',
        message: `Código QR con esquema ejecutable peligroso (${scheme})`,
        detail: { ...detail, scheme },
      };
    }
  }

  // URL whose path/target ends in an executable extension (ignore query/fragment).
  const pathPart = lower.split(/[?#]/)[0];
  for (const ext of EXECUTABLE_EXTENSIONS) {
    if (pathPart.endsWith(ext)) {
      return {
        motor: 'RF10_QR_TROJAN',
        code: 'qr_executable_url',
        severity: 'critical',
        message: `Código QR apunta a un archivo ejecutable (${ext})`,
        detail: { ...detail, extension: ext },
      };
    }
  }

  // Command-injection style payloads.
  for (const token of COMMAND_TOKENS) {
    if (lower.includes(token)) {
      return {
        motor: 'RF10_QR_TROJAN',
        code: 'qr_command_payload',
        severity: 'critical',
        message: 'Código QR contiene una carga de comandos sospechosa',
        detail: { ...detail, token },
      };
    }
  }

  // IP-literal host (e.g. http://1.2.3.4/...) — common in malware drops.
  const ipHost = /^[a-z][a-z0-9+.-]*:\/\/(?:\d{1,3}\.){3}\d{1,3}(?:[:/]|$)/.test(lower);
  if (ipHost) {
    return {
      motor: 'RF10_QR_TROJAN',
      code: 'qr_ip_host',
      severity: 'warning',
      message: 'Código QR apunta a una dirección IP numérica',
      detail,
    };
  }

  if (raw.length > MAX_PAYLOAD_LEN) {
    return {
      motor: 'RF10_QR_TROJAN',
      code: 'qr_oversized',
      severity: 'warning',
      message: 'Código QR con una carga de datos excesivamente larga',
      detail: { ...detail, length: raw.length },
    };
  }

  return null;
}

const UNAVAILABLE: ScanFinding = {
  motor: 'RF10_QR_TROJAN',
  code: 'qr_scan_unavailable',
  severity: 'info',
  message: 'No se pudo analizar códigos QR del PDF',
};

// Best-effort QR extraction: rasterize page 1 of the PDF and run jsQR over it,
// masking each detected code and re-scanning to catch multiple QRs. ANY failure
// (pdfjs import, render, canvas, decode) is swallowed and surfaced as a single
// info finding — this function never throws.
export async function scanQrTrojans(pdf: Buffer): Promise<ScanFinding[]> {
  try {
    const [{ getDocument }, canvasMod, jsqrMod] = await Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('@napi-rs/canvas'),
      import('jsqr'),
    ]);
    const { createCanvas } = canvasMod as unknown as typeof import('@napi-rs/canvas');
    const jsQR = (jsqrMod as unknown as { default: typeof import('jsqr').default }).default;

    const data = new Uint8Array(pdf);
    const loadingTask = getDocument({ data, disableFontFace: true, isEvalSupported: false });
    const doc = await loadingTask.promise;
    try {
      if (doc.numPages < 1) return [];
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 2 });
      const width = Math.max(1, Math.ceil(viewport.width));
      const height = Math.max(1, Math.ceil(viewport.height));
      const canvas = createCanvas(width, height);
      const ctx = canvas.getContext('2d');
      // pdfjs expects a CanvasRenderingContext2D-shaped object; @napi-rs/canvas matches it.
      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;

      const image = ctx.getImageData(0, 0, width, height);
      const pixels = image.data as Uint8ClampedArray;

      const findings: ScanFinding[] = [];
      const seen = new Set<string>();
      const MAX_CODES = 5;
      for (let i = 0; i < MAX_CODES; i++) {
        const code = jsQR(pixels, width, height);
        if (!code || !code.data) break;
        if (!seen.has(code.data)) {
          seen.add(code.data);
          const finding = classifyQrPayload(code.data);
          if (finding) findings.push(finding);
        }
        // Mask the located QR (white-out its bounding box) and re-scan for more.
        const loc = code.location;
        const xs = [loc.topLeftCorner.x, loc.topRightCorner.x, loc.bottomLeftCorner.x, loc.bottomRightCorner.x];
        const ys = [loc.topLeftCorner.y, loc.topRightCorner.y, loc.bottomLeftCorner.y, loc.bottomRightCorner.y];
        const minX = Math.max(0, Math.floor(Math.min(...xs)));
        const maxX = Math.min(width, Math.ceil(Math.max(...xs)));
        const minY = Math.max(0, Math.floor(Math.min(...ys)));
        const maxY = Math.min(height, Math.ceil(Math.max(...ys)));
        if (maxX <= minX || maxY <= minY) break;
        for (let y = minY; y < maxY; y++) {
          for (let x = minX; x < maxX; x++) {
            const p = (y * width + x) * 4;
            pixels[p] = 255; pixels[p + 1] = 255; pixels[p + 2] = 255; pixels[p + 3] = 255;
          }
        }
      }
      return findings;
    } finally {
      await doc.destroy().catch(() => {});
    }
  } catch {
    return [UNAVAILABLE];
  }
}
