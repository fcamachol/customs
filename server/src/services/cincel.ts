/**
 * CINCEL — NOM-151 digital signature for client convenios (PRD-02 Excel item 8; `docs/
 * PRD_sistema_operaciones_agora.md` §"Firma electrónica": "Integración Cincel (NOM-151) ya
 * construida"; D9: convenios se emiten firmados digitalmente, sin papel). The plan names Cincel
 * specifically as the PSC to reuse rather than contracting a second one — this module is that
 * integration, built the way `services/mailer.ts` (#22) was: CONFIG-GATED, and every call returns
 * what happened instead of throwing.
 *
 * THE CONTRACT, AND WHY IT IS SHAPED LIKE THE MAILER.
 *
 * 1. **It degrades, it does not fail.** Cincel is provisioned by a human (an account, an API key).
 *    Until `CINCEL_API_URL`/`CINCEL_API_KEY` are set, `loadCincelConfig()` returns null and every
 *    request comes back `{ status: 'omitido' }` with a stated reason — the convenio is recorded
 *    locally as pending-but-not-sent, never a 500. A contract that has not been sent for signature
 *    yet is a normal, visible state (`estado_firma = 'borrador'`), not an error.
 *
 * 2. **`omitido` is not `enviado`.** `routes/convenios.ts` only advances `estado_firma` to
 *    `solicitada` when this module reports `enviado` — the same "do not start the clock on an
 *    unconfirmed dispatch" discipline `requerimientosService.ts` applies to `notificado_at`.
 *
 * 3. **It never throws.** A network error, a timeout, a non-2xx from Cincel — all come back as
 *    `{ status: 'error' }` with the message, so the caller can persist it and let a human retry by
 *    calling the signature endpoint again.
 *
 * NO REAL NETWORK CALL IN TESTS. Exactly like `mailer.test.ts` mocks `nodemailer`, tests here mock
 * the global `fetch` (the house convention for outbound HTTP — see `services/agoraClient.ts`, which
 * has no dedicated HTTP client dependency either).
 *
 * =================================================================================================
 * UNIFICATION WITH `transportista_convenios` — DESIGNED HERE, DELIBERATELY NOT BUILT.
 * =================================================================================================
 *
 * THERE ARE TWO CONVENIO TABLES IN THIS SCHEMA and they are not variants of one thing yet:
 *
 *   `convenios`                — client-anchored (`client_id`), Cincel-integrated end to end: upload,
 *                                `POST /:id/firmar` dispatches through `solicitarFirma` below, and an
 *                                HMAC-verified webhook stores the NOM-151 conservation constancy and
 *                                sets `estado_firma = 'firmada'`. Vocabulary:
 *                                `borrador | solicitada | firmada | error`.
 *   `transportista_convenios`  — carrier-anchored (#29), no PSC integration. `POST
 *                                /api/transportistas/:id/convenios/:cid/firmar` RECORDS a signature
 *                                performed somewhere else, requiring `firmaProveedor` +
 *                                `firmaReferencia` — a smaller and truer claim than "we signed it".
 *                                Vocabulary: `borrador | enviado | firmado | vencido`
 *                                (`ESTADOS_FIRMA_CONVENIO`, shared/operaciones/catalogos.ts).
 *
 * THE VOCABULARY MISMATCH IS NOT COSMETIC. `firmada` and `firmado` are different strings in different
 * CHECK constraints, and `routes/despachos.ts` resolves every tarifa through
 * `c.estado_firma = 'firmado'` — the carrier spelling. A tarifa that does not resolve is a trip
 * contracted at no agreed price, so ANY unification has to be a migration that rewrites values under
 * a lock, not a widened CHECK plus hopeful code: while both spellings were legal in one column, half
 * the fleet would silently stop quoting.
 *
 * WHAT WIRING THE CARRIER SIDE THROUGH THIS MODULE ACTUALLY COSTS (why it is not a small change):
 *
 *   1. `transportista_convenios` has none of the dispatch-tracking columns the discipline depends on
 *      — no `cincel_solicitud_id` (the webhook's only correlation key), no `firma_url`, no
 *      `solicitud_firma_estado/_detalle/_intentos`, no `solicitado_at`. Without them a request could
 *      not be retried, and `estado_firma` would have to advance on the ATTEMPT, which is the exact
 *      "omitido is not enviado" rule this module exists to enforce.
 *   2. The webhook (`routes/convenios.ts`) looks up `convenios` by `cincel_solicitud_id` and knows one
 *      table. Serving both means either a second endpoint or a discriminated lookup, and Cincel's
 *      `external_id` is our convenio id with no type tag on it — so the id space of the two tables
 *      would have to be treated as one, which it currently is not.
 *   3. The signer differs in kind. A client convenio is signed by the client (`clients.email`); a
 *      carrier convenio is signed by the carrier (`transportistas.contacto_email`) AND, in practice,
 *      countersigned by us. `solicitarFirma` takes exactly one signer.
 *   4. `POST .../convenios/:cid/firmar` lives in `routes/transportistas.ts`, which is under
 *      concurrent modification in this working tree; changing its signing semantics in parallel with
 *      another edit is how a money-touching path acquires a merge artifact.
 *
 * THE DESIGN, WHEN IT IS BUILT. One migration adds the six dispatch/completion columns to
 * `transportista_convenios` and normalizes both tables onto ONE vocabulary — take the carrier
 * spelling (`firmado`), because `despachos.ts` already reads it and rewriting the tarifa join is the
 * riskier half. Add a `firma_solicitudes` correlation row, or prefix Cincel's `external_id` with the
 * table (`cli:<uuid>` / `tra:<uuid>`) so one webhook can route without guessing. Then
 * `routes/transportistas.ts` gains a `/firmar/cincel` sibling that calls `solicitarFirma` and leaves
 * the existing "record an external signature" endpoint intact — the two are different claims and
 * both stay true. NOTHING in this file changes: that is what `solicitarFirma`'s narrow surface bought.
 *
 * Half-building it — pointing the carrier signature at Cincel without the tracking columns and
 * without the correlation key — would produce a convenio that says `firmado` because a request was
 * dispatched, and every tarifa in it would rest on that. Deferred on purpose.
 *
 * RENEWAL (`POST /api/transportistas/:id/convenios/:cid/renovar`) WAS BUILT WITHOUT DISTURBING ANY OF
 * THIS. A signed carrier convenio's terms are frozen, so extending one creates a SUCCESSOR row that
 * carries the rates forward and links back through `renovado_de_convenio_id`. That flow is
 * deliberately orthogonal to signing: it always produces a row in `borrador` and stops there, so
 * whichever path that row later takes to `firmado` — today's "record an external signature", or the
 * `/firmar/cincel` sibling reserved above — is unaffected. It adds no signature state, no dispatch
 * column and no fourth spelling to the vocabulary; when the unification lands, a renewed convenio is
 * simply another unsigned convenio to send.
 *
 * A NOTE ON THE ENDPOINT SHAPE BELOW. No Cincel API reference lives in this repository or the PRD —
 * the plan only names the product and the requirement it satisfies (R25/D9). The request/response
 * shape here (`POST {baseUrl}/api/v2/documents`, multipart file + signer fields, `{ id, sign_url }`
 * back) is this module's best-effort placeholder for that integration, kept deliberately narrow and
 * isolated behind `solicitarFirma()` so the day real API docs arrive, only this one function's body
 * changes — nothing that calls it has to.
 */

