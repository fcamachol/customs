#!/usr/bin/env tsx
/**
 * recoverEvidence.ts — RECUPERACIÓN VERIFICABLE DE EVIDENCIA PERDIDA (backlog #39).
 *
 * POR QUÉ EXISTE
 * --------------
 * `FILE_STORAGE_DIR=/app/storage` no tenía volumen persistente en producción: cada redespliegue
 * borraba los BYTES de la evidencia mientras las filas de `files` y sus sha256 sobrevivían (probado
 * A/B el 2026-08-07). El volumen es la cura; esto es la limpieza. Los adjuntos de prealerta —el AWB
 * y el manifiesto, que son la evidencia que alimenta el cotejo y el motor de riesgo— siguen estando
 * en AGORA mientras AGORA no los incinere (30 días para el correo entrante), así que se pueden
 * volver a bajar.
 *
 * LA REGLA QUE MANDA: NADA SE RESTAURA SIN COINCIDIR CON EL HASH GUARDADO. El `content_hash` de la
 * fila se calculó sobre los bytes originales en el momento del archivado, así que es la única prueba
 * de que lo que AGORA nos devuelve hoy es lo mismo que recibimos entonces. Si el sha256 recalculado
 * no coincide, el archivo NO se escribe: se reporta como `hash_no_coincide` con ambos hashes y se
 * deja para revisión humana. Restaurar bytes distintos bajo el hash de otros sería falsificar
 * evidencia — exactamente lo que este sistema existe para hacer imposible.
 *
 * QUÉ SE PUEDE Y QUÉ NO
 * ---------------------
 *   - Adjuntos de prealerta (`prealerta_adjuntos` → conversación de AGORA): RECUPERABLES.
 *   - Fotos de campo, PDFs de pedimento, reportes/artefactos generados: NO tienen origen externo;
 *     se reportan como `sin_origen_agora`. Los reportes se regeneran desde sus propias rutas; las
 *     fotos de campo se perdieron y el reporte lo dice en voz alta en vez de callarlo.
 *   - El archivo `.json` del correo (`kind='prealerta_email'`) tampoco es recuperable por hash: se
 *     construye con `archivedAt` (marca de tiempo del archivado), así que volver a generarlo daría
 *     otros bytes y otro hash. Se reporta, no se inventa.
 *
 * USO
 * ---
 *   npm --prefix server run recover:evidence              # DRY-RUN: sólo diagnostica, no escribe
 *   npm --prefix server run recover:evidence -- --apply   # restaura lo que verifica contra su hash
 *
 * FLAGS
 *   --apply           Escribe de verdad los blobs verificados en `files.storage_path`, registra
 *                     EVIDENCIA_RESTAURADA en la bitácora y en la cadena de auditoría. SIN esta
 *                     bandera el script no toca ni disco ni base: descarga, verifica y reporta.
 *   --limit=N         Procesa a lo más N archivos faltantes (default: todos). Útil para un primer
 *                     lote de prueba contra producción.
 *   --file=<uuid>     Sólo ese `files.id`. Repetible.
 *   --json            Emite el reporte como JSON en vez de tabla (para adjuntarlo a un incidente).
 *   --help            Esto.
 *
 * ENTORNO
 *   DATABASE_URL                base de datos (se lee de `server/.env` vía dotenv, igual que el server)
 *   AGORA_BASE_URL / AGORA_ACCOUNT_ID / AGORA_API_ACCESS_TOKEN
 *                               credenciales de AGORA; sin ellas el script diagnostica pero no puede
 *                               recuperar nada.
 *   FILE_STORAGE_DIR            no lo usa directamente: restaura sobre la ruta EXACTA que la fila ya
 *                               tiene guardada, para que los enlaces existentes sigan sirviendo.
 *
 * CÓDIGO DE SALIDA
 *   0  todo lo faltante quedó explicado y nada falló la verificación
 *   1  hubo hashes que no coinciden, o errores de descarga/escritura — algo necesita ojos humanos
 */

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pool, query } from '../src/db/pool';
import { recordAudit } from '../src/services/audit';
import { downloadAttachment, loadAgoraConfig, type AgoraConfig } from '../src/services/agoraClient';
import { listConversationMessages } from '../src/services/agoraSweep';
import { fileNameFor } from '../src/services/prealertaIngest';

