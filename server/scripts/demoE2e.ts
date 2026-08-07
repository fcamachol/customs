import 'dotenv/config';
import { createHmac, randomUUID } from 'node:crypto';

/**
 * EL CASO DE PRUEBA DE CAPACIDADES COMPLETAS — demo end-to-end, auto-verificable.
 *
 * Crea una prealerta REAL en AGORA (contacto → conversación → mensaje entrante con dos adjuntos),
 * deja que el webhook firmado de AGORA la entregue a customs, y desde ahí camina la operación por
 * todas las capacidades del Sistema de Operaciones, aseverando cada paso y terminando con un
 * scorecard numerado. Sale con código 0 sólo si todas las aserciones REQUERIDAS pasaron.
 *
 * POR QUÉ POR AGORA Y NO LLAMANDO AL WEBHOOK A MANO: el atajo probaría el ingest y nada más. La ruta
 * real ejercita la integración completa — AGORA emite el evento, firma el HMAC, y customs vuelve a
 * DESCARGAR los adjuntos desde AGORA con su propio token. Ese viaje de ida y vuelta es la mitad del
 * producto y es exactamente la mitad que un atajo no prueba.
 *
 * TRES CAMINOS DE ENTREGA, y el scorecard dice cuál fue. Los tres son capacidades distintas:
 *
 *   A. WEBHOOK DE AGORA — la vía normal. AGORA firma y entrega `message_created`.
 *   B. BARRIDO DE RECONCILIACIÓN — POST /api/ops/tick. La red que atrapa un webhook perdido.
 *   C. ENTREGA FIRMADA POR EL SCRIPT — plan C, y existe por un LÍMITE REAL DE AGORA, verificado en
 *      producción: la API de aplicación de Chatwoot/AGORA RECHAZA crear mensajes entrantes en un
 *      inbox de correo — `422 {"error":"Incoming messages are only allowed in Api inboxes"}` — y sin
 *      `message_type: 'incoming'` ni el webhook ni el barrido procesan el mensaje (ambos filtran por
 *      entrante, con razón: un saliente es nuestra propia respuesta volviendo). Los únicos caminos
 *      que producen un entrante de verdad en el inbox 21 son un correo real vía IMAP (necesita SMTP,
 *      que no está configurado) o el webhook firmado. Así que este brazo firma el MISMO
 *      `message_created` con AGORA_WEBHOOK_SIGNING_SECRET, apuntando a los `data_url` REALES de los
 *      adjuntos que acabamos de subir a AGORA: customs sigue verificando el HMAC, la frescura, la
 *      idempotencia por event-id, y sigue bajando la evidencia desde AGORA con su propio token. Lo
 *      único que cambia es quién apretó el botón de enviar. Se salta si el secreto no está en el env.
 *
 * USO
 *   npx tsx server/scripts/demoE2e.ts
 *
 * CONFIGURACIÓN (todo por env; NADA de secretos en este archivo)
 *   DEMO_HOST                  URL base de customs (default: la de producción en Coolify)
 *   DEMO_USER / DEMO_PASS      credenciales para POST /api/auth/login (default user: capturista;
 *                              `capturista` alcanza para campo + reparse, y usar el rol MENOS
 *                              privilegiado que puede hacer el recorrido es parte de la prueba)
 *   AGORA_BASE_URL             base de AGORA (Chatwoot fork), p.ej. https://agoracore.…
 *   AGORA_ACCOUNT_ID           id de la cuenta de AGORA
 *   AGORA_API_ACCESS_TOKEN     token de aplicación de AGORA (header `api_access_token`)
 *   AGORA_PREALERTAS_INBOX_ID  inbox de correo vigilado por el webhook
 *   OPS_TICK_TOKEN             secreto de POST /api/ops/tick, para el plan B del barrido
 *   AGORA_WEBHOOK_SIGNING_SECRET  MISMO valor que la variable homónima de customs. Sólo lo usa el
 *                              plan C descrito arriba; sin él ese brazo se omite (y, hoy, el caso no
 *                              llega a existir — ver el bloque de TRES CAMINOS)
 *   DEMO_POLL_TIMEOUT_MS       espera máxima a que aterrice el caso (default 90000)
 *   DEMO_OPERACION_ID          escape hatch: reanuda el recorrido sobre un caso QUE YA EXISTE, sin
 *                              tocar AGORA. Para cuando la creación quedó bloqueada y lo que hay que
 *                              volver a probar es el recorrido de campo, o para re-demostrar un caso
 *                              concreto. Las aserciones del ingest se marcarán según lo que ese caso
 *                              traiga, no según lo que este script habría enviado.
 *
 * QUÉ NO CUBRE (a propósito, y documentado en docs/DEMO_E2E.md): notificaciones salientes R18/R19
 * (bloqueadas por SMTP), despacho/POD, y holds.
 */

// ---------------------------------------------------------------------------
// Configuración
// ---------------------------------------------------------------------------

const HOST = (process.env.DEMO_HOST ?? 'https://skcw8c4gcgs0cgcow8g48o4c.35.222.90.155.sslip.io').replace(/\/+$/, '');
const DEMO_USER = process.env.DEMO_USER ?? 'capturista';
const DEMO_PASS = process.env.DEMO_PASS ?? '';
const AGORA_BASE_URL = (process.env.AGORA_BASE_URL ?? '').replace(/\/+$/, '');
const AGORA_ACCOUNT_ID = process.env.AGORA_ACCOUNT_ID ?? '';
const AGORA_TOKEN = process.env.AGORA_API_ACCESS_TOKEN ?? '';
const AGORA_INBOX_ID = process.env.AGORA_PREALERTAS_INBOX_ID ?? '';
const OPS_TICK_TOKEN = process.env.OPS_TICK_TOKEN ?? '';
const WEBHOOK_SECRET = process.env.AGORA_WEBHOOK_SIGNING_SECRET ?? '';
const POLL_TIMEOUT_MS = Number(process.env.DEMO_POLL_TIMEOUT_MS ?? 90_000);
const OPERACION_EXISTENTE = process.env.DEMO_OPERACION_ID ?? '';
const POLL_INTERVAL_MS = 3_000;

const CONTACTO_EMAIL = 'robot.demo@shein.example';
const CONTACTO_NOMBRE = 'Demo Robot Shein';

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

type Estado = 'ok' | 'fail' | 'skip';

interface Resultado {
  n: number;
  label: string;
  estado: Estado;
  nota: string;
  requerido: boolean;
}

const resultados: Resultado[] = [];
let contador = 0;

/** Lanzado por las aserciones. Distingue "la capacidad falló" de "el script se rompió". */
class Fallo extends Error {}

function expect(cond: unknown, mensaje: string): void {
  if (!cond) throw new Fallo(mensaje);
}

