import { generateSecret as otplibGenerateSecret, generateSync, verifySync, generateURI } from 'otplib';

const ISSUER = 'Riesgo T1';

export function generateSecret(): string {
  return otplibGenerateSecret();
}

export function keyUri(username: string, secret: string): string {
  return generateURI({ issuer: ISSUER, label: username, secret });
}

export function verifyTotp(secret: string, code: string): boolean {
  try {
    const result = verifySync({ secret, token: code });
    if (typeof result === 'boolean') return result;
    // v13 returns an object { valid: boolean, ... }
    if (result && typeof result === 'object' && 'valid' in result) {
      return (result as { valid: boolean }).valid === true;
    }
    return false;
  } catch {
    return false;
  }
}

export function generateTotp(secret: string): string {
  return generateSync({ secret });
}
