import { describe, it, expect, beforeAll } from 'vitest';
import type { ConsigneeData, SenderData, PlatformData, Shipment } from '../../shared/types/shipment';

// Set env vars before any module import so module-level key/pepper loading succeeds.
beforeAll(() => {
  if (!process.env.FIELD_ENCRYPTION_KEY) {
    process.env.FIELD_ENCRYPTION_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
  }
  if (!process.env.BLIND_INDEX_PEPPER) {
    process.env.BLIND_INDEX_PEPPER = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=';
  }
});

// Dynamic imports so modules are loaded AFTER env vars are set above.
const getCrypto = () => import('../src/crypto/fieldCrypto');

// ── Primitive helpers ─────────────────────────────────────────────────────────

describe('fieldCrypto – encryptField / decryptField', () => {
  it('round-trips a plaintext value', async () => {
    const { encryptField, decryptField } = await getCrypto();
    const plain = 'GODE801231ABC';
    expect(decryptField(encryptField(plain))).toBe(plain);
  });

  it('ciphertext is not equal to plaintext', async () => {
    const { encryptField } = await getCrypto();
    expect(encryptField('GODE801231ABC')).not.toBe('GODE801231ABC');
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

// ── encryptConsignee / decryptConsignee ───────────────────────────────────────

describe('fieldCrypto – encryptConsignee / decryptConsignee', () => {
  const base: ConsigneeData = {
    name: 'Juan García',
    rfc: 'GODE801231ABC',
    curp: 'GODE801231HDFGRC01',
    passport: 'A1234567',
    foreignTaxId: 'FT-999',
    socialSecurity: 'SS-888',
    address: 'Av. Reforma 100, CDMX',
    phone: '5512345678',
    email: 'juan@example.com',
    city: 'CDMX',
    postalCode: '06600',
    countryCode: 'MX',
    countryName: 'México',
  };

  it('round-trips ALL consignee fields (identity + contact)', async () => {
    const { encryptConsignee, decryptConsignee } = await getCrypto();
    const enc = encryptConsignee(base);
    const dec = decryptConsignee(enc);
    // All PII fields should decrypt back to original
    expect(dec.name).toBe(base.name);
    expect(dec.rfc).toBe(base.rfc);
    expect(dec.curp).toBe(base.curp);
    expect(dec.passport).toBe(base.passport);
    expect(dec.foreignTaxId).toBe(base.foreignTaxId);
    expect(dec.socialSecurity).toBe(base.socialSecurity);
    expect(dec.address).toBe(base.address);
    expect(dec.phone).toBe(base.phone);
    expect(dec.email).toBe(base.email);
    expect(dec.city).toBe(base.city);
    expect(dec.postalCode).toBe(base.postalCode);
    // Non-PII fields preserved
    expect(dec.countryCode).toBe(base.countryCode);
    expect(dec.countryName).toBe(base.countryName);
  });

  it('encrypts contact fields (name/address/email/phone/city/postalCode)', async () => {
    const { encryptConsignee } = await getCrypto();
    const enc = encryptConsignee(base);
    expect(enc.name).toMatch(/^v1:/);
    expect(enc.address).toMatch(/^v1:/);
    expect(enc.email).toMatch(/^v1:/);
    expect(enc.phone).toMatch(/^v1:/);
    expect(enc.city).toMatch(/^v1:/);
    expect(enc.postalCode).toMatch(/^v1:/);
  });

  it('attaches nameBidx and addressBidx sidecars before encryption', async () => {
    const { encryptConsignee } = await getCrypto();
    const enc = encryptConsignee(base);
    expect(typeof enc.nameBidx).toBe('string');
    expect(enc.nameBidx!.length).toBeGreaterThan(0);
    expect(typeof enc.addressBidx).toBe('string');
    expect(enc.addressBidx!.length).toBeGreaterThan(0);
  });

  it('nameBidx is deterministic (same name → same sidecar)', async () => {
    const { encryptConsignee } = await getCrypto();
    const enc1 = encryptConsignee(base);
    const enc2 = encryptConsignee(base);
    expect(enc1.nameBidx).toBe(enc2.nameBidx);
    expect(enc1.addressBidx).toBe(enc2.addressBidx);
  });

  it('idempotent: re-encrypting a v1:-prefixed consignee is a no-op', async () => {
    const { encryptConsignee, decryptConsignee } = await getCrypto();
    const enc1 = encryptConsignee(base);
    const enc2 = encryptConsignee(enc1); // second encrypt pass
    const dec = decryptConsignee(enc2);
    expect(dec.name).toBe(base.name);
    expect(dec.rfc).toBe(base.rfc);
  });

  it('decryptConsignee is passthrough for non-v1 fields (backward-compat)', async () => {
    const { decryptConsignee } = await getCrypto();
    const plain: ConsigneeData = { ...base };
    const dec = decryptConsignee(plain);
    expect(dec.name).toBe(base.name); // no-op: not encrypted
  });
});

// ── encryptSender / decryptSender ─────────────────────────────────────────────

describe('fieldCrypto – encryptSender / decryptSender', () => {
  const sender: SenderData = {
    name: 'Shenzhen Electronics Ltd.',
    taxId: 'CN-TAX-123',
    address: '1 Shenzhen Rd, Guangdong',
    phone: '+861012345678',
    email: 'orders@szelectronics.cn',
    city: 'Shenzhen',
    cityCode: 'SZX',
    countryCode: 'CN',
    countryName: 'China',
  };

  it('round-trips sender PII fields (name/address/email/phone/city)', async () => {
    const { encryptSender, decryptSender } = await getCrypto();
    const enc = encryptSender(sender);
    const dec = decryptSender(enc);
    expect(dec.name).toBe(sender.name);
    expect(dec.address).toBe(sender.address);
    expect(dec.phone).toBe(sender.phone);
    expect(dec.email).toBe(sender.email);
    expect(dec.city).toBe(sender.city);
    // Non-PII fields preserved
    expect(dec.taxId).toBe(sender.taxId);
    expect(dec.cityCode).toBe(sender.cityCode);
    expect(dec.countryCode).toBe(sender.countryCode);
    expect(dec.countryName).toBe(sender.countryName);
  });

  it('encrypts sender contact fields', async () => {
    const { encryptSender } = await getCrypto();
    const enc = encryptSender(sender);
    expect(enc.name).toMatch(/^v1:/);
    expect(enc.address).toMatch(/^v1:/);
    expect(enc.email).toMatch(/^v1:/);
    expect(enc.phone).toMatch(/^v1:/);
    expect(enc.city).toMatch(/^v1:/);
  });

  it('idempotent: re-encrypting sender is a no-op', async () => {
    const { encryptSender, decryptSender } = await getCrypto();
    const enc1 = encryptSender(sender);
    const enc2 = encryptSender(enc1);
    expect(decryptSender(enc2).name).toBe(sender.name);
  });

  it('does NOT encrypt taxId (not a PII contact field)', async () => {
    const { encryptSender } = await getCrypto();
    const enc = encryptSender(sender);
    expect(enc.taxId).toBe(sender.taxId);
  });
});

// ── encryptPlatform / decryptPlatform ─────────────────────────────────────────

describe('fieldCrypto – encryptPlatform / decryptPlatform', () => {
  const platform: PlatformData = {
    commercialName: 'AliExpress',
    countryOfOrigin: 'CN',
    legalName: 'Alibaba Group',
    email: 'marketplace@aliexpress.com',
    url: 'https://aliexpress.com',
  };

  it('round-trips platform email field', async () => {
    const { encryptPlatform, decryptPlatform } = await getCrypto();
    const enc = encryptPlatform(platform);
    const dec = decryptPlatform(enc);
    expect(dec.email).toBe(platform.email);
  });

  it('encrypts platform.email', async () => {
    const { encryptPlatform } = await getCrypto();
    const enc = encryptPlatform(platform);
    expect(enc.email).toMatch(/^v1:/);
  });

  it('does NOT encrypt non-PII platform fields', async () => {
    const { encryptPlatform } = await getCrypto();
    const enc = encryptPlatform(platform);
    expect(enc.commercialName).toBe(platform.commercialName);
    expect(enc.countryOfOrigin).toBe(platform.countryOfOrigin);
    expect(enc.legalName).toBe(platform.legalName);
    expect(enc.url).toBe(platform.url);
  });

  it('idempotent: re-encrypting platform is a no-op', async () => {
    const { encryptPlatform, decryptPlatform } = await getCrypto();
    const enc1 = encryptPlatform(platform);
    const enc2 = encryptPlatform(enc1);
    expect(decryptPlatform(enc2).email).toBe(platform.email);
  });
});

// ── encryptShipmentPii / decryptShipment ──────────────────────────────────────

describe('fieldCrypto – encryptShipmentPii / decryptShipment', () => {
  const makeShipment = (): Shipment => ({
    id: 'ship-001',
    mawbReference: 'MAWB-123',
    guideId: 'G001',
    description: 'Electronics',
    hsCode: '8471.30',
    quantity: 1,
    unit: 'PZA',
    customsValueUsd: 499.99,
    currency: 'USD',
    originCountry: 'CN',
    consignee: {
      name: 'Ana López',
      rfc: 'LOPA900101XYZ',
      address: 'Calle 5 No. 10',
      phone: '5512345678',
      email: 'ana@example.com',
      city: 'Monterrey',
      postalCode: '64000',
    },
    sender: {
      name: 'SZ Trade Co.',
      address: '88 Huaqiangbei Rd',
      phone: '+8618012345678',
      email: 'trade@sztrade.cn',
      city: 'Shenzhen',
    },
    platform: {
      commercialName: 'MercadoExpress',
      email: 'ops@mercadoexpress.com',
    },
  });

  it('decryptShipment round-trips all encrypted fields on consignee/sender/platform', async () => {
    const { encryptShipmentPii, decryptShipment } = await getCrypto();
    const orig = makeShipment();
    const enc = encryptShipmentPii(orig);
    const dec = decryptShipment(enc);

    // consignee
    expect(dec.consignee.name).toBe(orig.consignee.name);
    expect(dec.consignee.address).toBe(orig.consignee.address);
    expect(dec.consignee.phone).toBe(orig.consignee.phone);
    expect(dec.consignee.email).toBe(orig.consignee.email);
    expect(dec.consignee.city).toBe(orig.consignee.city);
    expect(dec.consignee.postalCode).toBe(orig.consignee.postalCode);
    // sender
    expect(dec.sender.name).toBe(orig.sender.name);
    expect(dec.sender.address).toBe(orig.sender.address);
    expect(dec.sender.phone).toBe(orig.sender.phone);
    expect(dec.sender.email).toBe(orig.sender.email);
    expect(dec.sender.city).toBe(orig.sender.city);
    // platform
    expect(dec.platform.email).toBe(orig.platform.email);
    // non-PII
    expect(dec.platform.commercialName).toBe(orig.platform.commercialName);
  });

  it('encryptShipmentPii attaches consignee blind-index sidecars', async () => {
    const { encryptShipmentPii } = await getCrypto();
    const enc = encryptShipmentPii(makeShipment());
    expect(typeof enc.consignee.nameBidx).toBe('string');
    expect(enc.consignee.nameBidx!.length).toBeGreaterThan(0);
    expect(typeof enc.consignee.addressBidx).toBe('string');
  });

  it('promote path: double-encrypt is idempotent (v1: guard)', async () => {
    const { encryptShipmentPii, decryptShipment } = await getCrypto();
    const orig = makeShipment();
    const enc1 = encryptShipmentPii(orig);
    const enc2 = encryptShipmentPii(enc1); // simulate a second pass on promote
    const dec = decryptShipment(enc2);
    expect(dec.consignee.name).toBe(orig.consignee.name);
    expect(dec.sender.name).toBe(orig.sender.name);
    expect(dec.platform.email).toBe(orig.platform.email);
  });

  it('decryptShipment is passthrough for already-plaintext fields (backward-compat)', async () => {
    const { decryptShipment } = await getCrypto();
    const plain = makeShipment(); // no v1: prefix anywhere
    const dec = decryptShipment(plain);
    expect(dec.consignee.name).toBe(plain.consignee.name);
    expect(dec.sender.name).toBe(plain.sender.name);
    expect(dec.platform.email).toBe(plain.platform.email);
  });

  it('decryptShipment covers sender.address (used in risk.ts senderCity)', async () => {
    const { encryptShipmentPii, decryptShipment } = await getCrypto();
    const enc = encryptShipmentPii(makeShipment());
    expect(enc.sender.address).toMatch(/^v1:/);
    const dec = decryptShipment(enc);
    expect(dec.sender.address).toBe('88 Huaqiangbei Rd');
  });
});