/**
 * Ejecuta una comprobación y la registra. Devuelve true/false en lugar de lanzar, para que el
 * recorrido pueda seguir cuando es seguro y el scorecard salga COMPLETO — un scorecard truncado en
 * la primera falla no dice qué más está roto, que es justo lo que uno necesita saber.
 */
async function check(
  label: string,
  fn: () => Promise<string> | string,
  opts: { requerido?: boolean } = {},
): Promise<boolean> {
  const requerido = opts.requerido ?? true;
  const n = ++contador;
  try {
    const nota = await fn();
    resultados.push({ n, label, estado: 'ok', nota, requerido });
    console.log(`  ✔ ${String(n).padStart(2, '0')}. ${label} — ${nota}`);
    return true;
  } catch (err) {
    const nota = err instanceof Error ? err.message : String(err);
    resultados.push({ n, label, estado: 'fail', nota, requerido });
    console.log(`  ✘ ${String(n).padStart(2, '0')}. ${label} — ${nota}`);
    return false;
  }
}

function skip(label: string, motivo: string, requerido = false): void {
  const n = ++contador;
  resultados.push({ n, label, estado: 'skip', nota: motivo, requerido });
  console.log(`  – ${String(n).padStart(2, '0')}. ${label} — OMITIDA: ${motivo}`);
}

// ---------------------------------------------------------------------------
// Utilidades HTTP
// ---------------------------------------------------------------------------

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Respuesta<T = unknown> {
  status: number;
  body: T;
  raw: string;
}

async function pedir<T = unknown>(url: string, init: RequestInit = {}): Promise<Respuesta<T>> {
  const res = await fetch(url, init);
  const raw = await res.text();
  let body: unknown = null;
  try {
    body = raw ? JSON.parse(raw) : null;
  } catch {
    body = raw;
  }
  return { status: res.status, body: body as T, raw };
}

let token = '';

function api<T = unknown>(path: string, init: RequestInit = {}): Promise<Respuesta<T>> {
  const headers = new Headers(init.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return pedir<T>(`${HOST}${path}`, { ...init, headers });
}

function agora<T = unknown>(path: string, init: RequestInit = {}): Promise<Respuesta<T>> {
  const headers = new Headers(init.headers);
  headers.set('api_access_token', AGORA_TOKEN);
  return pedir<T>(`${AGORA_BASE_URL}/api/v1/accounts/${AGORA_ACCOUNT_ID}${path}`, { ...init, headers });
}

/**
 * Chatwoot envuelve unas respuestas en `{payload: …}` y otras no, y la envoltura cambia entre
 * versiones y entre endpoints. Desenvolver defensivamente es más barato que memorizar cuál es cuál.
 */
function desenvolver<T = Record<string, unknown>>(body: unknown): T {
  const b = body as Record<string, unknown> | null;
  if (b && typeof b === 'object' && 'payload' in b && b.payload && typeof b.payload === 'object') {
    return b.payload as T;
  }
  return (b ?? {}) as T;
}

function corte(s: string, n = 220): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

// ---------------------------------------------------------------------------
// Artefactos de la prealerta, construidos en memoria
// ---------------------------------------------------------------------------

const MESES_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/** `07 Ago` — el formato con mes abreviado en español y SIN año que manda el robot del cliente. */
function fechaCorta(d: Date): string {
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MESES_ES[d.getUTCMonth()]}`;
}

/**
 * Guía máster fresca por corrida. `160-` + 8 dígitos del timestamp: cumple la forma que el parser
 * reconoce (/\b\d{3}[-\s]?\d{8}\b/) y no colisiona con `operaciones.mawb`, que es único — reusar una
 * guía convertiría la demo en un PREALERTA_VERSIONADA sobre un caso viejo en vez de un caso nuevo.
 */
function nuevaMawb(): { raw: string; norm: string } {
  const digitos = String(Date.now()).slice(-8);
  return { raw: `160-${digitos}`, norm: `160${digitos}` };
}

/**
 * PDF mínimo pero VÁLIDO (1 página, un texto). Deliberadamente sin /JS, /OpenAction, /URI ni
 * /EmbeddedFile: el escáner RF-08 debe devolver `clean`, porque lo que la demo prueba es que el
 * escaneo CORRE y emite un veredicto, no que sepa bloquear (eso lo cubren los tests unitarios).
 */
function pdfAwb(mawb: string): Buffer {
  const texto = `AWB ${mawb} - DEMO E2E - iMile`;
  const objetos = [
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    '3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >> endobj\n',
    `4 0 obj << /Length ${`BT /F1 14 Tf 72 760 Td (${texto}) Tj ET\n`.length} >> stream\nBT /F1 14 Tf 72 760 Td (${texto}) Tj ET\nendstream endobj\n`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
  ];
  let cuerpo = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (const o of objetos) {
    offsets.push(cuerpo.length);
    cuerpo += o;
  }
  const inicioXref = cuerpo.length;
  let xref = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) xref += `${String(off).padStart(10, '0')} 00000 n \n`;
  const trailer = `trailer << /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;
  return Buffer.from(cuerpo + xref + trailer, 'latin1');
}

/**
 * Manifiesto CSV con los encabezados que `shared/parsing/headerSynonyms.ts` ya conoce, y con las
 * cantidades DESCUADRADAS a propósito: 10 + 25 = 35 piezas contra las 2914 que declara el correo.
 * PA-02 tiene que dispararse como `error`. Una bandera roja que se enciende ES una capacidad: el
 * valor del cotejo es poder contradecir al cliente, así que la demo lo enseña en vez de esconderlo.
 */
function csvManifiesto(mawbRaw: string): Buffer {
  const filas = [
    'No. de guia aerea o documento de transporte,Descripcion de la mercancia,Fraccion arancelaria,Cantidad de la mercancia,Valor en aduana declarado,Moneda,Pais de procedencia',
    `${mawbRaw}-001,Blusa de poliester para dama,61062000,10,120.50,USD,CN`,
    `${mawbRaw}-002,Pantalon de algodon para caballero,62034200,25,310.75,USD,CN`,
  ];
  return Buffer.from(`${filas.join('\n')}\n`, 'utf8');
}

/** PNG 1×1 válido, para la evidencia de campo (R32). */
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

function blob(bytes: Buffer, type: string): Blob {
  return new Blob([new Uint8Array(bytes)], { type });
}

// ---------------------------------------------------------------------------
// Tipos mínimos de las respuestas que leemos
// ---------------------------------------------------------------------------

interface Adjunto {
  tipo: string;
  originalName: string;
  contentHash: string;
  scanVerdict: string;
}

interface PrealertaDetalle {
  id: string;
  version: number;
  estado: string;
  parserVersion: string;
  parsed: {
    fields?: Record<string, unknown>;
    provenance?: Record<string, string>;
    warnings?: Array<{ code: string }>;
  } | null;
  adjuntos: Adjunto[];
}

