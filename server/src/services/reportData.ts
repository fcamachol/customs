import { query } from '../db/pool';
import { canSeeAll } from '../auth/access';
import type { Claims } from '../auth/token';
import { decryptShipment } from '../crypto/fieldCrypto';
import { toLayoutRows } from '../../../shared/export/layoutExport';
import { buildReportRows } from '../../../shared/export/reportBuilder';
import { countryDisplayName } from '../../../shared/parsing/catalogs';
import { traducirDescripcion } from '../../../shared/i18n/descripcionEs';
import type { Shipment } from '../../../shared/types/shipment';
import type {
  RiskScreenRow,
  RiskResultado,
  ReasonCodePublico,
  DisposicionPublica,
  RiskSummaryData,
} from '../../../shared/types/reports';
import type { ReasonCode, SignalId } from '../../../shared/risk/signals';
import { hallazgoHash } from '../../../shared/risk/efectivo';
import { normGuia, normGuiaSet } from '../../../shared/pedimento/guia';

/** El resumen denormalizado que `materializarRiesgoEfectivo` deja en `shipments.risk_disposiciones`. */
interface ResumenDisposicionesFila {
  aplicadas?: Array<{
    id: string;
    signalId: SignalId;
    hallazgoHash: string;
    estado: DisposicionPublica['estado'];
    motivo: string;
    createdAt: string;
    createdBy: string | null;
    revalidacionPendiente: boolean;
  }>;
  suprimidas?: SignalId[];
  caducadas?: string[];
  revalidacionPendiente?: boolean;
}

export interface LoadedShipment {
  data: Shipment;
  /** EFECTIVO (`COALESCE`). Es el que va al Reporte General y al pill de la pantalla. */
  risk_color: string | null;
  risk_incidences: string[] | null;
  /**
   * Las columnas de la fase 4. Van en el mismo SELECT y no en una segunda consulta porque son de la
   * MISMA fila: leerlas aparte abriría la puerta a que la pantalla mezclara el color de una corrida
   * con las razones de otra. Los consumidores que no las usan (layout, reporte general) simplemente
   * las ignoran.
   */
  id?: string;
  idempotency_key?: string;
  /** La palabra CRUDA del motor. Nunca se pierde de vista. */
  risk_color_motor?: string | null;
  risk_reasons?: ReasonCode[] | null;
  risk_disposiciones?: ResumenDisposicionesFila | null;
  risk_color_anterior?: string | null;
  risk_version_anterior?: number | null;
}

/** Returns true if the user may access the given manifest (RF-22: all internal roles share visibility). */
export async function assertManifestAccess(manifestId: string, user: Claims): Promise<boolean> {
  if (canSeeAll(user.role)) return true;
  const { rows } = await query<{ created_by: string | null }>(
    'SELECT created_by FROM manifests WHERE id=$1', [manifestId]);
  return rows.length > 0 && rows[0].created_by === user.userId;
}

/**
 * Resolve a pedimento → its manifest and apply the same access rule as assertManifestAccess.
 * Returns the manifest_id when access is granted, or null (not found OR forbidden — the caller
 * distinguishes via the `found` flag) so the route can answer 404 vs 403 correctly.
 */
export async function resolvePedimentoAccess(
  pedimentoId: string,
  user: Claims,
): Promise<{ found: boolean; allowed: boolean; manifestId: string | null }> {
  const { rows } = await query<{ manifest_id: string; created_by: string | null }>(
    `SELECT p.manifest_id, m.created_by
       FROM pedimentos p JOIN manifests m ON m.id = p.manifest_id
      WHERE p.id = $1`,
    [pedimentoId],
  );
  if (!rows.length) return { found: false, allowed: false, manifestId: null };
  const allowed = canSeeAll(user.role) || rows[0].created_by === user.userId;
  return { found: true, allowed, manifestId: rows[0].manifest_id };
}

