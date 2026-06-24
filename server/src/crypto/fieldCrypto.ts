/**
 * Field-level AES-256-GCM encryption for PII at rest (RNF-03/08).
 *
 * Key source: FIELD_ENCRYPTION_KEY environment variable – a base64-encoded 32-byte key.
 * Generate with:  openssl rand -base64 32
 *
 * Ciphertext format:  v1:<iv_b64>:<tag_b64>:<ct_b64>
 *   iv  – 12 bytes (96-bit), random per encryption
 *   tag – 16 bytes GCM authentication tag
 *   ct  – ciphertext (same length as plaintext)
 *
 * decryptField is a passthrough for values that do NOT start with "v1:" so that
 * records written before encryption was deployed can still be read.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { ConsigneeData, SenderData, PlatformData, Shipment } from '../../../shared/types/shipment';
import { nameBlindIndex, addressBlindIndex } from './blindIndex';

const KEY_ENV = 'FIELD_ENCRYPTION_KEY';
const IV_LENGTH = 12; // 96-bit IV recommended for AES-GCM
const TAG_LENGTH = 16; // 128-bit authentication tag

function loadKey(): Buffer {
  const raw = process.env[KEY_ENV];
  if (!raw) {
    throw new Error(
      `[fieldCrypto] ${KEY_ENV} is not set. ` +
      'Generate a key with: openssl rand -base64 32',
    );
  }
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `[fieldCrypto] ${KEY_ENV} must decode to exactly 32 bytes (got ${key.length}). ` +
      'Generate a key with: openssl rand -base64 32',
    );
  }
  return key;
}

// Load once at module initialisation – throws clearly if key is absent/invalid.
const KEY: Buffer = loadKey();

/**
 * Encrypt a plaintext string field.
 * Returns "v1:<iv_b64>:<tag_b64>:<ct_b64>".
 */
export function encryptField(plain: string): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

/**
 * Decrypt a value previously returned by encryptField.
 * If the value does NOT start with "v1:" it is returned as-is (passthrough /
 * backward-compatible with plaintext records written before encryption was enabled).
 */
export function decryptField(enc: string): string {
  if (!enc.startsWith('v1:')) return enc;
  const parts = enc.split(':');
  // Format: v1 : iv_b64 : tag_b64 : ct_b64  (4 segments; ct may itself contain ':' in future, take from index 3 onward)
  if (parts.length < 4) {
    throw new Error('[fieldCrypto] Malformed ciphertext: expected v1:<iv>:<tag>:<ct>');
  }
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts.slice(3).join(':'), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Shipment PII helpers
// ---------------------------------------------------------------------------

/**
 * The five consignee identity fields that are encrypted at rest.
 * Contact fields (name/address/email/phone/city/postalCode) are ALSO encrypted now
 * (F20a) – blind-index sidecars preserve dedup capability without plaintext at rest.
 */
const CONSIGNEE_IDENTITY_FIELDS: ReadonlyArray<keyof ConsigneeData> = [
  'rfc', 'curp', 'passport', 'foreignTaxId', 'socialSecurity',
];

/** Contact fields on ConsigneeData that are encrypted (F20a). */
const CONSIGNEE_CONTACT_FIELDS: ReadonlyArray<keyof ConsigneeData> = [
  'name', 'address', 'email', 'phone', 'city', 'postalCode',
];

/** All ConsigneeData fields that are encrypted. */
const CONSIGNEE_PII_FIELDS: ReadonlyArray<keyof ConsigneeData> = [
  ...CONSIGNEE_IDENTITY_FIELDS,
  ...CONSIGNEE_CONTACT_FIELDS,
];

/** SenderData fields that are encrypted (F20a). */
const SENDER_PII_FIELDS: ReadonlyArray<keyof SenderData> = [
  'name', 'address', 'email', 'phone', 'city',
];

/** PlatformData fields that are encrypted (F20a). */
const PLATFORM_PII_FIELDS: ReadonlyArray<keyof PlatformData> = [
  'email',
];

/** Encrypt a subset of fields on an object (returns shallow copy). Idempotent: v1: values are skipped. */
function encryptFields<T extends object>(obj: T, fields: ReadonlyArray<keyof T>): T {
  const out = { ...obj };
  for (const field of fields) {
    const val = (out as Record<keyof T, unknown>)[field];
    if (typeof val === 'string' && val.length > 0 && !val.startsWith('v1:')) {
      (out as Record<keyof T, unknown>)[field] = encryptField(val);
    }
  }
  return out;
}

/** Decrypt a subset of fields on an object (returns shallow copy). Passthrough for non-v1: values. */
function decryptFields<T extends object>(obj: T, fields: ReadonlyArray<keyof T>): T {
  const out = { ...obj };
  for (const field of fields) {
    const val = (out as Record<keyof T, unknown>)[field];
    if (typeof val === 'string' && val.startsWith('v1:')) {
      (out as Record<keyof T, unknown>)[field] = decryptField(val);
    }
  }
  return out;
}

/** Encrypt ALL PII fields on a consignee object + attach blind-index sidecars (returns shallow copy). */
export function encryptConsignee(consignee: ConsigneeData): ConsigneeData {
  // Compute blind-index sidecars from PLAINTEXT before encryption.
  const nameBidx = consignee.name ? nameBlindIndex(consignee.name) : undefined;
  const addressBidx = consignee.address ? addressBlindIndex(consignee.address) : undefined;
  const encrypted = encryptFields(consignee, CONSIGNEE_PII_FIELDS);
  return { ...encrypted, ...(nameBidx !== undefined ? { nameBidx } : {}), ...(addressBidx !== undefined ? { addressBidx } : {}) };
}

/** Decrypt ALL PII fields on a consignee object (returns shallow copy). */
export function decryptConsignee(consignee: ConsigneeData): ConsigneeData {
  return decryptFields(consignee, CONSIGNEE_PII_FIELDS);
}

/** Encrypt PII fields on a sender object (returns shallow copy). Idempotent. */
export function encryptSender(sender: SenderData): SenderData {
  return encryptFields(sender, SENDER_PII_FIELDS);
}

/** Decrypt PII fields on a sender object (returns shallow copy). Passthrough for plaintext. */
export function decryptSender(sender: SenderData): SenderData {
  return decryptFields(sender, SENDER_PII_FIELDS);
}

/** Encrypt PII fields on a platform object (returns shallow copy). Idempotent. */
export function encryptPlatform(platform: PlatformData): PlatformData {
  return encryptFields(platform, PLATFORM_PII_FIELDS);
}

/** Decrypt PII fields on a platform object (returns shallow copy). Passthrough for plaintext. */
export function decryptPlatform(platform: PlatformData): PlatformData {
  return decryptFields(platform, PLATFORM_PII_FIELDS);
}

/**
 * Encrypt all PII fields on a shipment (consignee + sender + platform).
 * Attaches blind-index sidecars on consignee from plaintext before encryption.
 * Returns a new Shipment – the original is not mutated.
 */
export function encryptShipmentPii(s: Shipment): Shipment {
  return {
    ...s,
    consignee: encryptConsignee(s.consignee),
    sender: encryptSender(s.sender),
    platform: encryptPlatform(s.platform),
  };
}

/**
 * Return a new Shipment with ALL encrypted PII decrypted (consignee + sender + platform).
 * Safe to pass to scoring / export / display paths.
 */
export function decryptShipment(s: Shipment): Shipment {
  return {
    ...s,
    consignee: decryptConsignee(s.consignee),
    sender: decryptSender(s.sender),
    platform: decryptPlatform(s.platform),
  };
}
