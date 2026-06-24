/**
 * F10: LoginView — MFA enrollment flow tests.
 * Tests that LoginView handles the new mfa_enrollment_required 403 state.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import { LoginView } from './LoginView';
import { AuthProvider } from '../context/AuthContext';

function renderLogin() {
  return render(
    <AuthProvider>
      <LoginView />
    </AuthProvider>,
  );
}

function fillAndSubmit(username = 'adminuser', password = 'pass') {
  fireEvent.change(screen.getByLabelText(/usuario/i), { target: { value: username } });
  fireEvent.change(screen.getByLabelText(/contraseña/i), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: /entrar/i }));
}

describe('LoginView — normal login', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ token: 'full-token', user: { id: '1', username: 'cap', role: 'capturista' } }),
    })) as unknown as typeof fetch);
    localStorage.clear();
  });

  it('renders the login form', () => {
    renderLogin();
    expect(screen.getByLabelText(/usuario/i)).toBeTruthy();
    expect(screen.getByLabelText(/contraseña/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /entrar/i })).toBeTruthy();
  });

  it('submits credentials and stores token on success', async () => {
    renderLogin();
    await act(async () => { fillAndSubmit('cap', 'pass'); });
    await waitFor(() => expect(localStorage.getItem('token')).toBe('full-token'));
  });
});

describe('LoginView — mfa_required (existing MFA flow)', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      json: async () => ({ error: 'mfa_required' }),
      status: 401,
    })) as unknown as typeof fetch);
    localStorage.clear();
  });

  it('shows MFA code input after mfa_required error', async () => {
    renderLogin();
    await act(async () => { fillAndSubmit(); });
    await waitFor(() => expect(screen.getByLabelText(/código mfa/i)).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/autenticación/i);
  });
});

describe('LoginView — mfa_enrollment_required (F10: new enrollment flow)', () => {
  function makeFetch() {
    return vi.fn(async (url: string) => {
      const s = typeof url === 'string' ? url : '';
      if (s.includes('/auth/login')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ error: 'mfa_enrollment_required', enrollmentToken: 'enrollment-tok' }),
        };
      }
      if (s.includes('/mfa/setup')) {
        return {
          ok: true,
          json: async () => ({ secret: 'MYSECRET', otpauthUrl: 'otpauth://totp/test?secret=MYSECRET' }),
        };
      }
      if (s.includes('/mfa/enable')) {
        return {
          ok: true,
          json: async () => ({ enabled: true, token: 'full-session-token' }),
        };
      }
      if (s.includes('/auth/me')) {
        return {
          ok: true,
          json: async () => ({ id: '1', username: 'admin', role: 'admin' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    }) as unknown as typeof fetch;
  }

  beforeEach(() => {
    vi.stubGlobal('fetch', makeFetch());
    localStorage.clear();
  });

  it('shows enrollment setup prompt when login returns mfa_enrollment_required', async () => {
    renderLogin();
    await act(async () => { fillAndSubmit('admin', 'pass'); });
    await waitFor(() => {
      // Should show the "Configurar MFA" screen
      expect(screen.getByText(/configurar mfa/i)).toBeTruthy();
      expect(screen.getByRole('button', { name: /generar código qr/i })).toBeTruthy();
    });
  });

  it('clicking "Generar código QR" shows secret and TOTP input', async () => {
    renderLogin();
    await act(async () => { fillAndSubmit('admin', 'pass'); });
    await waitFor(() => screen.getByRole('button', { name: /generar código qr/i }));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /generar código qr/i }));
    });

    await waitFor(() => {
      expect(screen.getAllByText(/MYSECRET/).length).toBeGreaterThan(0);
      expect(screen.getByLabelText(/código de verificación/i)).toBeTruthy();
    });
  });

  it('after entering TOTP code and submitting, stores full session token', async () => {
    renderLogin();
    await act(async () => { fillAndSubmit('admin', 'pass'); });
    await waitFor(() => screen.getByRole('button', { name: /generar código qr/i }));

    // Proceed to enable step
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /generar código qr/i }));
    });
    await waitFor(() => screen.getByLabelText(/código de verificación/i));

    // Enter TOTP code
    await act(async () => {
      fireEvent.change(screen.getByLabelText(/código de verificación/i), { target: { value: '123456' } });
    });

    // Submit
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /activar mfa/i }));
    });

    await waitFor(() => expect(localStorage.getItem('token')).toBe('full-session-token'));
  });

  it('does not show MFA code field (mfa_required) during enrollment flow', async () => {
    renderLogin();
    await act(async () => { fillAndSubmit('admin', 'pass'); });
    await waitFor(() => screen.getByText(/configurar mfa/i));
    // Should not show the regular MFA code input
    expect(screen.queryByLabelText(/código mfa/i)).toBeNull();
  });
});