/**
 * Load + decrypt all shipments for a manifest (PII decrypted; safe to score/export).
 *
 * `risk_color` es el color EFECTIVO —`COALESCE(risk_color_efectivo, risk_color)`— y por eso el
 * `Resultado` de la pantalla y del reporte general ya lleva las disposiciones humanas aplicadas.
 * NULL significa "sin disposición, manda el motor", así que mientras no exista ninguna esto devuelve
 * exactamente lo de siempre. La palabra del motor no se pierde: sigue en la columna cruda de la fila,
 * y la fase 4 la pone en pantalla junto al efectivo.
 */
export async function loadShipments(manifestId: string): Promise<LoadedShipment[]> {
  const { rows } = await query<LoadedShipment>(
    `SELECT id,
            idempotency_key,
            data,
            COALESCE(risk_color_efectivo, risk_color) AS risk_color,
            risk_color                                AS risk_color_motor,
            risk_incidences,
            risk_reasons,
            risk_disposiciones,
            risk_color_anterior,
            risk_version_anterior
       FROM shipments WHERE manifest_id=$1`, [manifestId]);
  return rows.map((r) => ({ ...r, data: decryptShipment(r.data) }));
}

// =================================================================================================
// Redacción de las razones del motor (§15, trampa 3 de la orden de trabajo 4)
// =================================================================================================

/**
 * Los campos de `evidence` que NO cruzan la frontera del servidor, por señal.
 *
 * `reports.json` ya tiene disciplina de redacción —`routes/reports.ts` enmascara RFC/CURP/pasaporte
 * con `•••••` para `autoridad`— y `risk_reasons` es la primera cosa del motor que sale a la pantalla.
 * Aquí la regla es más dura que allí, y a propósito: estos dos campos no se enmascaran para un rol,
 * se OMITEN para todos. Un nombre en una lista de sancionados es una acusación sobre una persona
 * concreta; un RFC/CURP en claro es el identificador que el resto del bundle ya oculta. Ninguno de
 * los dos hace falta en pantalla: `detail` dice lo mismo en prosa («Coincidencia en lista de
 * sancionados (OFAC)», «RFC/CURP inválido») y la huella permite casar la razón con su disposición.
 *
 * Se listan por señal y no por nombre de campo global porque `matched` significa cosas distintas:
 * en `pirateria` es una marca comercial y en `denied_party` es una persona.
 */
const EVIDENCIA_REDACTADA: Partial<Record<SignalId, readonly string[]>> = {
  denied_party: ['matched'],
  id: ['id'],
};

/** Un `ReasonCode` listo para salir: huella calculada sobre el original, evidencia podada. */
export function redactarReason(r: ReasonCode): ReasonCodePublico {
  // La huella se calcula sobre la razón ÍNTEGRA, antes de podar: es la misma que el servidor usa al
  // escribir una disposición (`hallazgoHash` sobre `shipments.risk_reasons`). Calcularla sobre la
  // versión redactada produciría una huella que no casa con nada y rompería el arrastre en silencio.
  const hash = hallazgoHash(r);
  const fuera = EVIDENCIA_REDACTADA[r.signalId];
  let evidence = r.evidence;
  if (evidence && fuera?.length) {
    const copia: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(evidence)) if (!fuera.includes(k)) copia[k] = v;
    evidence = copia;
  }
  return {
    signalId: r.signalId,
    points: r.points,
    weight: r.weight,
    detail: r.detail,
    ...(evidence ? { evidence } : {}),
    ...(r.forcesBand ? { forcesBand: r.forcesBand } : {}),
    hallazgoHash: hash,
  };
}

/** Las disposiciones aplicadas de una fila, con el autor resuelto a nombre legible. */
function disposicionesDeFila(
  r: LoadedShipment,
  usuarios: Record<string, string>,
): DisposicionPublica[] {
  return (r.risk_disposiciones?.aplicadas ?? []).map((d) => ({
    id: d.id,
    signalId: d.signalId,
    hallazgoHash: d.hallazgoHash,
    estado: d.estado,
    motivo: d.motivo,
    createdAt: d.createdAt,
    createdBy: d.createdBy,
    createdByUsuario: d.createdBy ? (usuarios[d.createdBy] ?? null) : null,
    revalidacionPendiente: d.revalidacionPendiente,
  }));
}

