import type { Role } from './token';

// admin and autoridad can see all records; capturista is scoped to their own.
export function canSeeAll(role: Role): boolean {
  return role === 'admin' || role === 'autoridad';
}
