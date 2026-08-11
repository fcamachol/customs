import { createHash } from 'node:crypto';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { recordAudit, stableStringify } from './audit';
import { encryptShipmentPii } from '../crypto/fieldCrypto';
import { runRiskForManifest, type RiskSummary } from './riskService';
import { normGuia } from '../../../shared/pedimento/guia';
import type { StagingRow } from '../../../shared/types/staging';
import type { Shipment } from '../../../shared/types/shipment';

/**
 * El manifiesto corregido, en un solo lugar (diseño 2026-08-10, §2).
 *
 * POR QUÉ EXISTE ESTE MÓDULO. El producto pidió "mandar un manifiesto nuevo con el mismo MAWB que
 * sustituya al anterior", y era razonable suponer que eso ya ocurría implícitamente por la vía
 * prealerta (reenvío → attach → re-promoción). No ocurría. La rama de attach de `manifiestoIngest.ts`
 * nunca usaba `parsed.rows`: archivaba el adjunto nuevo, volvía a promover las filas VIEJAS de
 * staging, marcaba `risk_stale` y devolvía `adjuntado` con los `counts` del archivo que acababa de
 * tirar. Un cliente que corregía 10 piezas a 99 recibía acuse de recibo y el sistema seguía
 * calificando riesgo sobre las 10. Por la vía UI era aún más simple: `POST /api/manifests` responde
 * 409 antes de persistir nada, así que no había corrección posible en absoluto.
 *
 * De ahí la forma del módulo: no estamos añadiéndole trazabilidad a una corrección que ya
 * funcionaba, estamos construyendo la corrección, y el expediente es la forma en que se construye.
 * `stageVersion` y `aplicarVersion` son los dos pasos, y son dos porque un humano quiere ver el diff
 * antes de reemplazar el oro. La vía prealerta atraviesa ambos en una sola llamada, desatendida, con
 * un motivo generado por el sistema — decir de dónde vino es un motivo honesto; un motivo vacío no.
 *
 * LA TRAMPA CENTRAL: EL DIFF NO SE PUEDE HACER EN SQL SOBRE `data`. `crypto/fieldCrypto.ts` cifra con
 * AES-256-GCM e IV ALEATORIO POR CAMPO. Dos cifrados del mismo nombre son bytes distintos, así que
 * comparar la columna `data` jsonb entre dos versiones marcaría TODAS las líneas como modificadas,
 * siempre — y peor, lo haría en silencio y con aspecto de estar funcionando. Por eso el hash se
 * calcula sobre el shipment EN CLARO, ANTES de cifrar (`filaHash`), y se guarda en
 * `manifest_staging_rows.row_hash`: nunca hace falta descifrar para diferenciar, el hash no contiene
 * PII, y el diff es un join de dos mapas.
 */

/** La firma de `withTransaction`, y la forma que `db/pool`'s `query` también satisface. */
type QueryFn = (text: string, params?: unknown[]) => Promise<any>;

export type OrigenVersion = 'carga_manual' | 'prealerta';

export interface CountsVersion {
  total: number;
  valid: number;
  warning: number;
  error: number;
}

export interface DiffVersion {
  /** Claves de idempotencia, nunca valores: el diff es derivable de dos versiones retenidas. */
  altas: string[];
  bajas: string[];
  modificadas: string[];
  sinCambio: number;
}

/**
 * sha256 canónico del shipment EN CLARO.
 *
 * Reutiliza `stableStringify` de `services/audit.ts` — el mismo canonicalizador con el que se firma
 * la cadena de auditoría — en vez de escribir un segundo: dos canonicalizadores que deben coincidir
 * son dos canonicalizadores que van a divergir. Ordena claves recursivamente, así que un cambio en el
 * ORDEN de las columnas del Excel no se lee como un cambio de dato.
 *
 * `id` QUEDA FUERA, y es la diferencia entre que esto funcione y que no. `validateManifest` le asigna
 * a cada fila un `randomUUID()` nuevo EN CADA PARSE: identifica la lectura, no la línea del
 * documento. Si participara del hash, dos parses del MISMO archivo darían huellas distintas, la
 * compuerta de no-op no se dispararía nunca y toda línea saldría como "modificada" — exactamente el
 * fallo que la huella existe para evitar, sólo que un nivel más arriba de donde se lo esperaba (el
 * cifrado con IV aleatorio). La identidad durable de la línea es `idempotency_key`, que es con lo que
 * se empareja el diff; el `id` sólo llega hasta la fila de `shipments`.
 */
export function filaHash(shipment: Shipment): string {
  const { id: _idDeParse, ...documento } = shipment;
  return createHash('sha256').update(stableStringify(documento)).digest('hex');
}

