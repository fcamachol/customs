import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * OUTBOUND MAIL (#22) — unit tests for the one contract callers depend on.
 *
 * The reason this file is worth its weight: `R18` freezes a client's cargo when a deadline passes,
 * and the only thing standing between that and a client who was never told is this module returning
 * an HONEST outcome. So the tests are almost entirely about the difference between `enviado`,
 * `omitido` and `error` — never about SMTP wire behaviour, which is nodemailer's problem.
 *
 * `nodemailer` is mocked. A test suite that opened a real socket would be testing the network.
 */
const sendMailMock = vi.fn();
const closeMock = vi.fn();
const createTransportMock = vi.fn((_opts: Record<string, unknown>) => ({
  sendMail: sendMailMock,
  close: closeMock,
}));

vi.mock('nodemailer', () => ({
  default: { createTransport: (opts: Record<string, unknown>) => createTransportMock(opts) },
}));

const { loadMailerConfig, mailerConfigurado, resetMailer, sendMail } = await import(
  '../../src/services/mailer'
);

const VARS = [
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_SECURE',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_FROM',
  'SMTP_TIMEOUT_MS',
] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  resetMailer();
  for (const v of VARS) {
    ORIGINAL[v] = process.env[v];
    delete process.env[v];
  }
  sendMailMock.mockResolvedValue({
    messageId: '<abc@customs>',
    accepted: ['client@example.com'],
    rejected: [],
  });
});

afterEach(() => {
  for (const v of VARS) {
    if (ORIGINAL[v] === undefined) delete process.env[v];
    else process.env[v] = ORIGINAL[v] as string;
  }
  resetMailer();
});

function configurar(extra: Record<string, string> = {}): void {
  process.env.SMTP_HOST = 'smtp.example.com';
  process.env.SMTP_FROM = 'ops@capitalc.com.mx';
  for (const [k, v] of Object.entries(extra)) process.env[k] = v;
  resetMailer();
}

describe('loadMailerConfig', () => {
  it('returns null when SMTP is not provisioned at all', () => {
    expect(loadMailerConfig()).toBeNull();
    expect(mailerConfigurado()).toBe(false);
  });

  it('returns null with a host but no From — mail with no sender is silently dropped by receivers', () => {
    process.env.SMTP_HOST = 'smtp.example.com';
    expect(loadMailerConfig()).toBeNull();
  });

  it('defaults the port to 587 and derives STARTTLS from it', () => {
    configurar();
    expect(loadMailerConfig()).toMatchObject({ port: 587, secure: false });
  });

  it('derives implicit TLS from port 465 rather than defaulting secure to false', () => {
    // The classic misconfiguration: port 465 with `secure: false` hangs until the socket times out.
    configurar({ SMTP_PORT: '465' });
    expect(loadMailerConfig()).toMatchObject({ port: 465, secure: true });
  });

  it('lets SMTP_SECURE override the port-derived default', () => {
    configurar({ SMTP_PORT: '2525', SMTP_SECURE: 'true' });
    expect(loadMailerConfig()?.secure).toBe(true);
  });

  it('treats blank credentials as absent (a relay that needs no auth)', () => {
    configurar();
    expect(loadMailerConfig()).toMatchObject({ user: null });
  });
});

describe('sendMail — the unconfigured path (#22 not provisioned yet)', () => {
  it('reports `omitido` with a stated reason instead of throwing', async () => {
    const out = await sendMail({ to: 'client@example.com', subject: 's', text: 't' });
    expect(out.status).toBe('omitido');
    expect(out.status === 'omitido' && out.motivo).toMatch(/SMTP no configurado/);
  });

  it('never builds a transport when there is nothing to build it from', async () => {
    await sendMail({ to: 'client@example.com', subject: 's', text: 't' });
    expect(createTransportMock).not.toHaveBeenCalled();
  });

  it('logs the skipped send so the operator can see what did not go out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await sendMail({ to: 'client@example.com', subject: 'ACTION REQUIRED', text: 't' });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/OMITIDO/);
    warn.mockRestore();
  });
});

describe('sendMail — recipients', () => {
  it('omits a send with no recipient rather than handing SMTP an empty envelope', async () => {
    configurar();
    const out = await sendMail({ to: '', subject: 's', text: 't' });
    expect(out).toEqual({ status: 'omitido', motivo: 'sin destinatario' });
    expect(sendMailMock).not.toHaveBeenCalled();
  });

  it('omits a malformed address as a skipped send, not as an exception mid-ledger-write', async () => {
    configurar();
    const out = await sendMail({ to: 'not-an-email', subject: 's', text: 't' });
    expect(out.status).toBe('omitido');
    expect(sendMailMock).not.toHaveBeenCalled();
  });
});

describe('sendMail — the configured path', () => {
  it('sends and reports the accepted recipients', async () => {
    configurar();
    const out = await sendMail({ to: 'client@example.com', subject: 'ACTION REQUIRED', text: 'body' });
    expect(out).toMatchObject({
      status: 'enviado',
      destinatario: 'client@example.com',
      messageId: '<abc@customs>',
      aceptados: ['client@example.com'],
    });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ from: 'ops@capitalc.com.mx', to: 'client@example.com', subject: 'ACTION REQUIRED' }),
    );
  });

  it('passes auth only when a user is configured', async () => {
    configurar();
    await sendMail({ to: 'client@example.com', subject: 's', text: 't' });
    expect(createTransportMock.mock.calls[0][0]).not.toHaveProperty('auth');

    configurar({ SMTP_USER: 'u', SMTP_PASS: 'p' });
    await sendMail({ to: 'client@example.com', subject: 's', text: 't' });
    expect(createTransportMock.mock.calls[1][0]).toMatchObject({ auth: { user: 'u', pass: 'p' } });
  });

  it('reuses the pooled transport across sends, and rebuilds it when the config changes', async () => {
    configurar();
    await sendMail({ to: 'a@example.com', subject: 's', text: 't' });
    await sendMail({ to: 'b@example.com', subject: 's', text: 't' });
    expect(createTransportMock).toHaveBeenCalledTimes(1);

    process.env.SMTP_HOST = 'smtp2.example.com';
    await sendMail({ to: 'c@example.com', subject: 's', text: 't' });
    expect(createTransportMock).toHaveBeenCalledTimes(2);
  });

  it('reports a transport failure as `error`, never as a throw', async () => {
    configurar();
    sendMailMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await sendMail({ to: 'client@example.com', subject: 's', text: 't' });
    expect(out).toEqual({ status: 'error', error: 'ECONNREFUSED' });
  });

  it('calls a send with every recipient rejected an ERROR, not a success', async () => {
    // The dangerous case: the server took the envelope and dropped every address. Reporting this as
    // `enviado` would start a hard deadline against a client who received nothing.
    configurar();
    sendMailMock.mockResolvedValue({ messageId: '<x>', accepted: [], rejected: ['client@example.com'] });
    const out = await sendMail({ to: 'client@example.com', subject: 's', text: 't' });
    expect(out.status).toBe('error');
    expect(out.status === 'error' && out.error).toMatch(/rechazó a todos/);
  });

  it('normalizes address objects to plain strings', async () => {
    configurar();
    sendMailMock.mockResolvedValue({
      messageId: '<x>',
      accepted: [{ address: 'client@example.com', name: '' }],
      rejected: [],
    });
    const out = await sendMail({ to: 'client@example.com', subject: 's', text: 't' });
    expect(out).toMatchObject({ status: 'enviado', aceptados: ['client@example.com'] });
  });
});
