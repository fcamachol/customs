import { query } from '../db/pool';
import { scoreManifest, rulesetVersionFor } from '../../../shared/risk/classify';
import type { Thresholds } from '../../../shared/risk/ruleset';
import type { DeniedPartyEntry } from '../../../shared/risk/lists';
import type { ScoredShipment } from '../../../shared/risk/classify';
import type { Shipment } from '../../../shared/types/shipment';
import { decryptShipment } from '../crypto/fieldCrypto';
import { rawBlindIndex } from '../crypto/blindIndex';
import { deleteManifestHistory, loadHistoryCounts, recordNames } from './monthlyHistory';
import { buildRiskWorkbook } from './artifacts';
import { saveFile } from '../storage/files';
import { materializarRiesgoEfectivo } from './riesgoEfectivo';
import { traducirDescripcion } from '../../../shared/i18n/descripcionEs';

/**
 * Risk scoring, extracted from POST /api/manifests/:id/risk so it has exactly one implementation.
 *
 * It was inline in the route, which meant the only way to score a manifest was for a human to click a
 * button. The prealerta pipeline needs the same work to happen unattended the moment a manifiesto is
 * ingested (PRD-02, the join between the two systems), and duplicating ninety lines of scoring — with
 * its blind-index tokenization and monthly-history bookkeeping — would guarantee the two drifted apart.
 *
 * Behaviour is unchanged from the route version. `userId` is null when the system runs it, which is
 * also what distinguishes an automatic score from a human-triggered one in the audit trail.
 */

export interface RiskSummary {
  analizados: number;
  aprobados: number;
  noIdentificados: number;
  validarEnPrevio: number;
  sinDatos: number;
}

export interface RunRiskResult {
  /** Lo que dijo el MOTOR. Se conserva íntegro en la fila, en el artefacto y aquí. */
  summary: RiskSummary;
  /**
   * Lo que queda tras las disposiciones humanas vigentes (`COALESCE(risk_color_efectivo, risk_color)`).
   * Idéntico a `summary` mientras no exista ninguna disposición, que es el estado normal.
   *
   * La MÁQUINA DE ESTADOS se cuelga de éste, no del crudo (`services/prealertaIngest.ts`): si alguien
   * ya declaró falso positivo el único hallazgo de un caso, mantenerlo en `riesgo_con_hallazgos`
   * exigiría documentos por algo que ya se resolvió. El crudo no desaparece de ningún sitio; deja de
   * ser lo que MANDA.
   */
  summaryEfectivo: RiskSummary;
  scored: ScoredShipment[];
  /** Table PKs, index-aligned with `scored`, so callers can join back to shipments rows. */
  shipmentIds: string[];
  shipments: Shipment[];
  riskFileId: string;
  rulesetVersion: string;
  period: string;
}

async function loadConfig<T>(key: string): Promise<T | undefined> {
  const { rows } = await query<{ value: T }>('SELECT value FROM config WHERE key=$1', [key]);
  return rows[0]?.value;
}

/**
 * El mismo resumen, contado sobre el color EFECTIVO — leído de la fila, no recalculado en memoria.
 *
 * Se lee de la base a propósito: el efectivo lo acaba de escribir `materializarRiesgoEfectivo` y
 * volver a derivarlo aquí sería una segunda implementación de la misma regla, con la garantía de que
 * un día discreparán. `COALESCE` es exactamente lo que hacen las cuatro superficies de lectura, así
 * que este resumen y lo que ve un humano en pantalla no pueden separarse.
 *
 * `analizados` viene del crudo: cuántas líneas se calificaron es un hecho del motor y no cambia
 * porque alguien afirme algo sobre una de ellas.
 */
async function resumenEfectivo(manifestId: string, crudo: RiskSummary): Promise<RiskSummary> {
  const { rows } = await query<{ color: string | null; n: string }>(
    `SELECT COALESCE(risk_color_efectivo, risk_color) AS color, count(*)::int AS n
       FROM shipments
      WHERE manifest_id = $1 AND risk_color IS NOT NULL
      GROUP BY 1`,
    [manifestId],
  );
  const n = (color: string): number => Number(rows.find((r) => r.color === color)?.n ?? 0);
  return {
    analizados: crudo.analizados,
    aprobados: n('verde'),
    noIdentificados: n('amarillo'),
    validarEnPrevio: n('rojo'),
    sinDatos: n('gris'),
  };
}