// ── Banderas ─────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const JSON_OUT = args.includes('--json');
const limitArg = args.find((a) => a.startsWith('--limit='));
const LIMIT = limitArg ? Math.max(1, parseInt(limitArg.split('=')[1], 10)) : Infinity;
const SOLO_IDS = args.filter((a) => a.startsWith('--file=')).map((a) => a.split('=')[1]).filter(Boolean);

if (args.includes('--help') || args.includes('-h')) {
  console.log(
    [
      'recoverEvidence.ts — recuperación verificable de evidencia perdida (#39)',
      '',
      '  npm --prefix server run recover:evidence                # dry-run',
      '  npm --prefix server run recover:evidence -- --apply     # restaura lo verificado',
      '',
      '  --apply        escribe los blobs que coinciden con su hash y los registra en la bitácora',
      '  --limit=N      procesa a lo más N archivos faltantes',
      '  --file=<uuid>  sólo ese files.id (repetible)',
      '  --json         reporte en JSON',
    ].join('\n'),
  );
  process.exit(0);
}

// ── Tipos del reporte ────────────────────────────────────────────────────────

type Estado =
  /** El blob está en disco; no hay nada que recuperar. */
  | 'presente'
  /** Bajado de AGORA, sha256 verificado y escrito en su ruta (sólo con --apply). */
  | 'restaurado'
  /** Bajado de AGORA y verificado, listo para restaurar: falta correr con --apply. */
  | 'recuperable'
  /** Bajado de AGORA pero el sha256 NO coincide con el guardado. Nunca se escribe. */
  | 'hash_no_coincide'
  /** La fila no viene de un adjunto de AGORA (foto de campo, PDF subido, reporte generado). */
  | 'sin_origen_agora'
  /** Viene de AGORA pero el adjunto ya no está ahí (incineración a 30 días, o borrado). */
  | 'no_esta_en_agora'
  /** La fila nunca guardó un content_hash: no hay contra qué verificar, así que no se restaura. */
  | 'sin_hash_registrado'
  /** Quedó fuera del lote por `--limit`; sigue faltando. */
  | 'omitido'
  /** Falló la descarga, la lectura o la escritura. */
  | 'error';

interface Renglon {
  fileId: string;
  kind: string;
  originalName: string;
  storagePath: string;
  contentHash: string | null;
  mawb: string | null;
  operacionId: string | null;
  conversationId: string | null;
  estado: Estado;
  detalle?: string;
  hashObtenido?: string;
}

interface FilaArchivo {
  fileId: string;
  kind: string;
  originalName: string;
  storagePath: string;
  contentHash: string | null;
  adjuntoTipo: string | null;
  conversationId: string | null;
  agoraMessageId: string | null;
  operacionId: string | null;
  mawb: string | null;
}

// ── Lectura del catálogo de archivos ─────────────────────────────────────────

/**
 * Todos los `files` con la procedencia que permite recuperarlos. LEFT JOIN a propósito: un archivo
 * sin adjunto de prealerta también tiene que salir en el reporte — que no sea recuperable no lo hace
 * invisible.
 */
async function leerArchivos(): Promise<FilaArchivo[]> {
  const { rows } = await query<FilaArchivo>(
    `SELECT f.id                    AS "fileId",
            f.kind                  AS "kind",
            f.original_name         AS "originalName",
            f.storage_path          AS "storagePath",
            f.content_hash          AS "contentHash",
            pa.tipo                 AS "adjuntoTipo",
            p.agora_conversation_id AS "conversationId",
            p.agora_message_id      AS "agoraMessageId",
            o.id                    AS "operacionId",
            o.mawb                  AS "mawb"
       FROM files f
       LEFT JOIN prealerta_adjuntos pa ON pa.file_id = f.id
       LEFT JOIN prealertas p          ON p.id = pa.prealerta_id
       LEFT JOIN operaciones o         ON o.id = p.operacion_id
      ${SOLO_IDS.length ? 'WHERE f.id = ANY($1::uuid[])' : ''}
      ORDER BY f.created_at ASC`,
    SOLO_IDS.length ? [SOLO_IDS] : undefined,
  );
  return rows;
}