interface EventoTimeline {
  id: string;
  tipo: string;
  origen: string;
  ocurridoAt: string;
  registradoAt: string;
  payload: Record<string, unknown> | null;
}

interface Discrepancia {
  codigo: string;
  severidad: string;
  mensaje: string;
}

interface OperacionDetalle {
  id: string;
  mawb: string;
  mawbRaw: string | null;
  manifestId: string | null;
  numeroVuelo: string | null;
  etdOrigen: string | null;
  etaPais: string | null;
  cartonesPrealerta: number | null;
  piezasPrealerta: number | null;
  pesoKgPrealerta: string | number | null;
  etapa: string;
  estadoDocumental: string;
  semaforo: string | null;
  discrepancias: Discrepancia[] | null;
  agoraConversationId: string | null;
  disponibleAt: string | null;
  prealertas: PrealertaDetalle[];
  timeline: EventoTimeline[];
}

// ---------------------------------------------------------------------------
// Pasos
// ---------------------------------------------------------------------------

function exigirEnv(): void {
  // Con un caso ya existente no se toca AGORA, así que su configuración deja de ser obligatoria.
  const faltan = (
    OPERACION_EXISTENTE
      ? [['DEMO_PASS', DEMO_PASS]]
      : [
          ['DEMO_PASS', DEMO_PASS],
          ['AGORA_BASE_URL', AGORA_BASE_URL],
          ['AGORA_ACCOUNT_ID', AGORA_ACCOUNT_ID],
          ['AGORA_API_ACCESS_TOKEN', AGORA_TOKEN],
          ['AGORA_PREALERTAS_INBOX_ID', AGORA_INBOX_ID],
        ]
  )
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (faltan.length) {
    console.error(`[demoE2e] faltan variables de entorno: ${faltan.join(', ')}`);
    console.error('[demoE2e] ver el encabezado de este archivo o docs/DEMO_E2E.md');
    process.exit(2);
  }
}

async function login(): Promise<void> {
  const res = await api<{ token?: string; user?: { role?: string } }>('/api/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: DEMO_USER, password: DEMO_PASS }),
  });
  if (res.status !== 200 || !res.body?.token) {
    throw new Error(`login falló (${res.status}): ${corte(res.raw)}`);
  }
  token = res.body.token;
  console.log(`[1/8] sesión en customs: ${DEMO_USER} (${res.body.user?.role ?? '?'})`);
}

/** Contacto en AGORA: buscar por correo y, si no existe, crearlo. */
async function encontrarOCrearContacto(): Promise<number> {
  const busca = await agora<{ payload?: Array<{ id: number; email?: string }> }>(
    `/contacts/search?q=${encodeURIComponent(CONTACTO_EMAIL)}`,
  );
  const encontrados = (busca.body?.payload ?? []) as Array<{ id: number; email?: string }>;
  const yaExiste = encontrados.find((c) => (c.email ?? '').toLowerCase() === CONTACTO_EMAIL);
  if (yaExiste) return yaExiste.id;

  const crea = await agora('/contacts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: CONTACTO_NOMBRE, email: CONTACTO_EMAIL }),
  });
  // 422 = ya existe con ese correo (carrera, o un índice único que la búsqueda no alcanzó).
  if (crea.status === 422) {
    const otra = await agora<{ payload?: Array<{ id: number; email?: string }> }>(
      `/contacts/search?q=${encodeURIComponent(CONTACTO_EMAIL)}`,
    );
    const c = (otra.body?.payload ?? []).find((x) => (x.email ?? '').toLowerCase() === CONTACTO_EMAIL);
    if (c) return c.id;
    throw new Error(`AGORA rechazó crear el contacto (422) y la búsqueda no lo encontró: ${corte(crea.raw)}`);
  }
  if (crea.status >= 300) throw new Error(`AGORA POST /contacts → ${crea.status}: ${corte(crea.raw)}`);

  // La envoltura varía: {payload:{contact:{id}}} | {payload:{id}} | {id}
  const p = desenvolver<{ contact?: { id?: number }; id?: number }>(crea.body);
  const id = p.contact?.id ?? p.id;
  if (!id) throw new Error(`AGORA creó el contacto pero no devolvió id: ${corte(crea.raw)}`);
  return id;
}

/**
 * `source_id` del contact_inbox. En el canal de correo suele ser la dirección misma; se pide
 * explícitamente porque `POST /conversations` la acepta como identidad del remitente y, en algunas
 * versiones, la exige.
 */
async function sourceIdDelInbox(contactId: number): Promise<string | null> {
  const det = await agora(`/contacts/${contactId}`);
  const p = desenvolver<{ contact_inboxes?: Array<{ source_id?: string; inbox?: { id?: number } }> }>(det.body);
  const ya = (p.contact_inboxes ?? []).find((ci) => String(ci.inbox?.id ?? '') === String(AGORA_INBOX_ID));
  if (ya?.source_id) return ya.source_id;

  const crea = await agora(`/contacts/${contactId}/contact_inboxes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ inbox_id: Number(AGORA_INBOX_ID) }),
  });
  if (crea.status >= 300) {
    console.warn(`  · contact_inboxes → ${crea.status} (${corte(crea.raw, 120)}); seguimos con contact_id`);
    return null;
  }
  const q = desenvolver<{ source_id?: string; contact_inbox?: { source_id?: string } }>(crea.body);
  return q.source_id ?? q.contact_inbox?.source_id ?? null;
}

async function crearConversacion(contactId: number, sourceId: string | null): Promise<number> {
  const intentos: Array<Record<string, unknown>> = [
    { inbox_id: Number(AGORA_INBOX_ID), contact_id: contactId, ...(sourceId ? { source_id: sourceId } : {}) },
    { inbox_id: Number(AGORA_INBOX_ID), contact_id: contactId },
  ];
  let ultima = '';
  for (const cuerpo of intentos) {
    const res = await agora(`/conversations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
    if (res.status < 300) {
      const p = desenvolver<{ id?: number }>(res.body);
      const id = p.id ?? (res.body as { id?: number } | null)?.id;
      if (id) return id;
    }
    ultima = `${res.status}: ${corte(res.raw, 160)}`;
  }
  throw new Error(`AGORA POST /conversations falló — ${ultima}`);
}

interface AdjuntoAgora {
  id?: number;
  file_type?: string;
  extension?: string;
  data_url?: string;
}

interface MensajeAgora {
  id: number;
  brazo: string;
  rechazoEntrante: string | null;
  adjuntos: AdjuntoAgora[];
}

/**
 * El mensaje con los dos adjuntos, como multipart. Dos brazos: con `message_type=incoming` y sin él,
 * porque AGORA rechaza que la API declare un entrante en un inbox de correo. El brazo que funcionó y
 * el motivo del rechazo se reportan los dos — el rechazo es un hallazgo, no ruido.
 */
