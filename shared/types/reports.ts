// Shared contract for the on-screen report bundle (Riesgo / Reporte General / Layout).
// The row arrays are byte-for-byte the same data that goes into the downloadable .xlsx files,
// produced by the same pure builders (toLayoutRows / buildReportRows), so the screen and the
// Excel never diverge.

import type { SignalId } from '../risk/signals';

export type RiskResultado = 'verde' | 'amarillo' | 'rojo' | 'gris';

/**
 * Un `ReasonCode` del motor APTO PARA SALIR DEL SERVIDOR.
 *
 * Hasta la fase 4, `shipments.risk_reasons` nunca cruzó la frontera: la pantalla sólo veía
 * `risk_incidences` (prosa ya redactada). Ahora la UI necesita las razones para poder DISPONER sobre
 * una de ellas, y con ellas viaja `evidence`, que es el único sitio del motor donde hay PII:
 *
 *  - `denied_party.evidence.matched` es el NOMBRE DE LA PERSONA que coincidió con una lista de
 *    sancionados. Es el dato más delicado que produce el sistema y no sale de aquí.
 *  - `id.evidence.id` es el RFC/CURP en claro — exactamente el campo que `routes/reports.ts` ya
 *    enmascara con `•••••` en el Reporte General y el Layout. La misma disciplina, o ninguna.
 *
 * Lo que SÍ sale es `detail` (copy humano ya redactado: «Coincidencia en lista de sancionados
 * (OFAC)», «RFC/CURP inválido») y `hallazgoHash`, que es una huella sha256 —irreversible— y es
 * además lo que un auditor necesita para casar la razón con la fila de `riesgo_disposiciones`.
 *
 * `prohibidos.matched` y `pirateria.matched` SÍ salen: son una palabra prohibida y una marca
 * comercial, no datos de una persona, y sin ellos la pantalla no puede distinguir un golpe sobre
 * «Nike» de uno sobre «Rolex» — que es justo la distinción que hace falta para disponer bien.
 */
export interface ReasonCodePublico {
  signalId: SignalId;
  points: number;
  weight: number;
  detail: string;
  /** Evidencia YA REDACTADA (ver arriba). Puede quedar vacía tras la redacción. */
  evidence?: Record<string, unknown>;
  forcesBand?: 'rojo';
  /** La huella con la que esta razón se casa con una disposición. sha256, sin PII dentro. */
  hallazgoHash: string;
}

/** Una disposición humana VIGENTE sobre una línea, tal como la ve la pantalla. */
export interface DisposicionPublica {
  id: string;
  signalId: SignalId;
  hallazgoHash: string;
  estado: 'falso_positivo' | 'mitigado' | 'confirmado';
  motivo: string;
  createdAt: string;
  createdBy: string | null;
  /** El `username` resuelto: un popover que enseña un uuid no responde «¿quién?». */
  createdByUsuario: string | null;
  revalidacionPendiente: boolean;
}

/** Risk view row — the richer shape the on-screen table renders (not the 4-col xlsx artifact). */
export interface RiskScreenRow {
  mwb: string;
  guide: string;
  consignee: string;
  senderCity: string;
  senderCountry: string;
  /** Descripción de la mercancía (traducida al español cuando aplica). */
  description: string;
  /**
   * El color EFECTIVO: lo que manda en el `StatusPill`. `COALESCE(risk_color_efectivo, risk_color)`,
   * así que mientras no exista ninguna disposición es exactamente la palabra del motor.
   */
  resultado: RiskResultado;
  motivo: string;
  /** El asa para disponer sobre esta línea (`POST /:id/riesgo/disposiciones`). */
  shipmentId: string;
  /**
   * Lo que dijo el MOTOR, crudo. Sólo difiere de `resultado` cuando hay una disposición vigente, y
   * cuando difiere la pantalla lo escribe debajo del pill: la palabra del motor nunca desaparece.
   */
  resultadoMotor: RiskResultado;
  /** Color que la línea tenía ANTES de la última corrección de manifiesto. null = sin tag `vN`. */
  resultadoAnterior: RiskResultado | null;
  /** La versión de manifiesto en la que la línea tenía `resultadoAnterior`. */
  versionAnterior: number | null;
  /**
   * `true` = cambió SU dato (su `row_hash` bronce es otro). `false` = su dato es idéntico y lo que
   * cambió fue el CONJUNTO — `agregado`, `direcciones` y `bbdd` son señales entre filas, así que una
   * línea puede cambiar de color sin que nadie tocara su renglón. El popover lo dice con esas
   * palabras, porque «cambió tu color y tu dato es el mismo» es la pregunta que llega por teléfono.
   */
  datoCambio: boolean;
  /** Las razones del motor, redactadas (ver `ReasonCodePublico`). Vacío si la fila no disparó nada. */
  reasons: ReasonCodePublico[];
  /** Las disposiciones humanas que aplican hoy sobre esta línea. */
  disposiciones: DisposicionPublica[];
  /** Alguna disposición vigente se afirmó contra otro ruleset: ámbar, «que alguien la mire». */
  revalidacionPendiente: boolean;
}

