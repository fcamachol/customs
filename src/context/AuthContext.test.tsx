import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

function Probe() {
  const { user, login, logout } = useAuth();
  return (
    <>
      <button onClick={() => login('admin', 'p')}>{user ? user.username : 'anon'}</button>
      <button onClick={() => logout()}>logout</button>
    </>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/logout')) {
        return { ok: true, json: async () => ({ ok: true }) };
      }
      return {
        ok: true,
        json: async () => ({ token: 't', user: { id: '1', username: 'admin', role: 'admin' } }),
      };
    }) as any);
    localStorage.clear();
  });

  it('restores a persisted session on mount when a token is present', async () => {
    localStorage.setItem('token', 'existing');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/me')) {
        return { ok: true, json: async () => ({ id: '1', username: 'admin', role: 'admin' }) };
      }
      return { ok: true, json: async () => ({}) };
    }) as any);
    render(<AuthProvider><Probe /></AuthProvider>);
    // Without restore, this would stay 'anon'; with restore it rehydrates from /me.
    await waitFor(() => expect(screen.getByText('admin')).toBeTruthy());
  });

  it('clears an invalid persisted token on mount and stays logged out', async () => {
    localStorage.setItem('token', 'stale');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 401, json: async () => ({ error: 'Token revoked' }) })) as any);
    render(<AuthProvider><Probe /></AuthProvider>);
    await waitFor(() => expect(screen.getByText('anon')).toBeTruthy());
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('logs in and exposes the user', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    screen.getByText('anon').click();
    await waitFor(() => expect(screen.getByText('admin')).toBeTruthy());
    expect(localStorage.getItem('token')).toBe('t');
  });

  it('logout calls the server endpoint and clears the session', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    // Log in first.
    screen.getByText('anon').click();
    await waitFor(() => expect(screen.getByText('admin')).toBeTruthy());
    // Now logout.
    await act(async () => { screen.getByText('logout').click(); });
    await waitFor(() => expect(screen.getByText('anon')).toBeTruthy());
    expect(localStorage.getItem('token')).toBeNull();
    // Verify the logout endpoint was called.
    const fetchCalls = (vi.mocked(fetch) as ReturnType<typeof vi.fn>).mock.calls;
    const logoutCall = fetchCalls.find(([url]: [string]) => url.includes('/logout'));
    expect(logoutCall).toBeTruthy();
  });
});