/** El lenguaje del badge ámbar, compartido por la pantalla y el artefacto. */
const ETIQUETA_ESTADO: Record<DisposicionPublica['estado'], string> = {
  falso_positivo: 'Falso positivo',
  mitigado: 'Mitigado',
  confirmado: 'Confirmado',
};

/** Rows for the downloadable Análisis de Riesgo workbook (compliance artifact). */
export function buildRiskXlsxRows(loaded: LoadedShipment[]): Record<string, string>[] {
  return loaded.map((r) => {
    const aplicadas = r.risk_disposiciones?.aplicadas ?? [];
    return {
      Guia: r.data.guideId,
      Destinatario: r.data.consignee.name,
      'Descripción de la mercancía': traducirDescripcion(r.data.description ?? ''),
      /**
       * `Resultado` SIGUE SIENDO LA PALABRA DEL MOTOR. Un documento de cumplimiento que cambia su
       * veredicto porque alguien afirmó algo es un documento que miente; uno que pone las dos cosas
       * lado a lado es el expediente. Por eso aquí va el crudo y las disposiciones van AL LADO, en
       * columnas propias. (En pantalla manda el efectivo, que es una decisión operativa distinta.)
       *
       * `risk_color_motor` puede venir sin definir cuando la fila la cargó un llamador antiguo; el
       * fallback al efectivo conserva el comportamiento previo en vez de vaciar la columna.
       */
      Resultado: r.risk_color_motor ?? r.risk_color ?? '',
      Motivo: (r.risk_incidences ?? []).join('; '),
      Disposición: aplicadas.map((d) => `${d.signalId}: ${ETIQUETA_ESTADO[d.estado]}`).join('; '),
      'Motivo de disposición': aplicadas.map((d) => d.motivo).join('; '),
      /** Vacío = el color de esta línea no cambió con la última corrección de manifiesto. */
      'Resultado anterior': r.risk_color_anterior
        ? `${r.risk_color_anterior}${r.risk_version_anterior != null ? ` (v${r.risk_version_anterior})` : ''}`
        : '',
    };
  });
}

/**
 * ¿Cambió el DATO de la línea, o sólo el conjunto?
 *
 * Devuelve un mapa `idempotency_key → datoCambio` comparando el `row_hash` de bronce entre la
 * versión vigente y la versión anterior de cada línea. Es la única forma honesta de contestarlo:
 * `agregado`, `direcciones` y `bbdd` son señales ENTRE filas, así que una línea puede cambiar de
 * color con su renglón intacto, y decirle a un cliente «cambió tu dato» cuando no cambió es una
 * afirmación falsa sobre su documento.
 *
 * `row_hash` es NULL en las v1 retro-llenadas por la migración (son hashes de texto EN CLARO y la
 * migración no descifra PII para calcularlos). Cuando falta un hash NO se puede comparar, y entonces
 * se devuelve `true`: la pantalla se calla en vez de afirmar un «su dato no cambió» que no puede
 * probar. El default se equivoca del lado de no mentir.
 */
export async function loadDatoCambio(manifestId: string): Promise<Record<string, boolean>> {
  const { rows } = await query<{ idempotency_key: string; version: number; row_hash: string | null }>(
    `SELECT sr.idempotency_key, sr.version, sr.row_hash
       FROM manifest_staging_rows sr
       JOIN manifests m ON m.id = sr.manifest_id
      WHERE sr.manifest_id = $1
        AND (sr.version = m.version_vigente
             OR sr.version IN (SELECT DISTINCT risk_version_anterior
                                 FROM shipments
                                WHERE manifest_id = $1 AND risk_version_anterior IS NOT NULL))`,
    [manifestId],
  );
  if (!rows.length) return {};
  const porClave = new Map<string, Map<number, string | null>>();
  for (const r of rows) {
    let versiones = porClave.get(r.idempotency_key);
    if (!versiones) { versiones = new Map(); porClave.set(r.idempotency_key, versiones); }
    versiones.set(r.version, r.row_hash);
  }
  const out: Record<string, boolean> = {};
  for (const [clave, versiones] of porClave) {
    const numeros = [...versiones.keys()].sort((a, b) => a - b);
    if (numeros.length < 2) continue;   // sin par que comparar: el llamador decide (true)
    const antes = versiones.get(numeros[numeros.length - 2]);
    const ahora = versiones.get(numeros[numeros.length - 1]);
    out[clave] = !(antes && ahora && antes === ahora);
  }
  return out;
}