/**
 * sha256 del DOCUMENTO como conjunto de líneas: `idempotency_key:row_hash`, ordenado.
 *
 * Ordenado y no en orden de archivo a propósito. Reordenar las filas de un Excel no cambia el
 * embarque, y si la huella dependiera del orden, un cliente que ordena por peso antes de reenviar
 * produciría una versión "nueva" idéntica en contenido. Es esta huella la que hace idempotente la
 * reentrega de un webhook.
 */
export function conjuntoLineasHash(lineas: Array<{ idempotencyKey: string; rowHash: string }>): string {
  const canon = lineas
    .map((l) => `${l.idempotencyKey}:${l.rowHash}`)
    .sort()
    .join('\n');
  return createHash('sha256').update(canon).digest('hex');
}

export interface StageVersionInput {
  manifestId: string;
  /** El parse del documento nuevo, EN CLARO. Se cifra aquí, una sola vez, al escribir bronce. */
  parsed: { rows: StagingRow[]; counts: CountsVersion; headerRow: string[] };
  origen: OrigenVersion;
  /** Obligatorio desde la v2 por CHECK en la base; la ruta lo exige antes de llegar aquí. */
  motivo: string | null;
  sourceFileId: string | null;
  fileContentHash: string | null;
  userId: string | null;
  ip?: string | null;
}

export type StageVersionResult =
  /** La huella coincide con la de la versión vigente: no se crea versión. Idempotencia de webhook. */
  | { status: 'sin_cambios'; version: number; lineSetHash: string }
  | {
      status: 'staged';
      versionId: string;
      version: number;
      versionAnterior: number | null;
      counts: CountsVersion;
      diff: DiffVersion;
      lineSetHash: string;
    }
  /** Hay un pedimento `cargado`. La versión QUEDA REGISTRADA como rechazada; el caller devuelve 409. */
  | {
      status: 'rechazada';
      versionId: string;
      version: number;
      motivoRechazo: 'pedimento_cargado';
      pedimentosCargados: string[];
    };

/** El caso al que pertenece un manifiesto, cuando lo hay. Una carga manual no tiene ninguno. */
async function operacionDe(
  q: QueryFn,
  manifestId: string,
): Promise<{ id: string; mawb: string; client_id: string | null } | null> {
  const { rows } = await q(
    'SELECT id, mawb, client_id FROM operaciones WHERE manifest_id = $1 LIMIT 1',
    [manifestId],
  );
  return rows[0] ?? null;
}

/**
 * Escribe un evento en el ledger SÓLO si el manifiesto tiene caso.
 *
 * Un manifiesto de carga manual no tiene `operaciones`, y `operacion_eventos.operacion_mawb` es
 * NOT NULL: el evento necesita un caso y el ledger no debe llenarse de filas huérfanas. En ese
 * escenario la auditoría —que sí se escribe siempre— es el registro. Devuelve si escribió, para que
 * el caller no afirme en la respuesta algo que no pasó.
 */
async function registrarEvento(
  q: QueryFn,
  manifestId: string,
  tipo: 'MANIFIESTO_VERSIONADO' | 'MANIFIESTO_VERSION_RECHAZADA',
  origen: OrigenVersion,
  payload: Record<string, unknown>,
): Promise<boolean> {
  const op = await operacionDe(q, manifestId);
  if (!op) return false;
  await q(
    `INSERT INTO operacion_eventos
       (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload)
     VALUES ($1,$2,$3,$4,now(),$5)`,
    [
      op.id,
      op.mawb,
      tipo,
      // Quién produjo el hecho: el robot de la prealerta es el `cliente`, la carga manual la hace
      // alguien de casa. `sistema` sería falso en ambos casos — nadie automático decidió esto.
      origen === 'prealerta' ? 'cliente' : 'coordinador',
      JSON.stringify(payload),
    ],
  );
  return true;
}

/** Los pedimentos ya finalizados de este manifiesto. Vacío = la compuerta de bloqueo no muerde. */
async function pedimentosCargados(q: QueryFn, manifestId: string): Promise<string[]> {
  const { rows } = await q(
    `SELECT id FROM pedimentos WHERE manifest_id = $1 AND sub_status = 'cargado' ORDER BY id`,
    [manifestId],
  );
  return rows.map((r: { id: string }) => r.id);
}