/** Los cuatro (cinco con `sinDatos`) cubos del resumen de riesgo. */
export interface RiskSummaryData {
  analizados: number;
  aprobados: number;
  noIdentificados: number;
  validarEnPrevio: number;
  sinDatos?: number;
}

/** Whether import-data may still be edited, and if not, why. */
export interface ReportLockState {
  editable: boolean;
  reason: string | null;
}

/**
 * Per-MANIFEST risk bundle (Análisis de Riesgo). Risk is shipment-scoped and pedimento-independent,
 * so it stays at manifest level even though report+layout are now per-pedimento.
 */
export interface RiskBundle {
  /** Risk view (exception-first). */
  risk: RiskScreenRow[];
  /** True when import-data changed after the last risk run (score no longer matches data). */
  riskStale: boolean;
  /** `manifests.version_vigente` — el número que la cabecera enseña como «Manifiesto vN». */
  version: number;
  /**
   * Los DOS resúmenes, contados sobre las mismas filas que la pantalla enseña (no sobre una segunda
   * consulta que podría discrepar): `summary` cuenta `resultadoMotor`, `summaryEfectivo` cuenta
   * `resultado`. Son idénticos mientras no exista ninguna disposición, que es el estado normal; la
   * pantalla sólo enseña el crudo como cifra secundaria cuando de verdad difieren.
   */
  summary: RiskSummaryData;
  summaryEfectivo: RiskSummaryData;
  /** ISO timestamp the bundle was built. */
  generatedAt: string;
  /** sha256 of the canonical bundle content — recorded in the audit row for dispute reproducibility. */
  contentHash: string;
}

/**
 * Per-PEDIMENTO report bundle (Reporte General + Layout for one subdivisión), built over that
 * pedimento's covered-guía subset + its own import_data. Carries consignee identity PII.
 */
export interface PedimentoReportsBundle {
  /** Reporte General — 36 columns keyed by header. */
  report: Record<string, string>[];
  /** Layout — 34 columns keyed by header. */
  layout: Record<string, string>[];
  /** Edit lock derived from this pedimento's finalization state. */
  lock: ReportLockState;
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
  valueUsdApprox?: boolean;     // valueUsd derived from peso-rounded VAL ADU (consolidado) — compare with wider tolerance
}

export interface ExtractedPedimentoHeader {
  importerName?: string | null;    // razón social printed in the importer block (best-effort)
  importerAddress?: string | null; // DOMICILIO line of the importer block (best-effort)
  numeroPedimento: string | null;
  clave: string | null;
  importerRfc: string | null;
  agentRfc: string | null;
  agencyRfc: string | null;
  patente: string | null;
  customsEntryCode: string | null;     // clave de aduana de entrada (ADUANA E/S)
  customsClearanceCode: string | null; // clave de aduana de despacho (SECCION ADUANERA DE DESPACHO)
  medioTransporteEntrada: string | null; // MEDIOS DE TRANSPORTE — clave ENTRADA/SALIDA (Apéndice 3)
  medioTransporteArribo: string | null;  // MEDIOS DE TRANSPORTE — clave ARRIBO
  medioTransporteSalida: string | null;  // MEDIOS DE TRANSPORTE — clave SALIDA
  t1RegistryNumber: string | null;     // No. de registro: COMPLEMENTO 1 del identificador EM
  agenteAduanal: string | null;        // NOMBRE O RAZ. SOC. del agente aduanal
  tasaImportacion: string | null;      // partida-level IVA TASA (e.g. "33.5"); null when exempt
  tipoCambio: number | null;
  entryDate: string | null;     // ISO yyyy-mm-dd
  paymentDate: string | null;   // ISO yyyy-mm-dd
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
  // Set by extractPedimento (not extractFromText) when the PDF's text layer is empty or trivially
  // short — the signature of an image-only scan that pdf-parse reads without throwing. Detection
  // only; there is no OCR fallback in this pass.
  scannedNoTextLayer?: boolean;
}

/** Built from the manifest's shipments (+ optional import data) — the "should be" side. */
export interface ExpectedPedimento {
  header: Partial<ExtractedPedimentoHeader>;
  // `id` is the display credential (curp ?? rfc); `acceptedIds` carries every credential the
  // manifest knows for the guía (RFC and CURP), since the pedimento may print either one.
  lines: { guia: string; valueUsd: number; consigneeName: string; id: string; acceptedIds?: string[] }[];
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
