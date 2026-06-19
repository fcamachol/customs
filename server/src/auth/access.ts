import type { Role } from './token';

// PRD shared-visibility rule (RF-22): "Todos los capturistas tienen el mismo nivel y pueden
// ver/continuar los registros de los demás." Read access is NOT role-differentiated between
// capturista peers — only WRITE access is gated (capturista/admin only, autoridad read-only).
export function canSeeAll(role: Role): boolean {
  return role === 'admin' || role === 'autoridad' || role === 'capturista';
}