export interface CincelConfig {
  baseUrl: string;
  apiKey: string;
  timeoutMs: number;
}

/** Read the config, or null when Cincel has not been provisioned yet. */
export function loadCincelConfig(): CincelConfig | null {
  const baseUrl = (process.env.CINCEL_API_URL ?? '').trim();
  const apiKey = (process.env.CINCEL_API_KEY ?? '').trim();
  if (!baseUrl || !apiKey) return null;
  const timeoutMs = Number(process.env.CINCEL_TIMEOUT_MS ?? 20_000) || 20_000;
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, timeoutMs };
}

/** Is Cincel available at all? For a UI hint, never for deciding whether a convenio can be uploaded. */
export function cincelConfigurado(): boolean {
  return loadCincelConfig() !== null;
}

export interface SolicitarFirmaInput {
  /** Our convenio id — sent as `external_id` so Cincel's dashboard/webhook can be correlated back. */
  convenioId: string;
  fileBytes: Buffer;
  fileName: string;
  signerName: string;
  signerEmail: string;
}

/**
 * What happened, in the caller's vocabulary — same three outcomes as `MailOutcome`, deliberately.
 * `omitido` always carries the reason: a row that says "not sent" with no reason is indistinguishable
 * from one nobody looked at.
 */
export type CincelOutcome =
  | { status: 'enviado'; solicitudId: string; firmaUrl: string | null }
  | { status: 'omitido'; motivo: string }
  | { status: 'error'; error: string };

const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function withTimeout<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await fn(ac.signal);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Request a signature for one convenio document. NEVER throws.
 *
 * The signer's email is validated here, not at the call site, for the same reason `sendMail`
 * validates its recipient: every caller resolves it from a `clients` row, and a malformed or missing
 * address must come back as a skipped request with a reason, not as an exception mid-write.
 */
export async function solicitarFirma(input: SolicitarFirmaInput): Promise<CincelOutcome> {
  const email = (input.signerEmail ?? '').trim();
  if (!email || !RE_EMAIL.test(email)) {
    console.warn(
      `[cincel] solicitud OMITIDA — firmante sin correo válido «${email || '(vacío)'}» · convenio ${input.convenioId}`,
    );
    return { status: 'omitido', motivo: `firmante sin correo válido: ${email || '(vacío)'}` };
  }

  const cfg = loadCincelConfig();
  if (!cfg) {
    // Loud on purpose: the operator reading the container log has to see what did not go out while
    // Cincel was unconfigured, the same posture `mailer.ts` takes for SMTP.
    console.warn(
      `[cincel] CINCEL no configurado (falta CINCEL_API_URL/CINCEL_API_KEY) — solicitud OMITIDA para convenio ${input.convenioId}`,
    );
    return { status: 'omitido', motivo: 'CINCEL no configurado (CINCEL_API_URL/CINCEL_API_KEY)' };
  }

  try {
    const form = new FormData();
    form.append('file', new Blob([input.fileBytes], { type: 'application/pdf' }), input.fileName);
    form.append('external_id', input.convenioId);
    form.append('signer_name', input.signerName);
    form.append('signer_email', email);

    const res = await withTimeout(cfg.timeoutMs, (signal) =>
      fetch(`${cfg.baseUrl}/api/v2/documents`, {
        method: 'POST',
        signal,
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        body: form,
      }),
    );

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { status: 'error', error: `CINCEL respondió ${res.status}${text ? `: ${text}` : ''}` };
    }
    const data = (await res.json().catch(() => null)) as { id?: string; sign_url?: string } | null;
    if (!data?.id) {
      return { status: 'error', error: 'CINCEL no devolvió un id de solicitud' };
    }
    console.info(`[cincel] solicitud de firma enviada · convenio ${input.convenioId} · cincel id ${data.id}`);
    return { status: 'enviado', solicitudId: data.id, firmaUrl: data.sign_url ?? null };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    console.error(`[cincel] falló la solicitud de firma para convenio ${input.convenioId}:`, error);
    return { status: 'error', error };
  }
}
