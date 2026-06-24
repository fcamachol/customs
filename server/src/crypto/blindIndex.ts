/**
 * Blind-index (HMAC-SHA256) helpers for deterministic PII dedup tokens.
 *
 * Instead of storing raw plaintext name/address/email/phone (needed for dedup),
 * we store a keyed HMAC over the normalised value so cross-manifest recurrence
 * can be detected without ever writing PII in the clear.
 *
 * Key source: BLIND_INDEX_PEPPER environment variable – a base64-encoded 32-byte key.
 * Keep it SEPARATE from FIELD_ENCRYPTION_KEY so the two can be rotated independently.
 * Generate with:  openssl rand -base64 32
 *
 * Token format: base64url(HMAC-SHA256(BLIND_INDEX_PEPPER, normalised(value)))
 *   – URL-safe base64 (no +/=) so the token is safe in DB indices and URLs.
 *   – Deterministic: identical normalised inputs always produce the same token for
 *     the same pepper (dedup-safe).
 *   – Opaque: computationally infeasible to reverse without the pepper (PII-safe).
 *
 * Per-field normalisation mirrors the exact same logic used for entity keying
 * in the risk engine (shared/risk/normalize.ts `norm`) plus field-specific rules:
 *   nameBlindIndex  / emailBlindIndex : norm() only (lower+trim+NFD-strip)
 *   addressBlindIndex                 : norm() + strip punctuation
 *   phoneBlindIndex                   : digits only
 */

import { createHmac } from 'node:crypto';
import { norm } from '../../../shared/risk/normalize';

const PEPPER_ENV = 'BLIND_INDEX_PEPPER';

function loadPepper(): Buffer {
  const raw = process.env[PEPPER_ENV];
  if (!raw) {
    throw new Error(
      `[blindIndex] ${PEPPER_ENV} is not set. ` +
      'Generate a key with: openssl rand -base64 32',
    );
  }
  const pepper = Buffer.from(raw, 'base64');
  if (pepper.length !== 32) {
    throw new Error(
      `[blindIndex] ${PEPPER_ENV} must decode to exactly 32 bytes (got ${pepper.length}). ` +
      'Generate a key with: openssl rand -base64 32',
    );
  }
  return pepper;
}

// Load once at module initialisation – throws clearly if pepper is absent/invalid.
const PEPPER: Buffer = loadPepper();

/** Compute base64url(HMAC-SHA256(pepper, value)) */
function hmacB64url(value: string): string {
  return createHmac('sha256', PEPPER)
    .update(value, 'utf8')
    .digest('base64url');
}

// ---------------------------------------------------------------------------
// Per-field normaliser helpers
// ---------------------------------------------------------------------------

/** Strip all punctuation (non-alphanumeric, non-space) from an already-normed string. */
const PUNCTUATION_RE = /[^\p{L}\p{N}\s]/gu;

function normAddress(s: string): string {
  return norm(s).replace(PUNCTUATION_RE, '').replace(/\s+/g, ' ').trim();
}

function normPhone(s: string): string {
  return (s ?? '').replace(/\D/g, '');
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/**
 * Blind index for a consignee/sender name or email.
 * Normalisation: lower + trim + NFD-strip (identical to risk engine entity keying).
 */
export function nameBlindIndex(value: string): string {
  return hmacB64url(norm(value));
}

/** Alias – same normalisation as name. */
export const emailBlindIndex = nameBlindIndex;

/**
 * Blind index for an address.
 * Normalisation: norm() + strip punctuation (reduces formatting variants).
 */
export function addressBlindIndex(value: string): string {
  return hmacB64url(normAddress(value));
}

/**
 * Blind index for a phone number.
 * Normalisation: digits only (strips spaces, dashes, parentheses, country-code prefixes).
 */
export function phoneBlindIndex(value: string): string {
  return hmacB64url(normPhone(value));
}

/**
 * Generic blind index – caller supplies an already-normalised (or opaque) value.
 * Use when you need a deterministic token over a value that doesn't fit the above
 * per-field rules (e.g. a postal code or a custom identifier).
 */
export function rawBlindIndex(value: string): string {
  return hmacB64url(value);
}