/** Los `username` de un conjunto de ids de usuario (para que el popover diga quién, no un uuid). */
export async function loadUsuarios(ids: string[]): Promise<Record<string, string>> {
  const unicos = Array.from(new Set(ids.filter(Boolean)));
  if (!unicos.length) return {};
  const { rows } = await query<{ id: string; username: string }>(
    'SELECT id, username FROM users WHERE id = ANY($1)', [unicos]);
  return Object.fromEntries(rows.map((r) => [r.id, r.username]));
}

/** Richer rows for the on-screen risk table. */
export function buildRiskScreenRows(
  loaded: LoadedShipment[],
  ctx: { datoCambio?: Record<string, boolean>; usuarios?: Record<string, string> } = {},
): RiskScreenRow[] {
  const usuarios = ctx.usuarios ?? {};
  return loaded.map((r) => ({
    mwb: r.data.mawbReference,
    guide: r.data.guideId,
    consignee: r.data.consignee.name,
    senderCity: r.data.sender.address ?? '',
    senderCountry: r.data.platform.countryOfOrigin ?? r.data.originCountry,
    description: traducirDescripcion(r.data.description ?? ''),
    resultado: (r.risk_color ?? 'gris') as RiskResultado,
    motivo: (r.risk_incidences ?? []).join('; '),
    shipmentId: r.id ?? '',
    // Sin la columna cruda (llamador antiguo) el motor y el efectivo coinciden por construcción, que
    // es exactamente lo que había antes de esta fase: no hay caption que enseñar.
    resultadoMotor: (r.risk_color_motor ?? r.risk_color ?? 'gris') as RiskResultado,
    resultadoAnterior: (r.risk_color_anterior ?? null) as RiskResultado | null,
    versionAnterior: r.risk_version_anterior ?? null,
    datoCambio: r.idempotency_key ? (ctx.datoCambio?.[r.idempotency_key] ?? true) : true,
    reasons: (r.risk_reasons ?? []).map(redactarReason),
    disposiciones: disposicionesDeFila(r, usuarios),
    revalidacionPendiente: !!r.risk_disposiciones?.revalidacionPendiente,
  }));
}

/** Cuenta un conjunto de filas por color, sobre el campo que se le indique (crudo o efectivo). */
export function resumirRiesgo(
  rows: RiskScreenRow[],
  campo: 'resultado' | 'resultadoMotor',
): RiskSummaryData {
  const n = (c: RiskResultado): number => rows.filter((r) => r[campo] === c).length;
  return {
    analizados: rows.length,
    aprobados: n('verde'),
    noIdentificados: n('amarillo'),
    validarEnPrevio: n('rojo'),
    sinDatos: n('gris'),
  };
}

/** Fetch the client/platform overlay (Remitente + Plataforma blocks) for a manifest's report. */
async function clientOverlay(manifestId: string) {
  const m = await query(
    `SELECT c.name, c.tax_id, c.address, c.phone, c.email,
            p.commercial_name, p.country_of_origin, p.legal_name, p.email AS platform_email, p.url AS platform_url
     FROM manifests m
     LEFT JOIN clients c ON c.id = m.client_id
     LEFT JOIN client_platforms p ON p.id = m.platform_id
     WHERE m.id = $1`,
    [manifestId],
  );
  const manifest = m.rows[0] ?? {};
  if (!manifest.name) return undefined;
  return {
    name: manifest.name as string,
    tax_id: manifest.tax_id ?? undefined,
    address: manifest.address ?? undefined,
    phone: manifest.phone ?? undefined,
    email: manifest.email ?? undefined,
    // Always pass a platform object so the client-platform is authoritative over
    // any platform embedded in individual shipments. When platform_id is null all
    // four fields are empty strings, which clears the Plataforma block.
    platform: {
      commercialName: manifest.commercial_name ?? '',
      countryOfOrigin: countryDisplayName(manifest.country_of_origin ?? ''),
      legalName: manifest.legal_name ?? '',
      email: manifest.platform_email ?? '',
      url: manifest.platform_url ?? '',
    },
  };
}