/**
 * Deja constancia del rechazo: fila `rechazada`, evento y auditoría.
 *
 * ESTO NO ES UN EARLY-RETURN, y ahí está el punto. Cuando hay un pedimento `cargado` el documento del
 * cliente NO se descarta en la puerta: se inserta la versión con `estado='rechazada'` y
 * `motivo_rechazo`, con su archivo y su hash, y sólo DESPUÉS responde 409 quien llamó. Es el espejo
 * exacto de `prealertas.estado='rechazada'` + `motivo_rechazo`. Descartarlo dejaría al cliente
 * diciendo "yo lo mandé" y al sistema sin nada que enseñar seis semanas después.
 */
async function registrarRechazo(
  q: QueryFn,
  input: {
    manifestId: string;
    version: number;
    origen: OrigenVersion;
    motivo: string | null;
    sourceFileId: string | null;
    fileContentHash: string | null;
    headerRow: string[] | null;
    lineSetHash: string | null;
    counts: CountsVersion;
    userId: string | null;
    cargados: string[];
  },
): Promise<string> {
  const ins = await q(
    `INSERT INTO manifiesto_versiones
       (manifest_id, version, estado, origen, motivo, motivo_rechazo, source_file_id,
        file_content_hash, source_header, line_set_hash, counts, created_by)
     VALUES ($1,$2,'rechazada',$3,$4,'pedimento_cargado',$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [
      input.manifestId,
      input.version,
      input.origen,
      input.motivo,
      input.sourceFileId,
      input.fileContentHash,
      input.headerRow ? JSON.stringify(input.headerRow) : null,
      input.lineSetHash,
      JSON.stringify(input.counts),
      input.userId,
    ],
  );
  return ins.rows[0].id as string;
}

/**
 * Paso 1 — parsear, escribir bronce v(n) y calcular el diff. NO toca el oro.
 *
 * `tx` permite correr dentro de la transacción de quien llama (misma convención que
 * `services/holdActivo.ts`, y por la misma razón: la ruta de carga acaba de insertar la fila
 * `manifests` y leerla desde fuera de su transacción vería un mundo donde todavía no existe).
 */
export async function stageVersion(
  input: StageVersionInput,
  tx?: QueryFn,
): Promise<StageVersionResult> {
  const correr = async (q: QueryFn): Promise<StageVersionResult> => {
    // FOR UPDATE: dos reenvíos simultáneos del mismo MAWB serializan aquí, y no en el índice único
    // de `manifiesto_versiones` — donde el perdedor sería un 500 en vez de una segunda versión.
    const man = await q(
      'SELECT id, version_vigente FROM manifests WHERE id = $1 FOR UPDATE',
      [input.manifestId],
    );
    if (!man.rows.length) throw new Error(`manifiesto ${input.manifestId} no existe`);

    // Huella del documento nuevo. Se calcula EN CLARO y antes de cifrar; ver el comentario del módulo.
    const lineas = input.parsed.rows.map((r) => ({
      idempotencyKey: r.idempotencyKey,
      rowHash: filaHash(r.shipment),
    }));
    const lineSetHash = conjuntoLineasHash(lineas);

    // La última versión APLICADA es la base del diff y de la compuerta de no-op. Una `staged` que
    // nadie promovió no describe lo que hay en el oro, así que compararse contra ella mentiría.
    const vig = await q(
      `SELECT version, line_set_hash FROM manifiesto_versiones
        WHERE manifest_id = $1 AND estado = 'aplicada'
        ORDER BY version DESC LIMIT 1`,
      [input.manifestId],
    );
    const vigente = (vig.rows[0] ?? null) as { version: number; line_set_hash: string | null } | null;

    // COMPUERTA DE NO-OP. NULL no es "distinto": es DESCONOCIDO. Las v1 retro-llenadas por la
    // migración no tienen huella (calcularla habría exigido descifrar PII), así que ahí siempre se
    // crea versión. Falla del lado seguro: de más, nunca de menos.
    if (vigente && vigente.line_set_hash !== null && vigente.line_set_hash === lineSetHash) {
      return { status: 'sin_cambios', version: vigente.version, lineSetHash };
    }

    const maxv = await q(
      'SELECT COALESCE(MAX(version), 0) + 1 AS next FROM manifiesto_versiones WHERE manifest_id = $1',
      [input.manifestId],
    );
    const version = Number(maxv.rows[0].next);

    // COMPUERTA DE BLOQUEO. Antes de escribir bronce, porque un manifiesto con pedimento cargado no
    // debe ganar filas de staging que nunca se van a promover.
    const cargados = await pedimentosCargados(q, input.manifestId);
    if (cargados.length) {
      const versionId = await registrarRechazo(q, {
        manifestId: input.manifestId,
        version,
        origen: input.origen,
        motivo: input.motivo,
        sourceFileId: input.sourceFileId,
        fileContentHash: input.fileContentHash,
        headerRow: input.parsed.headerRow,
        lineSetHash,
        counts: input.parsed.counts,
        userId: input.userId,
        cargados,
      });
      return {
        status: 'rechazada',
        versionId,
        version,
        motivoRechazo: 'pedimento_cargado',
        pedimentosCargados: cargados,
      };
    }

    // Diff contra la vigente. Sólo claves y conteos — el diff es una vista derivable de dos versiones
    // retenidas, no una afirmación aparte, y nunca lleva PII.
    const previas = vigente
      ? await q(
          'SELECT idempotency_key, row_hash FROM manifest_staging_rows WHERE manifest_id = $1 AND version = $2',
          [input.manifestId, vigente.version],
        )
      : { rows: [] as Array<{ idempotency_key: string; row_hash: string | null }> };
    const antes = new Map<string, string | null>(
      (previas.rows as Array<{ idempotency_key: string; row_hash: string | null }>).map((r) => [
        r.idempotency_key,
        r.row_hash,
      ]),
    );
    const ahora = new Map(lineas.map((l) => [l.idempotencyKey, l.rowHash]));

    const diff: DiffVersion = { altas: [], bajas: [], modificadas: [], sinCambio: 0 };
    for (const [key, hash] of ahora) {
      if (!antes.has(key)) diff.altas.push(key);
      // `row_hash` NULL en la versión previa = no se puede probar que no cambió (v1 retro-llenada).
      // Se cuenta como modificada, que es la lectura conservadora: promete de más, no de menos.
      else if (antes.get(key) === hash) diff.sinCambio++;
      else diff.modificadas.push(key);
    }
    for (const key of antes.keys()) if (!ahora.has(key)) diff.bajas.push(key);
    diff.altas.sort();
    diff.bajas.sort();
    diff.modificadas.sort();

    const ins = await q(
      `INSERT INTO manifiesto_versiones
         (manifest_id, version, estado, origen, motivo, source_file_id, file_content_hash,
          source_header, line_set_hash, counts, diff, created_by)
       VALUES ($1,$2,'staged',$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id`,
      [
        input.manifestId,
        version,
        input.origen,
        input.motivo,
        input.sourceFileId,
        input.fileContentHash,
        JSON.stringify(input.parsed.headerRow),
        lineSetHash,
        JSON.stringify(input.parsed.counts),
        JSON.stringify(diff),
        input.userId,
      ],
    );

    // Bronce v(n). Las filas de las versiones anteriores NO se tocan nunca: son la historia línea a
    // línea, ya cifrada, con sus `errors` y `warnings` — por eso no hizo falta una tabla nueva.
    for (const [i, row] of input.parsed.rows.entries()) {
      await q(
        `INSERT INTO manifest_staging_rows
           (manifest_id, version, row_index, idempotency_key, data, row_hash, status, errors, warnings)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          input.manifestId,
          version,
          row.rowIndex,
          row.idempotencyKey,
          JSON.stringify(encryptShipmentPii(row.shipment)),
          lineas[i].rowHash,
          row.status,
          JSON.stringify(row.errors),
          JSON.stringify(row.warnings),
        ],
      );
    }

    // La cabecera vuelve a `staged`: hay un documento esperando decisión. Es también lo que hace que
    // la compuerta de estado de `promote` deje pasar la sustitución sobre un manifiesto ya promovido.
    await q(`UPDATE manifests SET ingestion_status = 'staged' WHERE id = $1`, [input.manifestId]);

    return {
      status: 'staged',
      versionId: ins.rows[0].id as string,
      version,
      versionAnterior: vigente?.version ?? null,
      counts: input.parsed.counts,
      diff,
      lineSetHash,
    };
  };

  const res = tx ? await correr(tx) : await withTransaction(correr);

  // Fuera de la transacción: `recordAudit` abre la suya con lock consultivo para la cadena de hashes.
  if (res.status === 'rechazada') {
    await registrarEvento(query, input.manifestId, 'MANIFIESTO_VERSION_RECHAZADA', input.origen, {
      manifestId: input.manifestId,
      version: res.version,
      motivoRechazo: res.motivoRechazo,
      pedimentosCargados: res.pedimentosCargados,
    });
    await recordAudit({
      userId: input.userId,
      action: 'MANIFIESTO_VERSION_RECHAZADA',
      entity: 'manifest',
      entityId: input.manifestId,
      after: {
        version: res.version,
        origen: input.origen,
        motivoRechazo: res.motivoRechazo,
        pedimentosCargados: res.pedimentosCargados,
        fileContentHash: input.fileContentHash,
        counts: input.parsed.counts,
      },
      ip: input.ip ?? null,
    });
  }
  return res;
}