async function publicarMensaje(
  conversationId: number,
  contenido: string,
  mawbRaw: string,
): Promise<MensajeAgora> {
  const brazos: Array<{ nombre: string; conTipo: boolean }> = [
    { nombre: 'message_type=incoming', conTipo: true },
    { nombre: 'sin message_type', conTipo: false },
  ];
  let ultima = '';
  let rechazoEntrante: string | null = null;
  for (const brazo of brazos) {
    const form = new FormData();
    form.append('content', contenido);
    form.append('private', 'false');
    if (brazo.conTipo) form.append('message_type', 'incoming');
    form.append('attachments[]', blob(pdfAwb(mawbRaw), 'application/pdf'), `awb-${mawbRaw}.pdf`);
    form.append('attachments[]', blob(csvManifiesto(mawbRaw), 'text/csv'), `manifiesto-${mawbRaw}.csv`);

    const res = await agora(`/conversations/${conversationId}/messages`, { method: 'POST', body: form });
    if (res.status < 300) {
      const p = desenvolver<{ id?: number; attachments?: AdjuntoAgora[] }>(res.body);
      const id = p.id ?? (res.body as { id?: number } | null)?.id;
      if (id) return { id, brazo: brazo.nombre, rechazoEntrante, adjuntos: p.attachments ?? [] };
    }
    if (brazo.conTipo) rechazoEntrante = `${res.status} ${corte(res.raw, 120)}`;
    ultima = `${brazo.nombre} → ${res.status}: ${corte(res.raw, 160)}`;
  }
  throw new Error(`AGORA POST /messages falló — ${ultima}`);
}

/**
 * Plan C: firmar y entregar el MISMO `message_created` que AGORA habría mandado, con los `data_url`
 * reales de los adjuntos ya alojados en AGORA. Ver el bloque de TRES CAMINOS del encabezado: existe
 * porque AGORA no deja crear entrantes por API en un inbox de correo, no porque el atajo sea cómodo.
 *
 * La firma se calcula sobre los BYTES EXACTOS que se envían — customs verifica el HMAC contra el
 * cuerpo crudo, así que re-serializar rompería la firma.
 */
