import { inflateSync } from 'node:zlib';
import type { ScanFinding, FindingSeverity } from './types';

// RF-08: detect active / executable content embedded in a pedimento PDF.
// We scan both the raw bytes and any FlateDecode-compressed streams we can
// inflate, because action dictionaries are frequently hidden inside compressed
// object streams. Nothing here executes the PDF — it is pure byte inspection.

interface KeywordRule {
  keyword: string; // PDF token to look for
  code: string;
  severity: FindingSeverity;
  message: string;
}

// Ordered roughly by how dangerous each marker is. Severity is refined below
// for the OpenAction+JS combination, which is the classic auto-run vector.
const KEYWORD_RULES: KeywordRule[] = [
  { keyword: '/Launch', code: 'pdf_launch', severity: 'critical', message: 'El PDF intenta ejecutar un programa externo (/Launch)' },
  { keyword: '/JavaScript', code: 'pdf_javascript', severity: 'warning', message: 'El PDF contiene JavaScript embebido' },
  { keyword: '/JS', code: 'pdf_javascript', severity: 'warning', message: 'El PDF contiene JavaScript embebido' },
  { keyword: '/OpenAction', code: 'pdf_openaction', severity: 'warning', message: 'El PDF ejecuta una acción automática al abrirse (/OpenAction)' },
  { keyword: '/AA', code: 'pdf_additional_actions', severity: 'warning', message: 'El PDF define acciones automáticas adicionales (/AA)' },
  { keyword: '/EmbeddedFile', code: 'pdf_embedded_file', severity: 'warning', message: 'El PDF contiene un archivo embebido' },
  { keyword: '/Filespec', code: 'pdf_filespec', severity: 'warning', message: 'El PDF referencia una especificación de archivo (/Filespec)' },
  { keyword: '/RichMedia', code: 'pdf_richmedia', severity: 'warning', message: 'El PDF contiene contenido multimedia activo (/RichMedia)' },
  { keyword: '/SubmitForm', code: 'pdf_submitform', severity: 'warning', message: 'El PDF puede enviar datos de formulario a un servidor (/SubmitForm)' },
  { keyword: '/URI', code: 'pdf_uri', severity: 'warning', message: 'El PDF contiene una acción de URL (/URI)' },
  { keyword: '/GoToR', code: 'pdf_gotor', severity: 'info', message: 'El PDF referencia un destino en otro documento (/GoToR)' },
];

// Executable magic numbers that should never appear at the start of a PDF stream.
const EXE_MAGICS: { magic: Buffer; label: string }[] = [
  { magic: Buffer.from('MZ', 'latin1'), label: 'PE/DOS (MZ)' },
  { magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), label: 'ELF' }, // \x7FELF
  { magic: Buffer.from('#!', 'latin1'), label: 'shebang (#!)' },
];

const STREAM_RE = /stream\r?\n?/g;

// Pedimentos run 40-80MB with hundreds of streams: the whole-file string must be
// built exactly once, and each inflated stream must be scanned and discarded —
// holding them all (or re-stringifying the file per stream) blocks the event
// loop for minutes and can OOM the container.
const MAX_INFLATED_BYTES = 64 * 1024 * 1024;

export function scanActiveContent(pdf: Buffer): ScanFinding[] {
  const pdfText = pdf.toString('latin1');
  const found = new Map<string, ScanFinding>(); // dedupe by code
  const present = new Set<string>(); // which keywords were seen anywhere

  const checkKeywords = (text: string) => {
    for (const rule of KEYWORD_RULES) {
      if (text.includes(rule.keyword)) present.add(rule.keyword);
    }
  };

  // Raw bytes first, then every successfully-inflated FlateDecode stream, so
  // keyword checks see compressed content too (action dictionaries are
  // frequently hidden inside compressed object streams).
  checkKeywords(pdfText);
  STREAM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = STREAM_RE.exec(pdfText)) !== null) {
    const start = m.index + m[0].length;
    const endIdx = pdf.indexOf('endstream', start, 'latin1');
    const slice = endIdx === -1 ? pdf.subarray(start) : pdf.subarray(start, endIdx);
    try {
      checkKeywords(inflateSync(slice, { maxOutputLength: MAX_INFLATED_BYTES }).toString('latin1'));
    } catch {
      // Not a (valid) FlateDecode stream, or larger inflated than the cap —
      // the raw bytes are already covered by the pdfText pass above.
    }
  }

  // OpenAction combined with JavaScript is the classic auto-execute vector —
  // escalate it to a single critical finding.
  const hasJs = present.has('/JS') || present.has('/JavaScript');
  if (present.has('/OpenAction') && hasJs) {
    found.set('pdf_openaction_js', {
      motor: 'RF08_ACTIVE_CONTENT',
      code: 'pdf_openaction_js',
      severity: 'critical',
      message: 'El PDF ejecuta JavaScript automáticamente al abrirse',
      detail: { keywords: ['/OpenAction', hasJs ? (present.has('/JS') ? '/JS' : '/JavaScript') : ''] },
    });
  }

  for (const rule of KEYWORD_RULES) {
    if (!present.has(rule.keyword)) continue;
    // Already represented by the escalated combined finding.
    if (found.has('pdf_openaction_js') && (rule.keyword === '/OpenAction' || rule.keyword === '/JS' || rule.keyword === '/JavaScript')) continue;
    if (found.has(rule.code)) continue;
    found.set(rule.code, {
      motor: 'RF08_ACTIVE_CONTENT',
      code: rule.code,
      severity: rule.severity,
      message: rule.message,
      detail: { keyword: rule.keyword },
    });
  }

  // Executable magic at the start of any stream body.
  STREAM_RE.lastIndex = 0;
  let sm: RegExpExecArray | null;
  while ((sm = STREAM_RE.exec(pdfText)) !== null) {
    const start = sm.index + sm[0].length;
    const head = pdf.subarray(start, start + 8);
    for (const { magic, label } of EXE_MAGICS) {
      if (head.length >= magic.length && head.subarray(0, magic.length).equals(magic)) {
        if (!found.has('pdf_embedded_executable')) {
          found.set('pdf_embedded_executable', {
            motor: 'RF08_ACTIVE_CONTENT',
            code: 'pdf_embedded_executable',
            severity: 'critical',
            message: 'El PDF contiene un ejecutable embebido',
            detail: { magic: label },
          });
        }
      }
    }
  }

  return [...found.values()];
}
