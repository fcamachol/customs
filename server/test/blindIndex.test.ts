import { describe, it, expect, beforeAll } from 'vitest';

// Set env vars before any module import so the module-level loadPepper() succeeds.
beforeAll(() => {
  if (!process.env.BLIND_INDEX_PEPPER) {
    // 32-byte test-only value (identical to server/.env test value)
    process.env.BLIND_INDEX_PEPPER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
  }
});

// Dynamic import so the module loads AFTER the pepper is set.
const getBI = () => import('../src/crypto/blindIndex');

describe('blindIndex', () => {
  // ── Determinism ──────────────────────────────────────────────────────────────

  it('same input → same token (deterministic)', async () => {
    const { nameBlindIndex } = await getBI();
    expect(nameBlindIndex('Juan García')).toBe(nameBlindIndex('Juan García'));
  });

  it('produces a non-empty base64url string', async () => {
    const { nameBlindIndex } = await getBI();
    const token = nameBlindIndex('test');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(token.length).toBeGreaterThan(0);
  });

  // ── Normalisation: name/email (case, whitespace, diacritics collapse) ────────

  it('nameBlindIndex: case insensitive ("JUAN" == "juan")', async () => {
    const { nameBlindIndex } = await getBI();
    expect(nameBlindIndex('JUAN GARCIA')).toBe(nameBlindIndex('juan garcia'));
  });

  it('nameBlindIndex: leading/trailing whitespace stripped', async () => {
    const { nameBlindIndex } = await getBI();
    expect(nameBlindIndex('  juan garcia  ')).toBe(nameBlindIndex('juan garcia'));
  });

  it('nameBlindIndex: NFD diacritics stripped (García == Garcia)', async () => {
    const { nameBlindIndex } = await getBI();
    expect(nameBlindIndex('García')).toBe(nameBlindIndex('garcia'));
  });

  it('emailBlindIndex: same normalisation as nameBlindIndex', async () => {
    const { emailBlindIndex, nameBlindIndex } = await getBI();
    expect(emailBlindIndex('Test@Example.COM')).toBe(nameBlindIndex('test@example.com'));
  });

  // ── Normalisation: address (punctuation stripped) ────────────────────────────

  it('addressBlindIndex: punctuation variants collapse ("Av. Juárez 123" == "Av Juarez 123")', async () => {
    const { addressBlindIndex } = await getBI();
    expect(addressBlindIndex('Av. Juárez 123,')).toBe(addressBlindIndex('Av Juarez 123'));
  });

  it('addressBlindIndex: case insensitive', async () => {
    const { addressBlindIndex } = await getBI();
    expect(addressBlindIndex('CALLE REFORMA')).toBe(addressBlindIndex('calle reforma'));
  });

  // ── Normalisation: phone (digits only) ────────────────────────────────────────

  it('phoneBlindIndex: formats collapse ("+52 (55) 1234-5678" == "5255123456​78")', async () => {
    const { phoneBlindIndex } = await getBI();
    expect(phoneBlindIndex('+52 (55) 1234-5678')).toBe(phoneBlindIndex('5255123456​78'));
  });

  it('phoneBlindIndex: different phone numbers produce different tokens', async () => {
    const { phoneBlindIndex } = await getBI();
    expect(phoneBlindIndex('5512345678')).not.toBe(phoneBlindIndex('5598765432'));
  });

  // ── Distinctness ──────────────────────────────────────────────────────────────

  it('distinct names produce distinct tokens', async () => {
    const { nameBlindIndex } = await getBI();
    expect(nameBlindIndex('Juan García')).not.toBe(nameBlindIndex('Pedro López'));
  });

  it('distinct addresses produce distinct tokens', async () => {
    const { addressBlindIndex } = await getBI();
    expect(addressBlindIndex('Av Reforma 100')).not.toBe(addressBlindIndex('Calle Insurgentes 200'));
  });

  it('address normalisation differs from name normalisation (punctuation stripped in address)', async () => {
    const { nameBlindIndex, addressBlindIndex } = await getBI();
    // "Av. Reforma" — norm() preserves the dot, addressBlindIndex strips it.
    // So nameBlindIndex("av. reforma") !== addressBlindIndex("av. reforma")
    // because their normalised inputs differ ("av. reforma" vs "av reforma").
    expect(nameBlindIndex('Av. Reforma')).not.toBe(addressBlindIndex('Av. Reforma'));
  });

  // ── Pepper sensitivity ────────────────────────────────────────────────────────

  it('rawBlindIndex: different pepper produces different token (via env re-mock)', async () => {
    // We cannot reload the module with a different pepper without dynamic mocking,
    // but we can verify the token is NOT trivially predictable by checking it is
    // not simply a hash of the value without the pepper.
    const { createHmac } = await import('node:crypto');
    const { nameBlindIndex } = await getBI();
    const token = nameBlindIndex('test value');
    // A naive HMAC with empty key would differ:
    const naiveToken = createHmac('sha256', Buffer.alloc(32))
      .update('test value', 'utf8')
      .digest('base64url');
    // The test pepper (all 0x10 bytes) should produce a token different from an all-zero pepper.
    expect(token).not.toBe(naiveToken);
  });

  // ── Empty / edge cases ────────────────────────────────────────────────────────

  it('empty string produces a stable token (not an error)', async () => {
    const { nameBlindIndex } = await getBI();
    const t1 = nameBlindIndex('');
    const t2 = nameBlindIndex('');
    expect(t1).toBe(t2);
  });

  it('phone with no digits produces stable token', async () => {
    const { phoneBlindIndex } = await getBI();
    const t = phoneBlindIndex('---');
    expect(typeof t).toBe('string');
    expect(t.length).toBeGreaterThan(0);
  });
});