async function entregarWebhookFirmado(input: {
  mensajeId: number;
  conversationId: number;
  contactId: number;
  contenido: string;
  adjuntos: AdjuntoAgora[];
}): Promise<{ status: number; raw: string; body: { status?: string; operacionId?: string } | null }> {
  const payload = {
    event: 'message_created',
    id: input.mensajeId,
    message_type: 'incoming',
    private: false,
    content: input.contenido,
    // Un mensaje creado por API no trae sobre de correo; el ingest cae a `payload.content` y a
    // `sender.email`, que es justo la ruta que este brazo ejercita.
    content_attributes: {},
    conversation: { id: input.conversationId, inbox_id: Number(AGORA_INBOX_ID) },
    inbox: { id: Number(AGORA_INBOX_ID) },
    sender: { id: input.contactId, email: CONTACTO_EMAIL, name: CONTACTO_NOMBRE },
    attachments: input.adjuntos.map((a) => ({
      id: a.id,
      file_type: a.file_type ?? 'file',
      extension: a.extension,
      data_url: a.data_url,
    })),
  };
  const cuerpo = Buffer.from(JSON.stringify(payload), 'utf8');
  const t = Math.floor(Date.now() / 1000);
  const v1 = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${cuerpo.toString('utf8')}`).digest('hex');

  const res = await pedir<{ status?: string; operacionId?: string }>(`${HOST}/api/prealertas/inbound`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agora-signature': `t=${t},v1=${v1}`,
      'x-agora-event-id': randomUUID(),
    },
    body: cuerpo,
  });
  return { status: res.status, raw: res.raw, body: res.body };
}

/** Busca el caso por guía normalizada (operaciones.mawb guarda normGuia: sólo dígitos). */
async function buscarOperacion(mawbNorm: string): Promise<string | null> {
  const res = await api<Array<{ id: string; mawb: string }>>(
    `/api/operaciones?q=${encodeURIComponent(mawbNorm)}`,
  );
  if (res.status !== 200 || !Array.isArray(res.body)) return null;
  return res.body.find((o) => o.mawb === mawbNorm)?.id ?? null;
}

async function tick(): Promise<string> {
  if (!OPS_TICK_TOKEN) return 'OPS_TICK_TOKEN ausente — no se pudo forzar el barrido';
  const res = await api(`/api/ops/tick`, { method: 'POST', headers: { 'x-ops-token': OPS_TICK_TOKEN } });
  return `POST /api/ops/tick → ${res.status} ${corte(res.raw, 200)}`;
}

/**
 * Espera el caso, escalando por los tres caminos de entrega y devolviendo cuál fue.
 *
 *   0 %– 40 % del presupuesto → sólo el webhook de AGORA (camino A)
 *  40 %– 70 %                 → + barrido de reconciliación (camino B)
 *  70 %–100 %                 → + entrega firmada por el script (camino C, si hay secreto)
 *
 * El escalonamiento importa: si el caso aparece antes de disparar el barrido, sabemos que fue el
 * webhook, y esa distinción es exactamente lo que el scorecard tiene que poder afirmar.
 */
async function esperarOperacion(
  mawbNorm: string,
  planC: () => Promise<string>,
): Promise<{ id: string; via: string; ms: number }> {
  const inicio = Date.now();
  const tB = inicio + Math.floor(POLL_TIMEOUT_MS * 0.4);
  const tC = inicio + Math.floor(POLL_TIMEOUT_MS * 0.7);
  let via = 'A · webhook de AGORA';
  let notaB = '';
  let notaC = '';
  let hechoB = false;
  let hechoC = false;

  for (;;) {
    const id = await buscarOperacion(mawbNorm);
    if (id) return { id, via: `${via}${notaC ? ` — ${notaC}` : notaB ? ` — ${notaB}` : ''}`, ms: Date.now() - inicio };

    const agotado = Date.now() > inicio + POLL_TIMEOUT_MS;
    if (agotado) {
      throw new Fallo(
        `el caso no apareció en ${Math.round(POLL_TIMEOUT_MS / 1000)} s por ninguno de los tres caminos` +
          `${notaB ? ` · barrido: ${notaB}` : ''}${notaC ? ` · firmado: ${notaC}` : ''}`,
      );
    }
    if (!hechoB && Date.now() > tB) {
      hechoB = true;
      notaB = await tick();
      via = 'B · barrido de reconciliación';
      console.log(`  · sin webhook todavía; forzando barrido: ${notaB}`);
    }
    if (!hechoC && Date.now() > tC) {
      hechoC = true;
      notaC = await planC();
      via = 'C · webhook firmado por el script (límite de AGORA: ver el encabezado)';
      console.log(`  · sin barrido tampoco; entregando el webhook firmado: ${notaC}`);
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

async function detalle(id: string): Promise<OperacionDetalle> {
  const res = await api<OperacionDetalle>(`/api/operaciones/${id}`);
  if (res.status !== 200) throw new Error(`GET /api/operaciones/${id} → ${res.status}: ${corte(res.raw)}`);
  return res.body;
}

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function disc(op: OperacionDetalle, codigo: string): Discrepancia | undefined {
  return (op.discrepancias ?? []).find((d) => d.codigo === codigo);
}

function tipos(op: OperacionDetalle): string[] {
  return op.timeline.map((e) => e.tipo);
}

interface EventoRespuesta {
  ok?: boolean;
  noop?: boolean;
  etapa?: string;
  etapaAnterior?: string;
  etapaActual?: string;
  semaforo?: string | null;
  eventoId?: string;
  payload?: Record<string, unknown>;
  error?: string;
}

async function evento(
  opId: string,
  cuerpo: Record<string, unknown>,
): Promise<Respuesta<EventoRespuesta>> {
  return api<EventoRespuesta>(`/api/campo/operaciones/${opId}/evento`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  exigirEnv();

  const mawb = nuevaMawb();
  const hoy = new Date();
  const contenido =
    `iMile// ${mawb.raw} //ETD：${fechaCorta(hoy)} 06:00//ETA：${fechaCorta(hoy)} 09:45 ETA` +
    `//64 CTNS/ 2914 PCS/ 542.86 KGS`;

  console.log('═'.repeat(78));
  console.log('CASO DE PRUEBA DE CAPACIDADES COMPLETAS — customs × AGORA');
  console.log('═'.repeat(78));
  console.log(`host        ${HOST}`);
  console.log(`agora       ${AGORA_BASE_URL} · cuenta ${AGORA_ACCOUNT_ID} · inbox ${AGORA_INBOX_ID}`);
  console.log(`guía máster ${mawb.raw}  (normalizada: ${mawb.norm})`);
  console.log(`prealerta   ${contenido}`);
  console.log('');

  await login();

  // ---- 1. Prealerta creada EN AGORA ------------------------------------------------------------
  let conversationId = 0;
  let contactId = 0;
  let mensajeId = 0;
  let brazoMensaje = '';
  let rechazoEntrante: string | null = null;
  let adjuntosAgora: AdjuntoAgora[] = [];

  let opId = '';
  let via = 'n/d';

  if (OPERACION_EXISTENTE) {
    console.log(`[2/8] DEMO_OPERACION_ID presente — se reanuda sobre ${OPERACION_EXISTENTE}, sin tocar AGORA`);
    skip('R1 · Prealerta creada en AGORA', 'se reanudó sobre un caso existente (DEMO_OPERACION_ID)');
    const reanudo = await check('R1/N1 · El caso existe y es legible', async () => {
      const d = await detalle(OPERACION_EXISTENTE);
      opId = d.id;
      via = 'caso preexistente (DEMO_OPERACION_ID)';
      return `operación ${d.id} · mawb ${d.mawb} · etapa ${d.etapa}`;
    });
    if (!reanudo) {
      imprimirScorecard({ mawb, opId: null, conversationId: null, via, brazoMensaje, rechazoEntrante });
      process.exit(1);
    }
    await recorrerCaso(opId, mawb, { reanudado: true });
    console.log('[8/8] scorecard');
    imprimirScorecard({ mawb, opId, conversationId: null, via, brazoMensaje, rechazoEntrante });
    return;
  }

  console.log('[2/8] creando la prealerta en AGORA');
  const creada = await check('R1 · Prealerta creada en AGORA (contacto → conversación → mensaje con 2 adjuntos alojados en AGORA)', async () => {
    contactId = await encontrarOCrearContacto();
    const sourceId = await sourceIdDelInbox(contactId);
    conversationId = await crearConversacion(contactId, sourceId);
    const msg = await publicarMensaje(conversationId, contenido, mawb.raw);
    mensajeId = msg.id;
    brazoMensaje = msg.brazo;
    rechazoEntrante = msg.rechazoEntrante;
    adjuntosAgora = msg.adjuntos;
    expect(adjuntosAgora.length === 2, `AGORA guardó ${adjuntosAgora.length} adjuntos (esperaba 2)`);
    expect(
      adjuntosAgora.every((a) => Boolean(a.data_url)),
      'algún adjunto quedó sin data_url — customs no podría descargarlo',
    );
    return `contacto ${contactId}, conversación ${conversationId}, mensaje ${mensajeId} (${msg.brazo}), 2 adjuntos con data_url`;
  });
  if (!creada) {
    imprimirScorecard({ mawb, opId: null, conversationId: conversationId || null, via: 'n/d', brazoMensaje, rechazoEntrante });
    process.exit(1);
  }

  await check('Hallazgo · AGORA no permite crear mensajes ENTRANTES por API en un inbox de correo', () => {
    if (!rechazoEntrante) return 'esta versión de AGORA SÍ aceptó message_type=incoming — el camino A queda disponible';
    return `AGORA respondió ${rechazoEntrante} — de ahí el camino C (webhook firmado). Ver docs/DEMO_E2E.md`;
  }, { requerido: false });

  // ---- 2. Entrega a customs --------------------------------------------------------------------
  console.log('[3/8] esperando que el caso aterrice en customs');

  const planC = async (): Promise<string> => {
    if (!WEBHOOK_SECRET) return 'AGORA_WEBHOOK_SIGNING_SECRET ausente — camino C no disponible';
    const r = await entregarWebhookFirmado({
      mensajeId,
      conversationId,
      contactId,
      contenido,
      adjuntos: adjuntosAgora,
    });
    return `POST /api/prealertas/inbound → ${r.status} ${corte(r.raw, 160)}`;
  };

  const aterrizo = await check('R1/N1 · El caso aterriza en customs (A webhook · B barrido · C webhook firmado)', async () => {
    const r = await esperarOperacion(mawb.norm, planC);
    opId = r.id;
    via = r.via;
    return `operación ${r.id} vía ${r.via} en ${(r.ms / 1000).toFixed(1)} s`;
  });
  if (!aterrizo) {
    imprimirScorecard({ mawb, opId: null, conversationId, via, brazoMensaje, rechazoEntrante });
    process.exit(1);
  }

  await recorrerCaso(opId, mawb, { reanudado: false });

  console.log('[8/8] scorecard');
  imprimirScorecard({ mawb, opId, conversationId, via, brazoMensaje, rechazoEntrante });
}

/**
 * Pasos 3–8: aserciones sobre el caso, recorrido de campo, estado final y reproceso. Separado de la
 * creación para que `DEMO_OPERACION_ID` pueda reanudar aquí sobre un caso que ya existe.
 */
