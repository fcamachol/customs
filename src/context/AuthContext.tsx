import { createContext, useContext, useState, type ReactNode } from 'react';
import { apiPost } from '../api';

interface User { id: string; username: string; role: 'capturista' | 'admin' | 'autoridad' | 'super_admin'; }
interface AuthValue { user: User | null; login: (u: string, p: string, code?: string) => Promise<void>; logout: () => Promise<void>; }

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);

  async function login(username: string, password: string, code?: string) {
    const body: Record<string, string> = { username, password };
    if (code) body.code = code;
    const { token, user } = await apiPost<{ token: string; user: User }>('/api/auth/login', body);
    localStorage.setItem('token', token);
    setUser(user);
  }

  async function logout() {
    // Best-effort call to invalidate the token server-side (bumps token_version).
    try { await apiPost('/api/auth/logout', {}); } catch { /* ignore network errors */ }
    localStorage.removeItem('token');
    setUser(null);
  }

  return <Ctx.Provider value={{ user, login, logout }}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

/**
 * Call this from API error handlers when a 401 "Token revoked" response is received.
 * It clears the local session so the user is returned to the login screen.
 */
export function clearSessionOnRevocation() {
  localStorage.removeItem('token');
  // Trigger a page reload so the app re-initialises with no user.
  window.location.reload();
}
