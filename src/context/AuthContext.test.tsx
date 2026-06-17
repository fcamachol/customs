import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';

function Probe() {
  const { user, login } = useAuth();
  return <button onClick={() => login('admin', 'p')}>{user ? user.username : 'anon'}</button>;
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true, json: async () => ({ token: 't', user: { id: '1', username: 'admin', role: 'admin' } }),
    })) as any);
    localStorage.clear();
  });

  it('logs in and exposes the user', async () => {
    render(<AuthProvider><Probe /></AuthProvider>);
    screen.getByText('anon').click();
    await waitFor(() => expect(screen.getByText('admin')).toBeTruthy());
    expect(localStorage.getItem('token')).toBe('t');
  });
});
