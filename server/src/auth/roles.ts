/** F10: Single source of truth for privileged roles requiring mandatory MFA. */

export const PRIVILEGED_ROLES = ['admin', 'super_admin', 'autoridad'] as const;
export type PrivilegedRole = (typeof PRIVILEGED_ROLES)[number];

export function isPrivilegedRole(role: string): role is PrivilegedRole {
  return (PRIVILEGED_ROLES as readonly string[]).includes(role);
}

/**
 * MFA_ENFORCEMENT controls blocking behaviour for privileged users without MFA.
 * - 'enforce' (default): block login with 403 and issue enrollment token.
 * - 'warn': allow login but log a warning. Use during migration windows.
 */
export function getMfaEnforcement(): 'enforce' | 'warn' {
  const val = process.env.MFA_ENFORCEMENT;
  if (val === 'warn') return 'warn';
  return 'enforce'; // default
}

/**
 * DEMO_MODE gates the one-click demo-reset feature. Enabled only when the env var
 * is the exact string 'true' (same string-compare convention as MFA_ENFORCEMENT).
 * When false/unset the reset endpoint 404s and the UI renders nothing.
 */
export function isDemoMode(): boolean {
  return process.env.DEMO_MODE === 'true';
}
