import { query } from '../db/pool';
import { emailBlindIndex } from '../crypto/blindIndex';

/**
 * Resolve which client a prealerta belongs to (PRD-02 R1, and the precondition for PA-08).
 *
 * `operaciones.client_id` was always NULL, which quietly blocked more than it looked like: without a
 * client there are no tariffs (R46), no delivery address (R38), no per-client monthly package (R43),
 * and no per-client parser vocabulary. So this is small but load-bearing.
 *
 * Three signals, strongest first. Order matters because the weak ones are genuinely ambiguous and must
 * never override a definite match:
 *
 *   1. the sender address against `client_platforms.email` — the platform that operates the robot IS
 *      the identity we want, and this is an exact match
 *   2. the sender address against `clients.email`
 *   3. the leading token of the subject against the platform's commercial name — real prealertas start
 *      with it ("iMile// 160-05930216 //ETD…"), and for a client whose robot sends from a shared or
 *      third-party mailbox it is the only signal there is
 *
 * Signal 3 is deliberately a NAME match, which is fuzzy by nature, so it is only consulted when the
 * address matched nothing and it is reported as the weaker `nombre_asunto` match so a human can see the
 * basis. A wrong client silently attached is worse than an unresolved one: it would price the shipment
 * against someone else's tariffs.
 */

export type ClientMatchKind = 'platform_email' | 'client_email' | 'nombre_asunto' | 'sin_resolver';

export interface ClientResolution {
  clientId: string | null;
  platformId: string | null;
  clientName: string | null;
  matchedBy: ClientMatchKind;
  /** What we matched on, recorded in the ledger so the decision is auditable. */
  evidence: string | null;
}

const UNRESOLVED: ClientResolution = {
  clientId: null,
  platformId: null,
  clientName: null,
  matchedBy: 'sin_resolver',
  evidence: null,
};

/** The leading `iMile//…` token of a real prealerta subject, if there is one. */
export function subjectClientToken(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const head = subject.split(/\/\/|\|/)[0]?.trim();
  if (!head) return null;
  // Reject anything that is plainly not a name: a guía, a bare number, or a whole sentence.
  if (/\d{6,}/.test(head)) return null;
  const words = head.split(/\s+/);
  if (words.length > 4) return null;
  return head;
}

export async function resolveClientForPrealerta(input: {
  senderEmail: string | null;
  subject: string | null;
}): Promise<ClientResolution> {
  const email = input.senderEmail?.trim().toLowerCase() || null;

  if (email) {
    // HOW THESE COLUMNS ARE ACTUALLY STORED — verified against the writers, because the answer is the
    // opposite of what the rest of the PII story would suggest.
    //
    // `client_platforms.email` and `clients.email` are PLAINTEXT `text`. Nothing encrypts or
    // blind-indexes them: migration 1700002500000 declares plain `text` and backfills the raw value
    // out of the legacy `clients.platform` jsonb, and `server/src/routes/catalogs.ts` inserts and
    // updates the value verbatim (`orNull(email)`) on every create/update path. Field encryption
    // (`encryptShipmentPii`) and the blind index are applied to SHIPMENT parties — consignee, sender,
    // platform inside `shipments.data` — not to the client catalogue, which is a small operator-
    // maintained table that the UI reads back in the clear.
    //
    // So the PLAINTEXT arm is the live one. The blind-index arm below is forward compatibility for the
    // day the catalogue follows `monthly_history` and gets blind-indexed: it costs one HMAC and cannot
    // produce a false match (a 43-char base64url token can never equal an address), and it means the
    // resolution keeps working through such a migration instead of silently returning sin_resolver for
    // every client at once. It is covered by a test that stores a token in the column on purpose.
    //
    // Compared case-insensitively on the STORED side too. The address is lowercased above, but the
    // catalogue holds whatever an operator typed ("Robot@Shein.example"), and a case difference
    // deciding whether a shipment gets a client — hence a tariff, an address and a monthly report — is
    // not a distinction anyone intends. The bidx arm stays byte-exact, since base64url IS case
    // significant.
    const bidx = emailBlindIndex(email);

    const platform = await query<{
      client_id: string;
      platform_id: string;
      client_name: string;
    }>(
      `SELECT cp.client_id, cp.id AS platform_id, c.name AS client_name
         FROM client_platforms cp
         JOIN clients c ON c.id = cp.client_id
        WHERE lower(btrim(cp.email)) = $1 OR cp.email = $2
        ORDER BY (lower(btrim(cp.email)) = $1) DESC, cp.created_at
        LIMIT 1`,
      [email, bidx],
    );
    if (platform.rows.length) {
      const r = platform.rows[0];
      return {
        clientId: r.client_id,
        platformId: r.platform_id,
        clientName: r.client_name,
        matchedBy: 'platform_email',
        evidence: email,
      };
    }

    const client = await query<{ id: string; name: string }>(
      `SELECT id, name FROM clients
        WHERE lower(btrim(email)) = $1 OR email = $2
        ORDER BY (lower(btrim(email)) = $1) DESC, created_at
        LIMIT 1`,
      [email, bidx],
    );
    if (client.rows.length) {
      return {
        clientId: client.rows[0].id,
        platformId: null,
        clientName: client.rows[0].name,
        matchedBy: 'client_email',
        evidence: email,
      };
    }
  }

  const token = subjectClientToken(input.subject);
  if (token) {
    // Exact, case-insensitive match on either the client name or a platform's commercial name. Kept
    // deliberately strict — no fuzzy containment — because this is the weakest signal and attaching the
    // WRONG client is worse than attaching none: it would price the shipment against someone else's
    // tariffs and put it in someone else's monthly report to the authority.
    const byName = await query<{
      client_id: string;
      platform_id: string | null;
      client_name: string;
    }>(
      `SELECT c.id AS client_id, cp.id AS platform_id, c.name AS client_name
         FROM clients c
         LEFT JOIN client_platforms cp ON cp.client_id = c.id
        WHERE lower(btrim(c.name)) = lower(btrim($1))
           OR lower(btrim(COALESCE(cp.commercial_name, ''))) = lower(btrim($1))
        ORDER BY (cp.id IS NOT NULL) DESC
        LIMIT 1`,
      [token],
    );
    if (byName.rows.length) {
      const r = byName.rows[0];
      return {
        clientId: r.client_id,
        platformId: r.platform_id,
        clientName: r.client_name,
        matchedBy: 'nombre_asunto',
        evidence: token,
      };
    }
  }

  return { ...UNRESOLVED, evidence: email ?? token ?? null };
}