export interface AplicarVersionInput {
  manifestId: string;
  /** Por defecto, la versión `staged` más alta. */
  version?: number;
  userId: string | null;
  ip?: string | null;
  /**
   * Volver a calificar el riesgo aquí mismo. Por defecto sólo desde la v2: aplicar una SUSTITUCIÓN
   * invalida un análisis que ya existe y que alguien tiene en pantalla, mientras que la primera
   * promoción no tiene nada que invalidar y el siguiente paso de la UI es el botón "Analizar".
   * La vía prealerta pasa `false` explícito porque corre el riesgo ella misma inmediatamente después
   * y es la dueña del evento `RIESGO_EVALUADO` y de su espejo en AGORA; correrlo dos veces sobre un
   * manifiesto de 20 000 líneas sería pagar el doble por el mismo número.
   */
  correrRiesgo?: boolean;
}

export type AplicarVersionResult =
  | {
      status: 'aplicada';
      version: number;
      versionAnterior: number | null;
      promovidas: number;
      counts: CountsVersion;
      diff: DiffVersion | null;
      /** Claves de idempotencia efectivamente borradas del oro. */
      bajas: string[];
      /** Guías casa que dejaron de existir en el oro. Sus `operacion_guias` NO se borran (ver abajo). */
      guiasRetiradas: string[];
      /** `null` = no se corrió el riesgo aquí, así que no se pudo evaluar. Nunca se cancelan solos. */
      requerimientosSinHallazgoVigente: string[] | null;
      /** Lo que dijo el motor tras la corrección. `null` = no se corrió el riesgo aquí. */
      summary: RiskSummary | null;
      /**
       * Lo mismo tras las disposiciones humanas que hayan sobrevivido a la corrección. Idéntico a
       * `summary` mientras no exista ninguna disposición; caducan solas cuando el dato cambia.
       */
      summaryEfectivo: RiskSummary | null;
      eventoRegistrado: boolean;
    }
  | {
      status: 'rechazada';
      version: number;
      motivoRechazo: 'pedimento_cargado';
      pedimentosCargados: string[];
    }
  /** No hay ninguna versión `staged` que aplicar — la compuerta de estado que `promote` ya tenía. */
  | { status: 'sin_version_pendiente'; versionVigente: number }
  /** La versión existe pero ninguna de sus filas es promovible. */
  | { status: 'sin_filas'; version: number };