async function existeEnDisco(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw err;
  }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

// ── AGORA ────────────────────────────────────────────────────────────────────

interface AdjuntoAgora { data_url?: string; extension?: string; id?: number }

/** Los mensajes de un hilo, cacheados: varias filas suelen venir de la misma conversación. */
const cacheMensajes = new Map<string, Awaited<ReturnType<typeof listConversationMessages>>>();

async function mensajesDe(cfg: AgoraConfig, conversationId: string) {
  const cacheado = cacheMensajes.get(conversationId);
  if (cacheado) return cacheado;
  const mensajes = await listConversationMessages(cfg, conversationId);
  cacheMensajes.set(conversationId, mensajes);
  return mensajes;
}

/**
 * Los adjuntos del hilo que se llaman como el archivo archivado, con los del MENSAJE que la prealerta
 * registró (`agora_message_id`) al frente. El nombre sólo sirve para ordenar la búsqueda: un reenvío
 * del robot puede traer el mismo nombre en otro mensaje, así que quien decide es el hash, no el
 * nombre ni el mensaje del que salió.
 */
async function candidatosDeAdjunto(
  cfg: AgoraConfig,
  conversationId: string,
  agoraMessageId: string | null,
  originalName: string,
): Promise<AdjuntoAgora[]> {
  const mensajes = await mensajesDe(cfg, conversationId);
  const delMensaje: AdjuntoAgora[] = [];
  const delHilo: AdjuntoAgora[] = [];
  for (const m of mensajes) {
    const esElRegistrado = agoraMessageId != null && String(m.id ?? '') === agoraMessageId;
    for (const att of m.attachments ?? []) {
      if (!att?.data_url || fileNameFor(att) !== originalName) continue;
      (esElRegistrado ? delMensaje : delHilo).push(att);
    }
  }
  return [...delMensaje, ...delHilo];
}

// ── Restauración ─────────────────────────────────────────────────────────────

/**
 * Escribe el blob verificado en su ruta original y vuelve a leerlo para confirmar que lo que quedó
 * en disco hashea igual. Se escribe primero a un temporal en el MISMO directorio y se renombra: un
 * rename dentro del mismo sistema de archivos es atómico, así que nadie puede leer un archivo a
 * medio escribir bajo la ruta buena.
 */
