import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { apiGet, apiPost } from '../api';

interface User { id: string; username: string; role: 'capturista' | 'admin' | 'autoridad' | 'super_admin'; }

interface AuthValue {
  user: User | null;
  /** True while the persisted session is being restored on initial load. */
  loading: boolean;
  login: (u: string, p: string, code?: string) => Promise<void>;
  logout: () => Promise<void>;
  /**
   * F10: MFA enrollment helpers — called during the enrollment flow with an enrollment-scoped token.
   * phase='setup': returns secret + otpauthUrl for QR display.
   * phase='enable': verifies TOTP code, stores full session token, updates user state.
   */
  enrollMfa: (
    phase: 'setup' | 'enable',
    enrollmentToken: string,
    code?: string,
  ) => Promise<{ secret: string; otpauthUrl: string } | void>;
}

const Ctx = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  // Restore the persisted session on initial load: if a token is in localStorage,
  // validate it against the server and rehydrate the user so a refresh doesn't
  // bounce the user back to the login screen.
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      const token = localStorage.getItem('token');
      if (!token) { setLoading(false); return; }
      try {
        const me = await apiGet<User>('/api/auth/me');
        if (!cancelled) setUser(me);
      } catch {
        // Token is missing/expired/revoked — clear it and fall back to login.
        localStorage.removeItem('token');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void restore();
    return () => { cancelled = true; };
  }, []);

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

  /** F10: MFA enrollment using an enrollment-scoped token. */
  async function enrollMfa(
    phase: 'setup' | 'enable',
    enrollmentToken: string,
    code?: string,
  ): Promise<{ secret: string; otpauthUrl: string } | void> {
    const BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
    const authHeaders = { Authorization: `Bearer ${enrollmentToken}` };

    if (phase === 'setup') {
      const res = await fetch(`${BASE}/api/auth/mfa/setup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({}),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
      return res.json() as Promise<{ secret: string; otpauthUrl: string }>;
    }

    // phase === 'enable'
    const res = await fetch(`${BASE}/api/auth/mfa/enable`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders },
      body: JSON.stringify({ code }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? res.statusText);
    const { token, enabled } = await res.json() as { token: string; enabled: boolean };
    if (enabled && token) {
      // Store full session token and fetch user info
      localStorage.setItem('token', token);
      const meRes = await fetch(`${BASE}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (meRes.ok) {
        const me = await meRes.json() as User;
        setUser(me);
      }
    }
  }

  return <Ctx.Provider value={{ user, loading, login, logout, enrollMfa }}>{children}</Ctx.Provider>;
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
