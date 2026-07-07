import type { ExtractedPedimento, ExtractedPedimentoLine } from '../types/reports';
import type { SubdivisionInfo } from './subdivision';
import { scanObservations } from './observation';

const emptySubdivision: SubdivisionInfo = {
  masterGuide: null,
  ordinal: null,
  isLast: false,
  siblings: [],
  bultos: null,
  pesoBrutoKg: null,
};

const NUMERO_RE = /\b(\d{2})\s+(\d{2})\s+(\d{4})\s+(\d{7})\b/;       // "25 85 1653 5001684"
const RFC_RE = /\b[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}\b/g;

export function parsePedimentoText(text: string): ExtractedPedimento {
  const t = text ?? '';
  const lines: ExtractedPedimentoLine[] = scanObservations(t).map((obs) => (
    { guia: obs.guideId, valueUsd: obs.valueUsd, consigneeName: obs.consigneeName, id: obs.id }
  ));

  // Numero de pedimento — 15 digits. Prefer the anchored "NUM. PEDIMENTO:" value, tolerating
  // arbitrary internal spacing/grouping (\s between digit runs), so a layout printing 15 contiguous
  // digits still registers the numero — and, with it, the upload's duplicate-numero gate. Both
  // known layouts scatter the numero away from the label (SAMPLE prints "CVE. PEDIMENTO:" between
  // them; the consolidado prints "T. OPER …"), so the anchor fails there and we fall back to the
  // canonical unanchored "dd dd dddd ddddddd" spaced pattern.
  const anchoredNum = t.match(/NUM\.?\s*PEDIMENTO:?\s*((?:\d\s*){15})(?!\d)/i);
  const num = t.match(NUMERO_RE);
  const numeroPedimento = anchoredNum
    ? anchoredNum[1].replace(/\D/g, '')
    : (num ? num[1] + num[2] + num[3] + num[4] : null);
  // Patente is digits 5-8 of the normalized 15-digit numero ("258516535001684" → "1653"), keeping
  // the same contract as derivePatente() in server/src/routes/pedimento.ts.
  const patente = numeroPedimento && numeroPedimento.length === 15 ? numeroPedimento.slice(4, 8) : null;
  // Tipo de cambio: the ≥4-decimal token of the "ADUANA E/S" value cluster (pdf-parse emits the
  // rate there in both known layouts: "ADUANA E/S: 9 20.45680 808.000 850" and consolidado
  // "ADUANA E/S: 17.98420"). Anchoring matters: consolidados print PRV/IVA fee amounts with 5
  // decimals (e.g. "330.00000") earlier in the text, so "first ≥4-decimal token" grabs a fee.
  // Falls back to the unanchored token for texts without the cluster. Best-effort.
  const tcCollapsed = t.replace(/\s+/g, ' ');
  const tcMatch =
    tcCollapsed.match(/ADUANA E\/S:?\s*(?:\d{1,3}\s+)?(\d{1,3}\.\d{4,6})\b/i) ??
    tcCollapsed.match(/\b(\d{1,3}\.\d{4,6})\b/);
  const tipoCambio = tcMatch ? Number(tcMatch[1]) : null;

  // Consolidado partida observations: "<guía> CONSIGNATARIO: <name> <RFC/CURP>" — no GUIA/VALOR
  // format at all. The per-guía valor is the partida block's VAL ADU (whole MXN): the last
  // "<valAdu> <precioPag> <precioUnit .ddddd>" triplet printed before the observation, converted
  // at the pedimento's own tipo de cambio (hence approximate — see valueUsdApprox).
  if (lines.length === 0) {
    const chunks = tcCollapsed.split(/OBSERVACIONES A NIVEL PARTIDA/i);
    for (let i = 1; i < chunks.length; i++) {
      // Not anchored to the chunk start: a page break can inject the footer/header between the
      // label and the observation.
      const obs = chunks[i].match(/(\S+)\s+CONSIGNATARIO:\s+(.+?)\s+([A-ZÑ&]{3,4}\d{6}[A-Z0-9]{2,8})\b/);
      if (!obs) continue;
      const triplets = [...chunks[i - 1].matchAll(/\b(\d{1,8})\s+\d{1,8}\s+\d{1,8}\.\d{5}\b/g)];
      const valAduMxn = triplets.length ? Number(triplets[triplets.length - 1][1]) : null;
      const valueUsd = valAduMxn != null && tipoCambio ? Math.round((valAduMxn / tipoCambio) * 100) / 100 : null;
      lines.push({
        guia: obs[1], valueUsd, consigneeName: obs[2].trim(), id: obs[3],
        ...(valueUsd != null ? { valueUsdApprox: true } : {}),
      });
    }
  }
  const clave = /\bT1\b/.test(t) ? 'T1' : null;
  const rfcs = t.match(RFC_RE) ?? [];
  const importerRfc = rfcs[0] ?? null;     // first RFC on the page is the importer block

  // FECHAS block: first dd/mm/yyyy = ENTRADA, second = PAGO. Normalize to ISO. Both known layouts
  // print the two dates right after a "FECHAS" anchor, so scan from there first — a layout printing
  // an emission/print date earlier in the page would otherwise shift both. Fall back to the whole-
  // text scan when no FECHAS anchor exists (or none follow it). Best-effort.
  const scanDates = (s: string) =>
    [...s.matchAll(/\b(\d{2})\/(\d{2})\/(\d{4})\b/g)].map((m) => `${m[3]}-${m[2]}-${m[1]}`);
  const fechasIdx = t.search(/\bFECHAS\b/i);
  const anchoredDates = fechasIdx >= 0 ? scanDates(t.slice(fechasIdx)) : [];
  const isoDates = anchoredDates.length ? anchoredDates : scanDates(t);
  const entryDate = isoDates[0] ?? null;
  const paymentDate = isoDates[1] ?? null;

  // Collapse whitespace so anchors survive pdf-parse's positional line-splitting (same trick as
  // parseSubdivision). Used for the numeric/code fields below; the agente name is read from the
  // original text to preserve casing/accents.
  const tc = t.replace(/\s+/g, ' ');

  // Clave de aduana de ENTRADA — the trailing 3-digit code of the "DESTINO/ORIGEN TIPO CAMBIO PESO
  // BRUTO ADUANA E/S" value cluster, e.g. "9 17.10420 209.000 850" → 850. Anchored on the ≥4-decimal
  // tipo de cambio so we lock onto that specific row. Consolidados scatter that cluster (the tipo de
  // cambio lands next to the labels), emitting "destino aduana peso" instead — e.g. "9 240 2,891.000"
  // — right after the numero/CERTIFICACIONES line, hence the second anchor. Best-effort.
  const entryM =
    tc.match(/\b\d{1,3}\s+\d{1,3}\.\d{4,6}\s+[\d.,]+\s+(\d{2,3})\b/) ??
    tc.match(/CERTIFICACIONES\s+\d{1,2}\s+(\d{2,3})\s+\d{1,3}(?:,\d{3})*\.\d{3}\b/i);
  const customsEntryCode = entryM ? entryM[1] : null;

  // Clave de aduana de DESPACHO — the code printed after the "SECCION ADUANERA DE DESPACHO" block.
  // pdf-parse emits the office address (letters only) between the label and the code, so skip the
  // non-digits and take the first 2–3 digit run. Consolidados fragment the label instead: the code
  // directly follows "CLAVE DE LA SECCION ADUANERA" while "DE DESPACHO:" lands among unrelated
  // columns, hence the second anchor. Best-effort.
  const despachoM =
    tc.match(/DE\s+DESPACHO:?\s*[^\d]*(\d{2,3})\b/i) ??
    tc.match(/CLAVE\s+DE\s+LA\s+SECCION\s+ADUANERA\s+(\d{2,3})\b/i);
  const customsClearanceCode = despachoM ? despachoM[1] : null;

  // MEDIOS DE TRANSPORTE claves (Apéndice 3) — what the ANAM report's "Clave de Aduana de
  // entrada/despacho" columns must carry (client observation). Layout A prints the three values
  // right after the DESTINO/TIPO CAMBIO/PESO/ADUANA cluster in label order (ENTRADA/SALIDA,
  // ARRIBO, SALIDA): "9 17.10420 209.000 850 4 4 7". Consolidados scatter them instead: one value
  // lands after "PRECIO PAGADO/VALOR COMERCIAL:" and one after the CERTIFICACIONES
  // destino/aduana/peso cluster; the (?![.,]) guards reject monetary tokens. Best-effort.
  const mediosM = tc.match(/\b\d{1,3}\s+\d{1,3}\.\d{4,6}\s+[\d.,]+\s+\d{2,3}\s+(\d{1,2})\s+(\d{1,2})\s+(\d{1,2})\b(?![.,])/);
  let medioTransporteEntrada = mediosM ? mediosM[1] : null;
  let medioTransporteArribo = mediosM ? mediosM[2] : null;
  let medioTransporteSalida = mediosM ? mediosM[3] : null;
  if (!mediosM) {
    const certMedioM = tc.match(/CERTIFICACIONES\s+\d{1,2}\s+\d{2,3}\s+\d{1,3}(?:,\d{3})*\.\d{3}\s+(\d{1,2})\b(?![.,])/i);
    const pagadoMedioM = tc.match(/PRECIO\s+PAGADO\/VALOR\s+COMERCIAL:\s*(\d{1,2})\b(?![.,])/i);
    medioTransporteEntrada = certMedioM?.[1] ?? pagadoMedioM?.[1] ?? null;
    medioTransporteArribo = pagadoMedioM?.[1] ?? certMedioM?.[1] ?? null;
    medioTransporteSalida = null;
  }

  // No. de registro (empresa de mensajería): the COMPLEMENTO 1 of the EM row in the
  // pedimento-level "CLAVE/COMPL. IDENTIFICADOR" table. Partida-level identifier tables use the
  // "IDENTIF." header instead, so this anchor never matches those. The window stops at
  // OBSERVACIONES (the section that follows the table in both layouts).
  const identBlockM = tc.match(/CLAVE\/COMPL\.?\s+IDENTIFICADOR(.{0,400}?)(?:OBSERVACIONES|$)/i);
  const emM = identBlockM ? identBlockM[1].match(/\bEM\s+(\d{1,6})\b/) : null;
  const t1RegistryNumber = emM ? emM[1] : null;

  // Agente aduanal — the name on the "NOMBRE O RAZ. SOC.:" line of the agent block (distinct from
  // the importer's "NOMBRE, DENOMINACION O RAZON SOCIAL:" anchor). Read from original text for
  // case. Consolidados emit the label on its own line followed by the patente number before the
  // razón social, so skip digit-only lines after the label.
  const agenteM = t.match(/NOMBRE\s+O\s+RAZ\.?\s*SOC\.?:?\s*(?:\d+\s*\n)*\s*([^\n]+)/i);
  const agenteAduanal = agenteM ? agenteM[1].trim() : null;

  // Importer entity (razón social + domicilio) for auto-registration. Layout A prints the name
  // right after the "NOMBRE, DENOMINACION O RAZON SOCIAL:" label (first occurrence only — later
  // occurrences belong to the supplier block); layout B scatters that label and prints the name
  // under the importer RFC instead. Both anchors skip digit-only lines and reject column labels.
  const NOT_A_NAME = /^(VAL\.|VALOR|SEGUROS|FLETES|EMBALAJES|C[OÓ]DIGO|MARCAS|DOMICILIO|TRANSPORTE|MEDIOS|FECHAS|CUADRO|DATOS|CLAVE|NUM\.|NOMBRE|CURP|RFC)/i;
  const nameCandidate = (m: RegExpMatchArray | null) => {
    const v = m?.[1]?.trim() ?? '';
    return v && !NOT_A_NAME.test(v) ? v : null;
  };
  const importerName =
    nameCandidate(t.match(/NOMBRE,\s*DENOMINACION\s+O\s+RAZON\s+SOCIAL:?[^\S\n]*\n(?:[^\S\n]*\d+[^\S\n]*\n)*[^\S\n]*([^\n]+)/i)) ??
    (importerRfc
      ? nameCandidate(t.slice(t.indexOf(importerRfc)).match(/^[^\n]*\n(?:[^\S\n]*\d+[^\S\n]*\n)*[^\S\n]*([^\n]+)/))
      : null);

  // Importer DOMICILIO — only when the address starts on the label's own line (the supplier
  // block's "… DOMICILIO:" has its value on the next line and must not be picked up).
  const domicilioM = t.match(/DOMICILIO:[^\S\n]*([^\n]{10,})/i);
  const importerAddress = domicilioM ? domicilioM[1].trim() : null;

  // Agent RFCs — scan a window around each agent-block anchor ("NOMBRE O RAZ. SOC"), since layouts
  // print the RFC before or after it. Persona física (4-letter) RFC = agente; 3-letter RFC =
  // agencia. The importer's RFC can appear near an anchor, so it is explicitly excluded.
  //
  // Partida OBSERVACIONES lines are full of RFC/CURP-shaped consignee identifiers and commonly sit
  // right before the agente block, so picking the first match by document position (as this used
  // to do) let a consignee RFC a few hundred characters BEFORE the anchor beat the real agent RFC
  // that both known layouts print shortly AFTER the "NOMBRE O RAZ. SOC"/"RFC:" label. Pick the
  // match CLOSEST to the anchor instead (absolute distance), tie-broken toward after-the-anchor
  // since neither layout ever prints the real RFC before the label at equal distance.
  //
  // Fixed-length regexes ({4}/{3} letters + {6} digits + {3} alnum, both wrapped in \b) already
  // reject a match that's really the first 13 chars of an 18-char CURP: the CURP's 14th character
  // is itself a word character, so there is no trailing word boundary at position 13 and the match
  // attempt fails — no separate CURP-length guard needed.
  const closestRfcMatch = (re: RegExp, winStart: number, winEnd: number, anchorIndex: number) => {
    let best: RegExpMatchArray | null = null;
    let bestDist = Infinity;
    for (const m of tc.matchAll(re)) {
      if (m.index == null || m.index < winStart || m.index > winEnd || m[0] === importerRfc) continue;
      const dist = m.index >= anchorIndex ? m.index - anchorIndex : anchorIndex - m.index + 0.5;
      if (dist < bestDist) { bestDist = dist; best = m; }
    }
    return best;
  };
  let agentRfc: string | null = null;
  let agencyRfc: string | null = null;
  for (const anchor of tc.matchAll(/NOMBRE\s+O\s+RAZ\.?\s*SOC/gi)) {
    if (anchor.index == null) continue;
    const winStart = Math.max(0, anchor.index - 300);
    const winEnd = anchor.index + 400;
    if (!agentRfc) {
      const m = closestRfcMatch(/\b[A-ZÑ&]{4}\d{6}[A-Z0-9]{3}\b/g, winStart, winEnd, anchor.index);
      agentRfc = m ? m[0] : null;
    }
    if (!agencyRfc) {
      const m = closestRfcMatch(/\b[A-ZÑ&]{3}\d{6}[A-Z0-9]{3}\b/g, winStart, winEnd, anchor.index);
      agencyRfc = m ? m[0] : null;
    }
    if (agentRfc && agencyRfc) break;
  }

  // Tasa de importación — the partida-level IVA TASA. Captured from the pedimento, never computed
  // (RGCE 3.7.35). pdf-parse's positional ordering differs per layout: consolidados emit the tasa
  // BEFORE the label ("33.5000000000 IVA 10.00000", where the trailing number is the CANTIDAD
  // column, not a tasa), other layouts after it ("IVA 33.50000"), so try before then after. The
  // decimal requirement plus the no-slash guard exclude the pedimento-level "IVA/PRV" row. Null
  // for exempt pedimentos with no IVA partida row (partidas show only "IGI 0.00000").
  const tasaM = tc.match(/(\d{1,3}\.\d+)\s+IVA\b(?!\/)/i) ?? tc.match(/\bIVA\s+(\d{1,3}\.\d+)/i);
  const tasaImportacion = tasaM ? String(Number(tasaM[1])) : null;

  const warnings: string[] = [];
  if (lines.length === 0) {
    // A present-but-unparsable "OBSERVACIONES A NIVEL PARTIDA" section is the production-incident
    // signature (a format variant we could not read → zero guías silently). Surface it specifically
    // so upload flags the pedimento instead of accepting an empty extraction; the generic message
    // covers pedimentos that genuinely have no partida-level section.
    if (/OBSERVACIONES\s+A\s+NIVEL\s+PARTIDA/i.test(tc)) {
      warnings.push('Se encontró la sección OBSERVACIONES pero no se pudo interpretar ninguna guía. Verifique el formato de las observaciones a nivel partida (GUIA/VALOR/NOMBRE/RFC-CURP).');
    } else {
      warnings.push('No se encontraron observaciones a nivel partida en el texto.');
    }
  }

  return {
    header: {
      numeroPedimento, clave, importerRfc, importerName, importerAddress,
      agentRfc, agencyRfc, patente,
      customsEntryCode, customsClearanceCode,
      medioTransporteEntrada, medioTransporteArribo, medioTransporteSalida, t1RegistryNumber,
      agenteAduanal, tasaImportacion, tipoCambio,
      entryDate, paymentDate, totalBultos: null,
    },
    lines,
    extractionMethod: 'deterministic',
    usedPositional: false,
    confidence: lines.length > 0 ? 0.9 : 0.1,
    warnings,
    subdivision: emptySubdivision,
    coveredGuias: [],
  };
}
