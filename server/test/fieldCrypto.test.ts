import { describe, it, expect, beforeAll } from 'vitest';

// Ensure key is present before importing the module under test
beforeAll(() => {
  // 32-byte key encoded in base64 (test-only – never use in production)
  if (!process.env.FIELD_ENCRYPTION_KEY) {
    process.env.FIELD_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  }
});

// Dynamic import so the module is loaded AFTER the key is set above
const getCrypto = () => import('../src/crypto/fieldCrypto');

describe('fieldCrypto', () => {
  it('round-trips a plaintext value', async () => {
    const { encryptField, decryptField } = await getCrypto();
    const plain = 'GODE801231ABC';
    expect(decryptField(encryptField(plain))).toBe(plain);
  });

  it('ciphertext is not equal to plaintext', async () => {
    const { encryptField } = await getCrypto();
    const plain = 'GODE801231ABC';
    expect(encryptField(plain)).not.toBe(plain);
  });

  it('encrypting the same value twice yields different ciphertexts (random IV)', async () => {
    const { encryptField } = await getCrypto();
    const plain = 'GODE801231ABC';
    expect(encryptField(plain)).not.toBe(encryptField(plain));
  });

  it('ciphertext starts with v1:', async () => {
    const { encryptField } = await getCrypto();
    expect(encryptField('test')).toMatch(/^v1:/);
  });

  it('decryptField is a passthrough for non-v1 values (backward-compat)', async () => {
    const { decryptField } = await getCrypto();
    expect(decryptField('plain-not-v1')).toBe('plain-not-v1');
    expect(decryptField('')).toBe('');
  });
});
