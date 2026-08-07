import { beforeEach, describe, expect, it } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import { emailBlindIndex } from '../../src/crypto/blindIndex';
import { resolveClientForPrealerta, subjectClientToken } from '../../src/services/clientResolution';

/**
 * Client resolution from a prealerta (PRD-02 R1, and the precondition for PA-08).
 *
 * What these tests actually defend is the ORDER of the three signals and the strictness of the weakest
 * one. Attaching the WRONG client is worse than attaching none: the shipment would be priced against
 * someone else's tariffs, delivered to someone else's address and reported in someone else's monthly
 * report to the authority. So a definite address match must always beat a name guess, and a name guess
 * must refuse anything that is not plainly a commercial name.
 *
 * Real DB, no network — the queries themselves (including their case handling) are the thing under
 * test, so a mocked pool would test nothing.
 */

async function seedClient(name: string, email?: string | null): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO clients (name, email) VALUES ($1,$2) RETURNING id`,
    [name, email ?? null],
  );
  return rows[0].id;
}

async function seedPlatform(
  clientId: string,
  over: { commercialName?: string | null; email?: string | null } = {},
): Promise<string> {
  const { rows } = await query<{ id: string }>(
    `INSERT INTO client_platforms (client_id, commercial_name, email) VALUES ($1,$2,$3) RETURNING id`,
    [clientId, over.commercialName ?? null, over.email ?? null],
  );
  return rows[0].id;
}

beforeEach(truncateAll);

describe('subjectClientToken — what counts as a name in a subject line', () => {
  it('takes the leading token of a real prealerta subject', () => {
    expect(subjectClientToken('iMile// 160-05930216 //ETD 2026-08-16')).toBe('iMile');
    expect(subjectClientToken('SHEIN | 160-94705516')).toBe('SHEIN');
  });

  it('rejects a head that is a guía or otherwise carries a long digit run', () => {
    // "160-05930216 // iMile" is the same subject written the other way round. Treating the guía as a
    // client name would attach the caso to whatever client happened to be named like a number.
    expect(subjectClientToken('160-05930216 // iMile')).toBeNull();
    expect(subjectClientToken('Prealert 160-94705516')).toBeNull();
  });

  it('rejects a head that is a sentence rather than a name', () => {
    expect(
      subjectClientToken('Please find attached the prealert for tomorrow'),
    ).toBeNull();
    // Exactly at the limit is still a name; one word past it is prose.
    expect(subjectClientToken('Alpha Beta Gamma Delta')).toBe('Alpha Beta Gamma Delta');
    expect(subjectClientToken('Alpha Beta Gamma Delta Epsilon')).toBeNull();
  });

  it('returns null for nothing at all', () => {
    expect(subjectClientToken(null)).toBeNull();
    expect(subjectClientToken('')).toBeNull();
    expect(subjectClientToken('   //  ')).toBeNull();
  });
});

describe('resolveClientForPrealerta — the platform address wins', () => {
  it('prefers the platform email over a clients.email pointing somewhere else', async () => {
    // The platform that operates the robot IS the identity we want; a clients.email row carrying the
    // same address is the weaker statement and must not win. This is the ordering that stops a shared
    // mailbox from silently re-attributing another client's cargo.
    const otro = await seedClient('Otro Cliente', 'robot@shein.example');
    const dueno = await seedClient('SHEIN MX');
    const platformId = await seedPlatform(dueno, {
      commercialName: 'SHEIN',
      email: 'robot@shein.example',
    });

    const r = await resolveClientForPrealerta({
      senderEmail: 'robot@shein.example',
      subject: 'SHEIN// 160-94705516',
    });
    expect(r.matchedBy).toBe('platform_email');
    expect(r.clientId).toBe(dueno);
    expect(r.clientId).not.toBe(otro);
    expect(r.platformId).toBe(platformId);
    expect(r.clientName).toBe('SHEIN MX');
    expect(r.evidence).toBe('robot@shein.example');
  });

  it('matches regardless of the case the operator typed into the catalogue', async () => {
    // client_platforms.email is plaintext text the UI writes verbatim, so it holds whatever was typed.
    // A capital letter deciding whether a shipment gets a client is not a distinction anyone intends.
    const id = await seedClient('SHEIN MX');
    await seedPlatform(id, { email: '  Robot@Shein.Example ' });
    const r = await resolveClientForPrealerta({
      senderEmail: 'ROBOT@shein.example',
      subject: null,
    });
    expect(r.matchedBy).toBe('platform_email');
    expect(r.clientId).toBe(id);
  });

  it('still resolves if the catalogue is ever migrated to blind-indexed emails', async () => {
    // Forward compatibility, tested on purpose by storing a token in the column. Today the column is
    // plaintext (verified against catalogs.ts and migration 1700002500000); if it follows
    // monthly_history and gets blind-indexed, resolution must keep working rather than returning
    // sin_resolver for every client at once.
    const id = await seedClient('Cliente Cifrado');
    await seedPlatform(id, { email: emailBlindIndex('robot@imile.example') });
    const r = await resolveClientForPrealerta({
      senderEmail: 'robot@imile.example',
      subject: null,
    });
    expect(r.matchedBy).toBe('platform_email');
    expect(r.clientId).toBe(id);
  });
});

describe('resolveClientForPrealerta — clients.email is the second signal', () => {
  it('resolves by the client address when no platform carries it', async () => {
    const id = await seedClient('iMile', 'ops@imile.example');
    await seedPlatform(id, { commercialName: 'iMile', email: 'otro@imile.example' });
    const r = await resolveClientForPrealerta({
      senderEmail: 'ops@imile.example',
      subject: 'iMile// 160-05930216',
    });
    expect(r.matchedBy).toBe('client_email');
    expect(r.clientId).toBe(id);
    // No platform is claimed: the address matched the client, not one of its platforms.
    expect(r.platformId).toBeNull();
  });
});

describe('resolveClientForPrealerta — the subject name is the last resort', () => {
  it('matches the client name exactly, case-insensitively, and reports the weak basis', async () => {
    const id = await seedClient('iMile');
    const r = await resolveClientForPrealerta({
      senderEmail: 'unknown-robot@third-party.example',
      subject: 'iMile// 160-05930216 //ETD 2026-08-16',
    });
    expect(r.matchedBy).toBe('nombre_asunto');
    expect(r.clientId).toBe(id);
    expect(r.evidence).toBe('iMile');
  });

  it("matches a platform's commercial name too, and prefers the platform row", async () => {
    const id = await seedClient('iMile Logistics MX');
    const platformId = await seedPlatform(id, { commercialName: 'iMile' });
    const r = await resolveClientForPrealerta({
      senderEmail: null,
      subject: 'IMILE // 160-05930216',
    });
    expect(r.matchedBy).toBe('nombre_asunto');
    expect(r.clientId).toBe(id);
    expect(r.platformId).toBe(platformId);
  });

  it('refuses a partial name, because a wrong client is worse than no client', async () => {
    await seedClient('iMile');
    const r = await resolveClientForPrealerta({
      senderEmail: null,
      subject: 'iMile Express// 160-05930216',
    });
    // "iMile Express" is a plausible name and still not this client's. No fuzzy containment.
    expect(r.matchedBy).toBe('sin_resolver');
    expect(r.clientId).toBeNull();
  });

  it('does not consult the subject at all when the address already resolved', async () => {
    // A subject naming a different client must never override a definite address match.
    const porCorreo = await seedClient('SHEIN MX', 'robot@shein.example');
    await seedClient('iMile');
    const r = await resolveClientForPrealerta({
      senderEmail: 'robot@shein.example',
      subject: 'iMile// 160-05930216',
    });
    expect(r.matchedBy).toBe('client_email');
    expect(r.clientId).toBe(porCorreo);
  });

  it('does not resolve from a subject whose head is a guía', async () => {
    await seedClient('160');
    const r = await resolveClientForPrealerta({
      senderEmail: null,
      subject: '160-05930216 // carga urgente',
    });
    expect(r.matchedBy).toBe('sin_resolver');
  });
});

describe('resolveClientForPrealerta — unresolved is a first-class outcome', () => {
  it('returns sin_resolver and keeps the address as evidence for PA-08', async () => {
    await seedClient('SHEIN MX', 'otra@shein.example');
    const r = await resolveClientForPrealerta({
      senderEmail: 'desconocido@nuevo.example',
      subject: 'Prealert 160-94705516',
    });
    expect(r).toEqual({
      clientId: null,
      platformId: null,
      clientName: null,
      matchedBy: 'sin_resolver',
      // Recorded so the human who registers the mailbox does not have to go find the email again.
      evidence: 'desconocido@nuevo.example',
    });
  });

  it('falls back to the rejected-but-present subject token as evidence when there was no address', async () => {
    const r = await resolveClientForPrealerta({ senderEmail: null, subject: 'Tienda Nueva// 160-1' });
    expect(r.matchedBy).toBe('sin_resolver');
    expect(r.evidence).toBe('Tienda Nueva');
  });

  it('resolves nothing at all from an empty prealerta', async () => {
    const r = await resolveClientForPrealerta({ senderEmail: '  ', subject: null });
    expect(r.matchedBy).toBe('sin_resolver');
    expect(r.evidence).toBeNull();
  });

  it('does not match a NULL catalogue email against a missing sender', async () => {
    // The trap: `email = NULL` never matches, but a resolver that coalesced NULL to '' would attach
    // every unidentified prealerta to whichever client has no email on file.
    await seedClient('Sin Correo', null);
    await seedPlatform((await query<{ id: string }>('SELECT id FROM clients LIMIT 1')).rows[0].id, {
      email: null,
    });
    const r = await resolveClientForPrealerta({ senderEmail: null, subject: null });
    expect(r.matchedBy).toBe('sin_resolver');
    expect(r.clientId).toBeNull();
  });
});
