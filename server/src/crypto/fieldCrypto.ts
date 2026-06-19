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
import type { ConsigneeData, Shipment } from '../../../shared/types/shipment';

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
 * Do NOT include name/address/email/phone – those must stay plaintext for
 * the risk engine's dedup checks (V4/V5/V8).
 */
const PII_FIELDS: ReadonlyArray<keyof ConsigneeData> = [
  'rfc', 'curp', 'passport', 'foreignTaxId', 'socialSecurity',
];

/** Encrypt PII fields on a consignee object (returns shallow copy). */
export function encryptConsignee(consignee: ConsigneeData): ConsigneeData {
  const out: ConsigneeData = { ...consignee };
  for (const field of PII_FIELDS) {
    const val = out[field];
    if (typeof val === 'string' && val.length > 0 && !val.startsWith('v1:')) {
      (out as Record<keyof ConsigneeData, unknown>)[field] = encryptField(val);
    }
  }
  return out;
}

/** Decrypt PII fields on a consignee object (returns shallow copy). */
export function decryptConsignee(consignee: ConsigneeData): ConsigneeData {
  const out: ConsigneeData = { ...consignee };
  for (const field of PII_FIELDS) {
    const val = out[field];
    if (typeof val === 'string' && val.startsWith('v1:')) {
      (out as Record<keyof ConsigneeData, unknown>)[field] = decryptField(val);
    }
  }
  return out;
}

/** Return a new Shipment with decrypted consignee PII (safe to pass to scoring / export). */
export function decryptShipment(s: Shipment): Shipment {
  return { ...s, consignee: decryptConsignee(s.consignee) };
}