export async function runRiskForManifest(input: {
  manifestId: string;
  period?: string;
  userId: string | null;
}): Promise<RunRiskResult | null> {
  const { manifestId, userId } = input;
  const period = input.period ?? new Date().toISOString().slice(0, 7);

  const { rows } = await query<{ id: string; data: Shipment }>(
    'SELECT id, data FROM shipments WHERE manifest_id=$1',
    [manifestId],
  );
  // Nothing promoted means nothing to score. Returning null rather than an empty result lets the
  // caller distinguish "scored, all clean" from "there was nothing to score" — which matters, because
  // the second case is usually a manifest whose rows all failed validation.
  if (!rows.length) return null;

  const shipments = rows.map((r) => decryptShipment(r.data));

  const prohibitedKeywords = await loadConfig<string[]>('prohibited');
  const piracyBrands = await loadConfig<string[]>('piracy_brands');
  const thresholds = await loadConfig<Partial<Record<keyof Thresholds, unknown>>>('validation_params');
  const deniedParties = await loadConfig<DeniedPartyEntry[]>('denied_parties');

  await deleteManifestHistory(manifestId);
  const history = await loadHistoryCounts(period, manifestId);

  const scoreOptions = {
    prohibitedKeywords,
    piracyBrands,
    thresholds,
    deniedParties,
    nameTokenFn: rawBlindIndex,
  };
  const scored = scoreManifest(shipments, history, scoreOptions);

  // Index by the table PK, not the id inside the data JSON — they can differ.
  // `risk_insufficient_data` is persisted (and not merely computed) because the effective-colour
  // layer re-runs `scoreRow` outside this function; see the field's doc in `shared/risk/classify.ts`.
  for (const [i, sc] of scored.entries()) {
    await query(
      `UPDATE shipments
          SET risk_score=$1, risk_color=$2, risk_incidences=$3, risk_reasons=$4, ruleset_hash=$5,
              risk_insufficient_data=$6
        WHERE id=$7`,
      [
        sc.score, sc.color, JSON.stringify(sc.incidences), JSON.stringify(sc.reasons), sc.ruleset_hash,
        sc.insufficientData, rows[i].id,
      ],
    );
  }
  await recordNames(shipments.map((s) => s.consignee.name), period, manifestId);

  /**
   * EL ACARREO QUE NO CAMBIÓ NADA SE BORRA. `manifiestoVersiones.aplicarVersion` copia el color viejo
   * a `risk_*_anterior` dentro del mismo upsert que lo anula, ANTES de saber cuál va a ser el nuevo.
   * Aquí ya se sabe. Anular los tres cuando el color recalculado coincide con el viejo deja una regla
   * de lectura que ningún consumidor tiene que interpretar: **si `risk_color_anterior` no es NULL,
   * hubo cambio y hay algo que enseñar**. La alternativa —dejarlo siempre puesto y que cada pantalla
   * compare— garantiza que tarde o temprano una de ellas compare mal y anuncie un cambio inexistente.
   */
  await query(
    `UPDATE shipments
        SET risk_color_anterior = NULL, risk_score_anterior = NULL, risk_version_anterior = NULL
      WHERE manifest_id = $1 AND risk_color_anterior IS NOT NULL
        AND risk_color_anterior IS NOT DISTINCT FROM risk_color`,
    [manifestId],
  );

  /**
   * El color efectivo, recalculado sobre las razones que acaban de escribirse. Va DESPUÉS del bucle
   * porque lee `risk_reasons` de la fila: es la misma disciplina absoluta de `holdActivo`, preguntarle
   * a la tabla qué es verdad en vez de arrastrar el resultado en memoria.
   */
  await materializarRiesgoEfectivo(query, { manifestId });

  const summary: RiskSummary = {
    analizados: scored.length,
    aprobados: scored.filter((s) => s.color === 'verde').length,
    noIdentificados: scored.filter((s) => s.color === 'amarillo').length,
    validarEnPrevio: scored.filter((s) => s.color === 'rojo').length,
    sinDatos: scored.filter((s) => s.color === 'gris').length,
  };
  const summaryEfectivo = await resumenEfectivo(manifestId, summary);

  const branding = await loadConfig<{ companyName?: string; rfc?: string }>('branding');
  const riskBuffer = buildRiskWorkbook(
    scored.map((s) => ({
      Guia: s.shipment.guideId,
      Destinatario: s.shipment.consignee.name,
      'Descripción de la mercancía': traducirDescripcion(s.shipment.description ?? ''),
      Resultado: s.color,
      Motivo: s.incidences.join('; '),
    })),
    branding,
  );
  const riskFile = await saveFile({
    kind: 'risk_analysis',
    originalName: 'Analisis_de_Riesgo.xlsx',
    bytes: riskBuffer,
    uploadedBy: userId,
  });

  const rulesetVersion = rulesetVersionFor(scoreOptions);
  // Clearing risk_stale records that the persisted scores match the current data again.
  await query(
    'UPDATE manifests SET risk_file_id=$1, ruleset_version=$2, risk_stale=false WHERE id=$3',
    [riskFile.id, rulesetVersion, manifestId],
  );

  return {
    summary,
    summaryEfectivo,
    scored,
    shipmentIds: rows.map((r) => r.id),
    shipments,
    riskFileId: riskFile.id,
    rulesetVersion,
    period,
  };
}