/**
 * Paso 2 — aplicar la versión al oro. El algoritmo del §2, en un solo lugar, llamado por la ruta y
 * por `manifiestoIngest.ts` (que así queda arreglado por construcción y no por disciplina).
 */
export async function aplicarVersion(input: AplicarVersionInput): Promise<AplicarVersionResult> {
  const aplicada = await withTransaction(async (q) => {
    const man = await q(
      `SELECT id, version_vigente FROM manifests WHERE id = $1 FOR UPDATE`,
      [input.manifestId],
    );
    if (!man.rows.length) throw new Error(`manifiesto ${input.manifestId} no existe`);
    const versionVigente = Number(man.rows[0].version_vigente);

    const objetivo = await q(
      `SELECT id, version, origen, motivo, counts, diff, source_file_id, file_content_hash,
              source_header, line_set_hash
         FROM manifiesto_versiones
        WHERE manifest_id = $1 AND estado = 'staged'
          AND ($2::int IS NULL OR version = $2)
        ORDER BY version DESC LIMIT 1`,
      [input.manifestId, input.version ?? null],
    );
    if (!objetivo.rows.length) {
      return { status: 'sin_version_pendiente' as const, versionVigente };
    }
    const v = objetivo.rows[0] as {
      id: string;
      version: number;
      origen: OrigenVersion;
      motivo: string | null;
      counts: CountsVersion;
      diff: DiffVersion | null;
      source_file_id: string | null;
      file_content_hash: string | null;
      source_header: unknown;
      line_set_hash: string | null;
    };

    // Compuerta de bloqueo, otra vez. No es redundante: entre el staging y la promoción alguien pudo
    // cargar el pedimento, y esa carrera es exactamente la que hace irreversible la decisión.
    const cargados = await pedimentosCargados(q, input.manifestId);
    if (cargados.length) {
      await q(
        `UPDATE manifiesto_versiones
            SET estado = 'rechazada', motivo_rechazo = 'pedimento_cargado'
          WHERE id = $1`,
        [v.id],
      );
      return {
        status: 'rechazada' as const,
        version: v.version,
        motivoRechazo: 'pedimento_cargado' as const,
        pedimentosCargados: cargados,
      };
    }

    const staged = await q(
      `SELECT idempotency_key, data FROM manifest_staging_rows
        WHERE manifest_id = $1 AND version = $2 AND status IN ('valid','warning')
        ORDER BY row_index`,
      [input.manifestId, v.version],
    );
    if (!staged.rows.length) return { status: 'sin_filas' as const, version: v.version };

    // La versión APLICADA anterior, para el acarreo de `risk_*_anterior`. NULL cuando ésta es la
    // primera: acarrear un "anterior" que no existió sería inventar historia.
    const prev = await q(
      `SELECT version FROM manifiesto_versiones
        WHERE manifest_id = $1 AND estado = 'aplicada' ORDER BY version DESC LIMIT 1`,
      [input.manifestId],
    );
    const versionAnterior: number | null = prev.rows.length ? Number(prev.rows[0].version) : null;

    /**
     * UPSERT DE ORO CON ANULACIÓN COMPLETA DEL MOTOR.
     *
     * El upsert anterior anulaba `risk_score`, `risk_color` y `risk_incidences` y OLVIDABA
     * `risk_reasons` y `ruleset_hash`. El resultado era una fila cuyo color estaba en blanco pero
     * cuyas RAZONES seguían describiendo datos que ya no existían — la peor forma de dato viejo,
     * porque parece fresco. Se anulan las cinco.
     *
     * Y en el mismo `DO UPDATE`, sin lectura extra, se acarrea el color anterior: aquí
     * `shipments.risk_color` es todavía la fila vieja y `EXCLUDED` la nueva. Es la única ventana en
     * la que ese dato existe; después de este statement ya no.
     */
    for (const r of staged.rows as Array<{ idempotency_key: string; data: unknown }>) {
      await q(
        `INSERT INTO shipments (id, manifest_id, data, idempotency_key)
         VALUES (gen_random_uuid(), $1, $2, $3)
         ON CONFLICT (manifest_id, idempotency_key) DO UPDATE SET
           data                  = EXCLUDED.data,
           risk_color_anterior   = shipments.risk_color,
           risk_score_anterior   = shipments.risk_score,
           risk_version_anterior = $4,
           risk_score            = NULL,
           risk_color            = NULL,
           risk_incidences       = NULL,
           risk_reasons          = NULL,
           ruleset_hash          = NULL`,
        [input.manifestId, JSON.stringify(r.data), r.idempotency_key, versionAnterior],
      );
    }

    /**
     * BAJAS — borrado duro, y sólo de `shipments`.
     *
     * El conjunto que SOBREVIVE son todas las claves que el documento nuevo trae, promovibles o no.
     * Una línea que llegó con error no está "retirada": el cliente la sigue declarando y no supimos
     * leerla, así que conserva su fila vieja (rancia, visible) en vez de desaparecer. Sólo se borra
     * lo que el documento nuevo ya no menciona.
     *
     * Precedente de casa para el borrado duro: eliminar un pedimento es borrado duro + snapshot en
     * `audit_log`. Aquí ni siquiera perdemos el dato — la versión anterior lo conserva en bronce.
     *
     * `idempotency_key` es nullable, y `NULL <> ALL(...)` es NULL, no TRUE: las filas legacy sin
     * clave sobreviven en vez de ser barridas por una corrección. Es el comportamiento correcto por
     * accidente del lenguaje, así que queda escrito.
     */
    const todasLasClaves = await q(
      `SELECT DISTINCT idempotency_key FROM manifest_staging_rows
        WHERE manifest_id = $1 AND version = $2`,
      [input.manifestId, v.version],
    );
    const conservar = (todasLasClaves.rows as Array<{ idempotency_key: string }>).map(
      (r) => r.idempotency_key,
    );
    // Se lee DESPUÉS del upsert y ANTES del borrado, a propósito: las guías que la versión nueva
    // trae ya están, así que no pueden salir como "retiradas", y las que va a borrar todavía están.
    const guiasAntes = await q(
      `SELECT DISTINCT data->>'guideId' AS guia FROM shipments WHERE manifest_id = $1`,
      [input.manifestId],
    );
    const borradas = await q(
      `DELETE FROM shipments
        WHERE manifest_id = $1 AND idempotency_key <> ALL($2::text[])
        RETURNING idempotency_key`,
      [input.manifestId, conservar],
    );
    const guiasDespues = await q(
      `SELECT DISTINCT data->>'guideId' AS guia FROM shipments WHERE manifest_id = $1`,
      [input.manifestId],
    );

    /**
     * GUÍAS RETIRADAS — se REPORTAN, no se borran.
     *
     * Una `operacion_guias` puede estar `retenida` o cubierta por un pedimento ya capturado. Borrarla
     * porque una corrección dejó de mencionarla destruiría una retención vigente y dejaría al
     * pedimento apuntando al vacío. Va al payload del evento y a la respuesta; qué hacer con ella es
     * una decisión humana, y hay pantalla para tomarla.
     */
    const norm = (rows: Array<{ guia: string | null }>) =>
      new Set(rows.map((r) => normGuia(r.guia ?? '')).filter(Boolean));
    const antesG = norm(guiasAntes.rows);
    const despuesG = norm(guiasDespues.rows);
    const guiasRetiradas = [...antesG].filter((g) => !despuesG.has(g)).sort();

    await q(
      `UPDATE manifest_staging_rows SET promoted_at = now()
        WHERE manifest_id = $1 AND version = $2 AND status IN ('valid','warning')`,
      [input.manifestId, v.version],
    );
    // La cabecera pasa a describir el DOCUMENTO VIGENTE. Que esto no ocurriera es el otro defecto de
    // la rama de attach: `file_content_hash` y `source_file_id` seguían describiendo el primer envío.
    await q(
      `UPDATE manifests
          SET version_vigente     = $2,
              ingestion_status    = 'promoted',
              risk_stale          = true,
              source_file_id      = COALESCE($3, source_file_id),
              file_content_hash   = COALESCE($4, file_content_hash),
              source_header       = COALESCE($5::jsonb, source_header)
        WHERE id = $1`,
      [
        input.manifestId,
        v.version,
        v.source_file_id,
        v.file_content_hash,
        v.source_header ? JSON.stringify(v.source_header) : null,
      ],
    );
    await q(
      `UPDATE manifiesto_versiones SET estado = 'aplicada', aplicada_at = now() WHERE id = $1`,
      [v.id],
    );

    return {
      status: 'aplicada' as const,
      version: v.version,
      versionAnterior,
      origen: v.origen,
      motivo: v.motivo,
      counts: (v.counts ?? { total: 0, valid: 0, warning: 0, error: 0 }) as CountsVersion,
      diff: v.diff,
      lineSetHash: v.line_set_hash,
      promovidas: staged.rows.length,
      bajas: (borradas.rows as Array<{ idempotency_key: string }>).map((r) => r.idempotency_key),
      guiasRetiradas,
      versionVigenteAnterior: versionVigente,
    };
  });

  if (aplicada.status !== 'aplicada') {
    if (aplicada.status === 'rechazada') {
      // Mismo trato que en el staging: el rechazo va al expediente antes de que nadie vea un 409.
      const origen = await query<{ origen: OrigenVersion }>(
        'SELECT origen FROM manifiesto_versiones WHERE manifest_id = $1 AND version = $2',
        [input.manifestId, aplicada.version],
      );
      await registrarEvento(
        query,
        input.manifestId,
        'MANIFIESTO_VERSION_RECHAZADA',
        origen.rows[0]?.origen ?? 'carga_manual',
        {
          manifestId: input.manifestId,
          version: aplicada.version,
          motivoRechazo: aplicada.motivoRechazo,
          pedimentosCargados: aplicada.pedimentosCargados,
        },
      );
      await recordAudit({
        userId: input.userId,
        action: 'MANIFIESTO_VERSION_RECHAZADA',
        entity: 'manifest',
        entityId: input.manifestId,
        after: {
          version: aplicada.version,
          motivoRechazo: aplicada.motivoRechazo,
          pedimentosCargados: aplicada.pedimentosCargados,
        },
        ip: input.ip ?? null,
      });
    }
    return aplicada;
  }

  // ---- Fuera de la transacción -----------------------------------------------------------------
  const correrRiesgo = input.correrRiesgo ?? aplicada.version >= 2;
  let summary: RiskSummary | null = null;
  let summaryEfectivo: RiskSummary | null = null;
  if (correrRiesgo) {
    const risk = await runRiskForManifest({ manifestId: input.manifestId, userId: input.userId });
    summary = risk?.summary ?? null;
    summaryEfectivo = risk?.summaryEfectivo ?? null;
  }

  /**
   * REQUERIMIENTOS ABIERTOS QUE SE QUEDARON SIN HALLAZGO. Se LISTAN, jamás se cancelan solos:
   * cancelar es un acto humano con motivo y ya existe el endpoint (`routes/riesgoRequerimientos.ts`),
   * que además avisa al cliente. Un barrido que cerrara obligaciones en silencio es exactamente la
   * clase de automatismo que deja a alguien sin saber que ya no le exigen nada.
   *
   * Sólo se evalúa cuando el riesgo se recalculó AQUÍ: si no, las razones acaban de quedar en NULL
   * por el upsert y TODO requerimiento parecería sin sustento. `null` significa "no evaluado", que es
   * la respuesta honesta; una lista vacía afirmaría algo que no se comprobó.
   */
  let requerimientosSinHallazgoVigente: string[] | null = null;
  if (correrRiesgo) {
    const op = await operacionDe(query, input.manifestId);
    if (op) {
      const { rows } = await query<{
        id: string;
        reason_codes: Array<{ signalId?: string }> | null;
        risk_reasons: Array<{ signalId?: string }> | null;
      }>(
        `SELECT r.id, r.reason_codes, s.risk_reasons
           FROM riesgo_requerimientos r
           LEFT JOIN shipments s ON s.id = r.shipment_id
          WHERE r.operacion_id = $1 AND r.estado = 'abierto'`,
        [op.id],
      );
      requerimientosSinHallazgoVigente = rows
        .filter((r) => {
          const citados = new Set((r.reason_codes ?? []).map((c) => c.signalId));
          const vigentes = new Set((r.risk_reasons ?? []).map((c) => c.signalId));
          return ![...citados].some((s) => vigentes.has(s));
        })
        .map((r) => r.id);
    }
  }

  const payload = {
    manifestId: input.manifestId,
    version: aplicada.version,
    versionAnterior: aplicada.versionAnterior,
    origen: aplicada.origen,
    motivo: aplicada.motivo,
    counts: aplicada.counts,
    diff: aplicada.diff,
    lineSetHash: aplicada.lineSetHash,
    promovidas: aplicada.promovidas,
    bajas: aplicada.bajas,
    guiasRetiradas: aplicada.guiasRetiradas,
    requerimientosSinHallazgoVigente,
  };
  const eventoRegistrado = await registrarEvento(
    query,
    input.manifestId,
    'MANIFIESTO_VERSIONADO',
    aplicada.origen,
    payload,
  );

  /**
   * `before` NO es decoración. La pregunta del auditor no es "qué dice el manifiesto" —eso está en la
   * fila— sino "qué decía antes y por qué cambió". Sin el before, la cadena de hashes prueba que
   * nadie tocó el registro y no prueba nada sobre el cambio. Se auditan claves y hashes; nunca
   * valores de PII: el diff es derivable de dos versiones retenidas, no una afirmación aparte.
   */
  await recordAudit({
    userId: input.userId,
    action: 'MANIFIESTO_VERSIONADO',
    entity: 'manifest',
    entityId: input.manifestId,
    before: {
      version: aplicada.versionAnterior,
      versionVigente: aplicada.versionVigenteAnterior,
      lineSetHash: await lineSetHashDe(input.manifestId, aplicada.versionAnterior),
      counts: await countsDe(input.manifestId, aplicada.versionAnterior),
    },
    after: { ...payload, summary, summaryEfectivo },
    ip: input.ip ?? null,
  });

  return {
    status: 'aplicada',
    version: aplicada.version,
    versionAnterior: aplicada.versionAnterior,
    promovidas: aplicada.promovidas,
    counts: aplicada.counts,
    diff: aplicada.diff,
    bajas: aplicada.bajas,
    guiasRetiradas: aplicada.guiasRetiradas,
    requerimientosSinHallazgoVigente,
    summary,
    summaryEfectivo,
    eventoRegistrado,
  };
}

