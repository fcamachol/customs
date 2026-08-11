/// <reference types="vite/client" />

const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

function authHeaders(): Record<string, string> {
  const t = localStorage.getItem('token');
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** Error class that preserves the full JSON body from a non-ok API response. */
export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const responseBody = await res.json().catch(() => ({})) as Record<string, unknown>;
    throw new ApiError(
      (responseBody.error as string | undefined) ?? res.statusText,
      res.status,
      responseBody,
    );
  }
  return res.json();
}

export async function apiPut<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(res.statusText);
  return res.json();
}

export async function apiDelete<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', headers: authHeaders() });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
  return res.json();
}

/**
 * Multipart POST.
 *
 * LANZA `ApiError`, NO `Error(body.error)`, y eso es lo que hace posible el flujo de sustitución de
 * manifiesto. `POST /api/manifests` responde 409 ante un MAWB repetido con `puedeSustituir:true` y
 * el `manifestId` del manifiesto que ya existe — es decir, con la salida — y quedarse sólo con la
 * frase del error tiraba justo los dos campos accionables, dejando en pantalla un callejón sin
 * salida donde el servidor ofrecía un camino. Mismo criterio que `apiDownload`.
 */
export async function apiUpload<T>(path: string, form: FormData): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'POST', headers: { ...authHeaders() }, body: form });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError((typeof body.error === 'string' && body.error) || 'Error', res.status, body);
  }
  return res.json();
}

/**
 * Download an archived artifact.
 *
 * IT THROWS AN `ApiError`, NOT AN `Error(res.statusText)`, AND THAT IS THE POINT OF THIS FUNCTION.
 * `GET /api/files/:id` answers three different facts with three different statuses (backlog #39):
 * 404 "we never had this file", 410 "the row and its sha256 are here, the BYTES are gone", 200 the
 * bytes. The 410 body carries the Spanish explanation, the `contentHash` the evidence was archived
 * under, and the `codigo` the recovery script keys on — everything a user needs to prove what the
 * artifact was and hand it to `npm --prefix server run recover:evidence`. Throwing `res.statusText`
 * discarded all of it and put the string "Gone" on screen, which reads as a bug in the app rather
 * than as a data-loss incident with a documented recovery path. A lost piece of customs evidence has
 * to announce itself as exactly that.
 *
 * The body is read defensively: a proxy or a gateway can answer with HTML, and a JSON parse failure
 * must still produce a usable error rather than swallow the status.
 */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, { headers: authHeaders() });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new ApiError(
      (typeof body.error === 'string' && body.error) || res.statusText,
      res.status,
      body,
    );
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