/** D3: enrich CNNE RFC/CURP from the validated-RFCs catalog, scoped to the given consignee keys. */
async function validatedRfcsFor(loaded: LoadedShipment[]): Promise<Record<string, { rfc?: string; curp?: string; name?: string }>> {
  const keys = Array.from(
    new Set(
      loaded
        .map((r) => (r.data.consignee.rfc || r.data.consignee.curp || '').trim().toUpperCase())
        .filter(Boolean),
    ),
  );
  if (keys.length === 0) return {};
  const { rows: rfcRows } = await query<{ id_ref: string; rfc: string | null; curp: string | null; name: string | null }>(
    'SELECT id_ref, rfc, curp, name FROM validated_rfcs WHERE upper(btrim(id_ref)) = ANY($1)', [keys]);
  return Object.fromEntries(
    rfcRows.map((r) => [r.id_ref.trim().toUpperCase(), { rfc: r.rfc ?? undefined, curp: r.curp ?? undefined, name: r.name ?? undefined }]),
  );
}

/** Shared assembler: build the Reporte General rows over a shipment subset + import_data + overlay. */
async function reportRows(
  manifestId: string,
  loaded: LoadedShipment[],
  importData: Record<string, unknown> | undefined,
): Promise<Record<string, string>[]> {
  return buildReportRows({
    shipments: loaded.map((r) => r.data),
    riskByGuide: Object.fromEntries(loaded.map((r) => [r.data.guideId, { color: r.risk_color ?? '', incidences: r.risk_incidences ?? [] }])),
    importData,
    validatedRfcs: await validatedRfcsFor(loaded),
    client: await clientOverlay(manifestId),
  });
}

/** A pedimento subdivision: its manifest, its covered-guía subset, and its captured import_data. */
export interface PedimentoReportScope {
  manifestId: string;
  coveredGuias: string[];
  importData: Record<string, unknown> | undefined;
}

/** Load a pedimento's report scope (manifest + covered_guias + import_data). Null if not found. */
export async function loadPedimentoScope(pedimentoId: string): Promise<PedimentoReportScope | null> {
  const { rows } = await query<{ manifest_id: string; covered_guias: string[] | null; import_data: Record<string, unknown> | null }>(
    'SELECT manifest_id, covered_guias, import_data FROM pedimentos WHERE id=$1', [pedimentoId]);
  if (!rows.length) return null;
  return {
    manifestId: rows[0].manifest_id,
    coveredGuias: rows[0].covered_guias ?? [],
    importData: rows[0].import_data ?? undefined,
  };
}

/** Narrow a manifest's shipments to a pedimento's covered-guía subset (empty subset → no rows). */
export function subsetForCoverage(loaded: LoadedShipment[], coveredGuias: string[]): LoadedShipment[] {
  if (!coveredGuias.length) return [];
  // Normalized match: covered_guias (from the PDF) and guideId (from the manifest) may differ only
  // in punctuation/case; compare canonical forms so a subdivisión's report keeps its real subset.
  const set = normGuiaSet(coveredGuias);
  return loaded.filter((s) => set.has(normGuia(s.data.guideId)));
}

/**
 * Build the Reporte General rows for one PEDIMENTO (subdivisión): its covered-guía shipment subset +
 * its own captured import_data + the manifest's client/platform overlay + D3 validated-RFC enrichment.
 * Each subdivision is its own customs submission, so a shipment NOT in covered_guias is absent here.
 * Pass pre-loaded manifest shipments to avoid a second decrypt.
 */
export async function buildReportRowsForPedimento(
  scope: PedimentoReportScope,
  loadedManifest: LoadedShipment[],
): Promise<Record<string, string>[]> {
  const subset = subsetForCoverage(loadedManifest, scope.coveredGuias);
  return reportRows(scope.manifestId, subset, scope.importData);
}

export const layoutRowsFor = (loaded: LoadedShipment[]): Record<string, string>[] =>
  toLayoutRows(loaded.map((r) => r.data));