/** El `before` de la auditoría, leído de la versión anterior. NULL cuando no había ninguna. */
async function lineSetHashDe(manifestId: string, version: number | null): Promise<string | null> {
  if (version === null) return null;
  const { rows } = await query<{ line_set_hash: string | null }>(
    'SELECT line_set_hash FROM manifiesto_versiones WHERE manifest_id = $1 AND version = $2',
    [manifestId, version],
  );
  return rows[0]?.line_set_hash ?? null;
}

async function countsDe(manifestId: string, version: number | null): Promise<unknown> {
  if (version === null) return null;
  const { rows } = await query<{ counts: unknown }>(
    'SELECT counts FROM manifiesto_versiones WHERE manifest_id = $1 AND version = $2',
    [manifestId, version],
  );
  return rows[0]?.counts ?? null;
}

/** La versión `staged` pendiente, si la hay. La usan las compuertas interactivas de la ruta. */
export async function versionPendiente(
  manifestId: string,
): Promise<{ id: string; version: number } | null> {
  const { rows } = await query<{ id: string; version: number }>(
    `SELECT id, version FROM manifiesto_versiones
      WHERE manifest_id = $1 AND estado = 'staged'
      ORDER BY version DESC LIMIT 1`,
    [manifestId],
  );
  return rows[0] ?? null;
}