async function restaurarBlob(storagePath: string, bytes: Buffer, hashEsperado: string): Promise<void> {
  await mkdir(dirname(storagePath), { recursive: true });
  const tmp = `${storagePath}.recuperando`;
  try {
    await writeFile(tmp, bytes);
    await rename(tmp, storagePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    throw err;
  }
  const releido = await readFile(storagePath);
  const hashReleido = sha256(Buffer.from(releido));
  if (hashReleido !== hashEsperado) {
    throw new Error(`el archivo escrito no verifica: esperado ${hashEsperado}, en disco ${hashReleido}`);
  }
}

/**
 * Deja constancia de la restauración donde se ve: la bitácora de la operación (append-only) y la
 * cadena de auditoría. Una recuperación silenciosa dejaría un archivo cuya historia no cuadra —
 * "estos bytes volvieron de AGORA el día X y verifican contra el hash de origen" es exactamente el
 * hecho que un auditor necesita leer.
 */
async function registrarRestauracion(fila: FilaArchivo): Promise<void> {
  if (fila.operacionId && fila.mawb) {
    await query(
      `INSERT INTO operacion_eventos
         (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, evidencia_file_id)
       VALUES ($1,$2,'EVIDENCIA_RESTAURADA','sistema',now(),$3,$4)`,
      [
        fila.operacionId,
        fila.mawb,
        JSON.stringify({
          fileId: fila.fileId,
          kind: fila.kind,
          originalName: fila.originalName,
          contentHash: fila.contentHash,
          origen: 'agora',
          conversationId: fila.conversationId,
        }),
        fila.fileId,
      ],
    );
  }
  await recordAudit({
    userId: null,
    action: 'EVIDENCIA_RESTAURADA',
    entity: 'file',
    entityId: fila.fileId,
    after: {
      kind: fila.kind,
      originalName: fila.originalName,
      contentHash: fila.contentHash,
      storagePath: fila.storagePath,
      origen: 'agora',
      conversationId: fila.conversationId,
      operacionId: fila.operacionId,
      mawb: fila.mawb,
    },
    ip: null,
  });
}

// ── Recorrido ────────────────────────────────────────────────────────────────

function renglonBase(f: FilaArchivo, estado: Estado, detalle?: string): Renglon {
  return {
    fileId: f.fileId,
    kind: f.kind,
    originalName: f.originalName,
    storagePath: f.storagePath,
    contentHash: f.contentHash,
    mawb: f.mawb,
    operacionId: f.operacionId,
    conversationId: f.conversationId,
    estado,
    ...(detalle ? { detalle } : {}),
  };
}

async function procesar(f: FilaArchivo, cfg: AgoraConfig | null): Promise<Renglon> {
  if (!f.conversationId) {
    return renglonBase(
      f,
      'sin_origen_agora',
      f.kind === 'prealerta_email'
        ? 'archivo del correo: se genera con marca de tiempo, no es reproducible byte a byte'
        : 'no proviene de un adjunto de AGORA',
    );
  }
  if (!f.contentHash) {
    return renglonBase(f, 'sin_hash_registrado', 'sin content_hash guardado no hay contra qué verificar');
  }
  if (!cfg) {
    return renglonBase(f, 'error', 'AGORA no configurado (AGORA_BASE_URL / AGORA_ACCOUNT_ID / AGORA_API_ACCESS_TOKEN)');
  }

  let candidatos: AdjuntoAgora[];
  try {
    candidatos = await candidatosDeAdjunto(cfg, f.conversationId, f.agoraMessageId, f.originalName);
  } catch (err) {
    return renglonBase(f, 'error', `no se pudo leer la conversación ${f.conversationId}: ${msg(err)}`);
  }
  if (!candidatos.length) {
    return renglonBase(f, 'no_esta_en_agora', `sin adjunto '${f.originalName}' en la conversación ${f.conversationId}`);
  }

  // Varios candidatos con el mismo nombre: se prueba en orden y gana el primero que verifique. El
  // hash es el juez; el orden sólo evita descargas de más.
  let ultimoHash: string | null = null;
  let ultimoError: string | null = null;
  for (const att of candidatos) {
    let bytes: Buffer;
    try {
      bytes = await downloadAttachment(cfg, att.data_url as string);
    } catch (err) {
      ultimoError = msg(err);
      continue;
    }
    const hash = sha256(bytes);
    ultimoHash = hash;
    if (hash !== f.contentHash) continue;

    if (!APPLY) {
      return { ...renglonBase(f, 'recuperable', 'verificado contra el hash; correr con --apply para restaurar'), hashObtenido: hash };
    }
    try {
      await restaurarBlob(f.storagePath, bytes, f.contentHash);
      await registrarRestauracion(f);
    } catch (err) {
      return { ...renglonBase(f, 'error', `verificado pero no se pudo restaurar: ${msg(err)}`), hashObtenido: hash };
    }
    return { ...renglonBase(f, 'restaurado', 'bytes verificados contra el hash de origen'), hashObtenido: hash };
  }

  if (ultimoHash) {
    return {
      ...renglonBase(
        f,
        'hash_no_coincide',
        `AGORA devolvió bytes distintos a los archivados; NO se restauró. esperado ${f.contentHash}`,
      ),
      hashObtenido: ultimoHash,
    };
  }
  return renglonBase(f, 'error', `no se pudo descargar ningún candidato: ${ultimoError ?? 'sin detalle'}`);
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Reporte ──────────────────────────────────────────────────────────────────

const ORDEN_ESTADOS: Estado[] = [
  'restaurado', 'recuperable', 'hash_no_coincide', 'no_esta_en_agora',
  'sin_origen_agora', 'sin_hash_registrado', 'error', 'omitido', 'presente',
];

function imprimirReporte(renglones: Renglon[], totales: { total: number; presentes: number }): void {
  if (JSON_OUT) {
    console.log(JSON.stringify({ modo: APPLY ? 'apply' : 'dry-run', ...totales, renglones }, null, 2));
    return;
  }

  const faltantes = renglones.filter((r) => r.estado !== 'presente');
  console.log('');
  console.log('═'.repeat(78));
  console.log(`RECUPERACIÓN DE EVIDENCIA (#39) — modo ${APPLY ? 'APPLY (escribe)' : 'DRY-RUN (no escribe nada)'}`);
  console.log('═'.repeat(78));
  console.log(`archivos en la base   ${totales.total}`);
  console.log(`bytes presentes       ${totales.presentes}`);
  console.log(`bytes faltantes       ${faltantes.length}`);
  console.log('');

  for (const estado of ORDEN_ESTADOS) {
    const grupo = faltantes.filter((r) => r.estado === estado);
    if (!grupo.length) continue;
    console.log(`── ${estado} (${grupo.length}) ${'─'.repeat(Math.max(0, 60 - estado.length))}`);
    for (const r of grupo) {
      console.log(`   ${r.kind.padEnd(16)} ${r.originalName}`);
      console.log(`   ${''.padEnd(16)} file ${r.fileId}${r.mawb ? ` · guía ${r.mawb}` : ''}`);
      console.log(`   ${''.padEnd(16)} sha256 ${r.contentHash ?? 'sin hash'}`);
      if (r.hashObtenido && r.hashObtenido !== r.contentHash) {
        console.log(`   ${''.padEnd(16)} obtenido ${r.hashObtenido}`);
      }
      if (r.detalle) console.log(`   ${''.padEnd(16)} ${r.detalle}`);
    }
    console.log('');
  }

  const cuenta = (e: Estado): number => renglones.filter((r) => r.estado === e).length;
  console.log('─'.repeat(78));
  console.log(
    `restaurados ${cuenta('restaurado')} · recuperables ${cuenta('recuperable')} · ` +
      `hash no coincide ${cuenta('hash_no_coincide')} · no están en AGORA ${cuenta('no_esta_en_agora')} · ` +
      `sin origen ${cuenta('sin_origen_agora')} · errores ${cuenta('error')}`,
  );
  if (!APPLY && cuenta('recuperable')) {
    console.log('');
    console.log(`Hay ${cuenta('recuperable')} archivo(s) verificados contra su hash listos para restaurar:`);
    console.log('   npm --prefix server run recover:evidence -- --apply');
  }
  if (cuenta('hash_no_coincide')) {
    console.log('');
    console.log('ATENCIÓN: hay archivos cuyos bytes en AGORA NO coinciden con el hash archivado.');
    console.log('No se restauró ninguno. Eso no es un error del script: es un hecho que hay que');
    console.log('explicar antes de tocar la evidencia.');
  }
  console.log('═'.repeat(78));
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cfg = loadAgoraConfig();
  if (!cfg && !JSON_OUT) {
    console.warn('[recover] AGORA no está configurado: se diagnostica lo que falta, pero no se puede recuperar nada.');
  }

  const archivos = await leerArchivos();
  const renglones: Renglon[] = [];
  let presentes = 0;
  let procesados = 0;

  for (const f of archivos) {
    if (await existeEnDisco(f.storagePath)) {
      presentes++;
      renglones.push(renglonBase(f, 'presente'));
      continue;
    }
    if (procesados >= LIMIT) {
      renglones.push(renglonBase(f, 'omitido', `fuera del lote por --limit=${LIMIT}`));
      continue;
    }
    procesados++;
    renglones.push(await procesar(f, cfg));
  }

  imprimirReporte(renglones, { total: archivos.length, presentes });

  const problemas = renglones.filter((r) => r.estado === 'hash_no_coincide' || r.estado === 'error').length;
  if (problemas) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[recover] FATAL:', err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