async function recorrerCaso(
  opId: string,
  mawb: { raw: string; norm: string },
  opts: { reanudado: boolean },
): Promise<void> {
  // ---- 3. Aserciones sobre el caso -------------------------------------------------------------
  console.log('[4/8] verificando el caso');
  const op = await detalle(opId);
  const pre = op.prealertas[0];

  /**
   * Las aserciones de CONTENIDO del ingest sólo son exigibles cuando este script mandó ese contenido.
   * Al reanudar sobre un caso ajeno se siguen ejecutando y reportando — dicen algo útil sobre ese
   * caso — pero como informativas: no serían una falla de capacidad, sino datos distintos.
   */
  const reqIngest = { requerido: !opts.reanudado };
  if (opts.reanudado) {
    mawb = { raw: op.mawbRaw ?? op.mawb, norm: op.mawb };
  }

  await check('R2 · Guía máster parseada por FORMA y usada como clave del caso', () => {
    expect(op.mawb === mawb.norm, `mawb=${op.mawb} ≠ ${mawb.norm}`);
    expect(op.mawbRaw === mawb.raw, `mawbRaw=${op.mawbRaw} ≠ ${mawb.raw}`);
    expect(pre?.parsed?.provenance?.mawb === 'forma', `provenance.mawb=${pre?.parsed?.provenance?.mawb}`);
    return `${op.mawbRaw} → ${op.mawb} (provenance: forma, parser ${pre?.parserVersion})`;
  });

  await check('R2 · Cantidades declaradas extraídas con su PROCEDENCIA (64 CTNS / 2914 PCS / 542.86 KGS)', () => {
    expect(op.cartonesPrealerta === 64, `cartones=${op.cartonesPrealerta}`);
    expect(op.piezasPrealerta === 2914, `piezas=${op.piezasPrealerta}`);
    const peso = num(op.pesoKgPrealerta);
    expect(peso !== null && Math.abs(peso - 542.86) < 0.01, `peso=${op.pesoKgPrealerta}`);
    const p = pre?.parsed?.provenance ?? {};
    for (const campo of ['cartones', 'piezas', 'pesoKg'] as const) {
      expect(Boolean(p[campo]), `sin provenance para ${campo}`);
    }
    return `64/2914/${peso} kg · provenance ${p.cartones}/${p.piezas}/${p.pesoKg}`;
  }, reqIngest);

  await check('R2 · Los dos puntos DE ANCHO COMPLETO (：) sobreviven: ETD y ETA quedan poblados', () => {
    expect(Boolean(op.etdOrigen), 'etdOrigen vacío');
    expect(Boolean(op.etaPais), 'etaPais vacío');
    expect(Date.parse(op.etdOrigen!) < Date.parse(op.etaPais!), 'ETD no precede a ETA');
    return `ETD ${op.etdOrigen} · ETA ${op.etaPais}`;
  }, reqIngest);

  await check('R3/R-A · Los dos adjuntos se descargaron de AGORA, se hashearon y se escanearon', () => {
    const adj = pre?.adjuntos ?? [];
    expect(adj.length === 2, `${adj.length} adjuntos (esperaba 2)`);
    for (const a of adj) {
      expect(/^[0-9a-f]{64}$/.test(a.contentHash), `contentHash no es sha256 hex: ${a.contentHash}`);
    }
    const awb = adj.find((a) => a.tipo === 'awb');
    const man = adj.find((a) => a.tipo === 'manifiesto');
    expect(Boolean(awb), 'falta el adjunto tipo awb');
    expect(Boolean(man), 'falta el adjunto tipo manifiesto');
    expect(['clean', 'suspicious'].includes(awb!.scanVerdict), `veredicto del AWB: ${awb!.scanVerdict}`);
    expect(man!.scanVerdict === 'unscannable', `veredicto del manifiesto: ${man!.scanVerdict}`);
    return `awb ${awb!.scanVerdict} (${awb!.contentHash.slice(0, 12)}…) · manifiesto ${man!.scanVerdict} (${man!.contentHash.slice(0, 12)}…)`;
  }, reqIngest);

  await check('R3 · El manifiesto adjunto entró al pipeline de manifiestos (manifestId asignado)', () => {
    expect(Boolean(op.manifestId), 'manifestId nulo — el manifiesto no se ingestó');
    return `manifest ${op.manifestId}`;
  }, reqIngest);

  await check('R5/PA-02 · La bandera roja plantada se enciende: piezas del correo ≠ del manifiesto', () => {
    const d = disc(op, 'PA-02');
    expect(Boolean(d), 'PA-02 ausente');
    expect(d!.severidad === 'error', `PA-02 con severidad ${d!.severidad}`);
    return d!.mensaje;
  }, reqIngest);

  await check('R5/PA-01,PA-03 · Lo no evaluable se REPORTA, no se aprueba en silencio', () => {
    const hallados = ['PA-01', 'PA-03'].map((c) => ({ c, d: disc(op, c) }));
    const resumen = hallados.map(({ c, d }) => `${c}=${d ? d.severidad : 'ausente'}`).join(' · ');
    // El manifiesto de la demo no declara ni cartones (sin columna `bulto`) ni peso, así que estas
    // dos reglas deben salir `informativa` — "no evaluable", que es distinto de "coincide".
    const informativas = hallados.filter(({ d }) => d?.severidad === 'informativa').length;
    return informativas
      ? `${resumen} — ${informativas} de 2 reportadas como NO EVALUABLES, no como coincidencias`
      : `${resumen} — este caso no produjo el par informativo esperado`;
  }, { requerido: false });

  await check('R5/PA-10 · Un vuelo NO VERIFICABLE se reporta, nunca se silencia', async () => {
    let d = disc(op, 'PA-10');
    if (!d) {
      // Segunda oportunidad: el tick reintenta la resolución de vuelo.
      await tick();
      d = disc(await detalle(opId), 'PA-10');
    }
    expect(Boolean(d), 'PA-10 ausente: un vuelo sin declarar quedó indistinguible de uno verificado');
    expect(d!.severidad === 'advertencia', `PA-10 con severidad ${d!.severidad}`);
    return `${d!.mensaje} (vuelo declarado: ${op.numeroVuelo ?? 'ninguno'})`;
  });

  await check('R6 · Cliente desconocido reportado (PA-08) en vez de descartar el caso', () => {
    const d = disc(op, 'PA-08');
    expect(Boolean(d), 'PA-08 ausente');
    return `${d!.severidad} — ${d!.mensaje}`;
  }, { requerido: false });

  await check('R4/R5 · El riesgo corrió automáticamente al llegar la prealerta', () => {
    expect(
      ['riesgo_ok', 'riesgo_con_hallazgos'].includes(op.estadoDocumental),
      `estadoDocumental=${op.estadoDocumental} (esperaba riesgo_ok o riesgo_con_hallazgos)`,
    );
    return `estadoDocumental=${op.estadoDocumental}`;
  }, reqIngest);

  if (!OPS_TICK_TOKEN) {
    skip('N2 · Barrido de reconciliación (POST /api/ops/tick) responde', 'OPS_TICK_TOKEN ausente');
  } else {
    await check('N2 · Barrido de reconciliación (POST /api/ops/tick) responde: ningún webhook perdido queda perdido', async () => {
      const res = await api(`/api/ops/tick`, { method: 'POST', headers: { 'x-ops-token': OPS_TICK_TOKEN } });
      expect(res.status === 200, `${res.status}: ${corte(res.raw, 160)}`);
      return corte(res.raw, 180);
    }, { requerido: false });
  }

  await check('N1 · La bitácora append-only registró la cadena completa del ingest', () => {
    const t = tipos(op);
    for (const esperado of ['PREALERTA_RECIBIDA', 'COTEJO_EJECUTADO', 'RIESGO_EVALUADO']) {
      expect(t.includes(esperado), `falta ${esperado} en la bitácora (hay: ${t.join(', ')})`);
    }
    return t.join(' → ');
  }, reqIngest);

  // ---- 4. Recorrido de campo -------------------------------------------------------------------
  console.log('[5/8] recorrido de campo (CampoView)');
  const base = Date.now();
  const en = (minutosAtras: number): string => new Date(base - minutosAtras * 60_000).toISOString();

  let eventoInicioCarga = '';

  await check('R11 · CARGA_DISPONIBLE: el hecho que el almacén nunca avisa queda con hora', async () => {
    const res = await evento(opId, { tipo: 'CARGA_DISPONIBLE', ocurridoAt: en(40) });
    expect(res.status === 201, `${res.status}: ${corte(res.raw, 160)}`);
    expect(res.body.etapa === 'disponible', `etapa=${res.body.etapa}`);
    return `201 · etapa ${res.body.etapaAnterior ?? '?'} → ${res.body.etapa}`;
  });

  await check('N4 · Idempotencia en vivo: repetir CARGA_DISPONIBLE es {noop:true} 200, no un evento fantasma', async () => {
    const res = await evento(opId, { tipo: 'CARGA_DISPONIBLE', ocurridoAt: en(40) });
    expect(res.status === 200, `${res.status}: ${corte(res.raw, 160)}`);
    expect(res.body.noop === true, `noop=${String(res.body.noop)}`);
    return `200 {noop:true, etapa:'${res.body.etapa}'} — la cola de reintentos no tartamudea la bitácora`;
  });

  await check('R30 · INGRESO_PATIO: hecho de bitácora puro (no mueve etapa)', async () => {
    const res = await evento(opId, { tipo: 'INGRESO_PATIO', ocurridoAt: en(30) });
    expect(res.status === 201, `${res.status}: ${corte(res.raw, 160)}`);
    expect(res.body.etapa === 'disponible', `etapa cambió a ${res.body.etapa}`);
    return `201 · etapa sigue en '${res.body.etapa}' — su valor es el timestamp, no el estado`;
  });

  await check('R30 · INGRESO_ADUANA con cita: la DEMORA contra la cita se calcula y se guarda', async () => {
    const res = await evento(opId, { tipo: 'INGRESO_ADUANA', ocurridoAt: en(20), citaAt: en(30) });
    expect(res.status === 201, `${res.status}: ${corte(res.raw, 160)}`);
    const demora = num(res.body.payload?.demoraMin);
    expect(demora !== null && Math.abs(demora - 10) <= 1, `demoraMin=${String(res.body.payload?.demoraMin)}`);
    return `201 · demoraMin=${demora} (citado ${en(30)}, entró ${en(20)})`;
  });

  await check('R31 · INICIO_CARGA: sólo aquí se asevera que la carga se mueve', async () => {
    const res = await evento(opId, { tipo: 'INICIO_CARGA', ocurridoAt: en(15) });
    expect(res.status === 201, `${res.status}: ${corte(res.raw, 160)}`);
    expect(res.body.etapa === 'en_carga', `etapa=${res.body.etapa}`);
    eventoInicioCarga = String(res.body.eventoId ?? '');
    return `201 · etapa ${res.body.etapaAnterior} → ${res.body.etapa} (evento ${eventoInicioCarga})`;
  });

  await check('R32/D5 · Evidencia fotográfica hasheada y ligada al evento de inicio de carga', async () => {
    const form = new FormData();
    form.append('file', blob(PNG_1X1, 'image/png'), 'inicio-carga.png');
    form.append('tipo', 'inicio_carga');
    form.append('capturadoAt', en(14));
    form.append('deviceId', 'demo-e2e');
    if (eventoInicioCarga) form.append('eventoId', eventoInicioCarga);
    const res = await api<{ contentHash?: string; evidenciaId?: string; eventoId?: string }>(
      `/api/campo/operaciones/${opId}/evidencia`,
      { method: 'POST', body: form },
    );
    expect(res.status === 201, `${res.status}: ${corte(res.raw, 200)}`);
    const hash = res.body.contentHash ?? '';
    expect(/^[0-9a-f]{64}$/.test(hash), `contentHash inválido: ${hash}`);
    const det = await detalle(opId);
    const ev = det.timeline.find((e) => e.tipo === 'EVIDENCIA_CAPTURADA');
    expect(Boolean(ev), 'EVIDENCIA_CAPTURADA no está en la bitácora');
    expect(
      String((ev!.payload ?? {}).contentHash ?? '') === hash,
      'el hash de la bitácora no coincide con el devuelto',
    );
    return `201 · sha256 ${hash.slice(0, 16)}… presente también en la bitácora`;
  });

  await check('R31 · FIN_CARGA: hecho de bitácora puro', async () => {
    const res = await evento(opId, { tipo: 'FIN_CARGA', ocurridoAt: en(10) });
    expect(res.status === 201, `${res.status}: ${corte(res.raw, 160)}`);
    expect(res.body.etapa === 'en_carga', `etapa=${res.body.etapa}`);
    return `201 · etapa sigue en '${res.body.etapa}'`;
  });

  await check('R33 · MODULACION en rojo capturada 5 min TARDE: ocurridoAt ≠ registradoAt', async () => {
    const res = await evento(opId, { tipo: 'MODULACION', semaforo: 'red', ocurridoAt: en(5) });
    expect(res.status === 201, `${res.status}: ${corte(res.raw, 160)}`);
    expect(res.body.etapa === 'reconocimiento', `etapa=${res.body.etapa}`);
    const det = await detalle(opId);
    const ev = det.timeline.find((e) => e.tipo === 'MODULACION');
    expect(Boolean(ev), 'MODULACION no está en la bitácora');
    const delta = Date.parse(ev!.registradoAt) - Date.parse(ev!.ocurridoAt);
    expect(delta > 60_000, `ocurrido_at y registrado_at difieren sólo ${Math.round(delta / 1000)} s`);
    return `201 · semáforo red · ocurrió ${ev!.ocurridoAt}, se registró ${ev!.registradoAt} (Δ ${Math.round(delta / 60_000)} min)`;
  });

  await sleep(2_000);

  await check('R35 · SALIDA_ROJO: el tiempo en reconocimiento se mide, no se estima', async () => {
    const res = await evento(opId, { tipo: 'SALIDA_ROJO', ocurridoAt: new Date().toISOString() });
    expect(res.status === 201, `${res.status}: ${corte(res.raw, 160)}`);
    const min = num(res.body.payload?.tiempoEnRojoMin);
    expect(min !== null && min >= 5, `tiempoEnRojoMin=${String(res.body.payload?.tiempoEnRojoMin)}`);
    expect(res.body.etapa === 'en_transito', `etapa=${res.body.etapa}`);
    return `201 · tiempoEnRojoMin=${min} · etapa ${res.body.etapaAnterior} → ${res.body.etapa}`;
  });

  await check('R34 · Monotonía en vivo: INICIO_CARGA desde en_transito es 409 con etapaActual', async () => {
    const res = await evento(opId, { tipo: 'INICIO_CARGA', ocurridoAt: new Date().toISOString() });
    expect(res.status === 409, `${res.status}: ${corte(res.raw, 160)}`);
    expect(res.body.etapaActual === 'en_transito', `etapaActual=${res.body.etapaActual}`);
    return `409 · etapaActual='${res.body.etapaActual}' — el avance físico no regresa`;
  });

  // ---- 5. Estado final ------------------------------------------------------------------------
  console.log('[6/8] estado final del caso');
  const fin = await detalle(opId);

  await check('R30–R35 · Estado final coherente: en_transito, semáforo red, tres sellos de tiempo', () => {
    expect(fin.etapa === 'en_transito', `etapa=${fin.etapa}`);
    expect(fin.semaforo === 'red', `semaforo=${fin.semaforo}`);
    expect(Boolean(fin.disponibleAt), 'disponible_at vacío');
    const t = tipos(fin);
    for (const esperado of ['CARGA_DISPONIBLE', 'MODULACION', 'SALIDA_ROJO']) {
      expect(t.includes(esperado), `falta ${esperado} en la bitácora`);
    }
    return `etapa=${fin.etapa} · semaforo=${fin.semaforo} · disponibleAt=${fin.disponibleAt} · ${t.length} eventos en bitácora`;
  });

  // ---- 6. Reparse -----------------------------------------------------------------------------
  console.log('[7/8] reproceso del parse');
  await check('R2 · Reparse: un caso ya guardado se puede sanar con el parser vigente', async () => {
    const res = await api<{ ok?: boolean; parserVersion?: string; discrepancias?: number }>(
      `/api/operaciones/${opId}/reparse`,
      { method: 'POST' },
    );
    expect(res.status === 200, `${res.status}: ${corte(res.raw, 200)}`);
    expect(res.body.ok === true, `ok=${String(res.body.ok)}`);
    expect(Boolean(res.body.parserVersion), 'sin parserVersion');
    expect(
      res.body.parserVersion === fin.prealertas[0]?.parserVersion,
      `parserVersion ${res.body.parserVersion} ≠ ${fin.prealertas[0]?.parserVersion} del caso`,
    );
    return `ok · parser ${res.body.parserVersion} · ${res.body.discrepancias} discrepancias tras el reproceso`;
  });
}

// ---------------------------------------------------------------------------
// Scorecard
// ---------------------------------------------------------------------------

function imprimirScorecard(ctx: {
  mawb: { raw: string; norm: string };
  opId: string | null;
  conversationId: number | null;
  via: string;
  brazoMensaje: string;
  rechazoEntrante: string | null;
}): void {
  const fallas = resultados.filter((r) => r.estado === 'fail');
  const fallasRequeridas = fallas.filter((r) => r.requerido);
  const oks = resultados.filter((r) => r.estado === 'ok');

  console.log('');
  console.log('═'.repeat(78));
  console.log('SCORECARD — CAPACIDADES DEMOSTRADAS');
  console.log('═'.repeat(78));
  for (const r of resultados) {
    const marca = r.estado === 'ok' ? '✔' : r.estado === 'fail' ? '✘' : '–';
    const etiqueta = r.requerido ? '' : ' [informativa]';
    console.log(`${marca} ${String(r.n).padStart(2, '0')}. ${r.label}${etiqueta}`);
    console.log(`      ${r.nota}`);
  }
  console.log('─'.repeat(78));
  console.log(`Total ${resultados.length} · ✔ ${oks.length} · ✘ ${fallas.length} (requeridas: ${fallasRequeridas.length})`);
  console.log('');
  console.log('EL CASO');
  console.log(`  guía máster        ${ctx.mawb.raw}  (clave interna ${ctx.mawb.norm})`);
  console.log(`  operación          ${ctx.opId ?? 'no se creó'}`);
  console.log(`  entregado vía      ${ctx.via}`);
  console.log(`  mensaje en AGORA   brazo '${ctx.brazoMensaje || 'n/d'}'`);
  if (ctx.rechazoEntrante) console.log(`  AGORA rechazó      message_type=incoming → ${ctx.rechazoEntrante}`);
  console.log('');
  console.log('DÓNDE VERLO');
  console.log(`  customs · Logística → Torre de Control   busca "${ctx.mawb.norm}"`);
  console.log(`  customs · Logística → Prealertas         el caso, su evidencia y su bitácora`);
  console.log(`  customs · Logística → Campo              los siete botones que este script pulsó`);
  console.log(`  customs · Autoridad                      bitácora + verificación de la cadena de hashes`);
  if (ctx.conversationId) {
    console.log(`  AGORA · conversación ${ctx.conversationId}                ${AGORA_BASE_URL}/app/accounts/${AGORA_ACCOUNT_ID}/conversations/${ctx.conversationId}`);
  }
  console.log('');
  console.log('NO CUBIERTO AÚN: notificaciones salientes al cliente (R18/R19, bloqueadas por SMTP),');
  console.log('despacho/POD y holds. Ver docs/DEMO_E2E.md.');
  console.log('═'.repeat(78));

  if (fallasRequeridas.length) process.exit(1);
}

main().catch((err) => {
  console.error('[demoE2e] el script se rompió (no es una falla de capacidad):', err instanceof Error ? err.stack : err);
  if (resultados.length) {
    console.log('');
    console.log('Scorecard parcial hasta el punto de la ruptura:');
    for (const r of resultados) {
      const marca = r.estado === 'ok' ? '✔' : r.estado === 'fail' ? '✘' : '–';
      console.log(`${marca} ${String(r.n).padStart(2, '0')}. ${r.label} — ${r.nota}`);
    }
  }
  process.exit(1);
});
