import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * WHATSAPP FAN-OUT (#31) — unit tests for the two decisions this module owns:
 *
 *  1. `esEventoAvisableInterno` / `avisarInternoPorEvento` — which ledger events page the internal
 *     `dirección` roster (§6.3), and that the message reuses `agoraMirror.formatearEvento` so the
 *     WhatsApp line and the AGORA note never diverge on the same fact.
 *  2. `escalarPorWhatsapp` — the client-side second channel fires exactly when the primary channel
 *     (email) did NOT confirm delivery, never when it did.
 *
 * `./whatsapp` is mocked; its own wire behaviour is covered by `whatsapp.test.ts`.
 */
const sendWhatsappMock = vi.fn();
const whatsappConfiguradoMock = vi.fn();

vi.mock('../../src/services/whatsapp', () => ({
  sendWhatsapp: (...args: unknown[]) => sendWhatsappMock(...args),
  whatsappConfigurado: () => whatsappConfiguradoMock(),
}));

const { avisarInternoPorEvento, escalarPorWhatsapp, esEventoAvisableInterno } = await import(
  '../../src/services/whatsappFanout'
);

const ORIGINAL_ROSTER = process.env.WHATSAPP_INTERNAL_NUMBERS;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.WHATSAPP_INTERNAL_NUMBERS;
  whatsappConfiguradoMock.mockReturnValue(true);
  sendWhatsappMock.mockResolvedValue({ status: 'enviado', destinatario: '525500000000', messageId: 'x' });
});

afterEach(() => {
  if (ORIGINAL_ROSTER === undefined) delete process.env.WHATSAPP_INTERNAL_NUMBERS;
  else process.env.WHATSAPP_INTERNAL_NUMBERS = ORIGINAL_ROSTER;
});

describe('esEventoAvisableInterno', () => {
  it('is true for the freeze-layer events named in §6.3 / the frontier table', () => {
    expect(esEventoAvisableInterno('HOLD_GLOBAL_ABIERTO')).toBe(true);
    expect(esEventoAvisableInterno('HOLD_GLOBAL_CERRADO')).toBe(true);
    expect(esEventoAvisableInterno('RETENCION_CREADA')).toBe(true);
    expect(esEventoAvisableInterno('REQUERIMIENTO_VENCIDO')).toBe(true);
  });

  it('is false for events that do not change what can be planned', () => {
    expect(esEventoAvisableInterno('CARGA_DISPONIBLE')).toBe(false);
    expect(esEventoAvisableInterno('MODULACION')).toBe(false);
    expect(esEventoAvisableInterno('REQUERIMIENTO_EMITIDO')).toBe(false);
    expect(esEventoAvisableInterno('ALGO_DESCONOCIDO')).toBe(false);
  });
});

describe('avisarInternoPorEvento', () => {
  it('sends nothing for a tipo that is not significant, regardless of roster', () => {
    process.env.WHATSAPP_INTERNAL_NUMBERS = '+525511111111';
    return avisarInternoPorEvento({
      tipo: 'MODULACION',
      payloadResumen: { semaforo: 'red' },
    }).then((out) => {
      expect(out).toEqual([]);
      expect(sendWhatsappMock).not.toHaveBeenCalled();
    });
  });

  it('sends nothing when no internal roster is configured', async () => {
    const out = await avisarInternoPorEvento({
      tipo: 'HOLD_GLOBAL_ABIERTO',
      payloadResumen: { tipoHold: 'auditoria', motivo: 'auditoría de autoridad', efecto: 'todo parado' },
    });
    expect(out).toEqual([]);
    expect(sendWhatsappMock).not.toHaveBeenCalled();
  });

  it('logs the empty-roster skip only when WhatsApp itself is configured', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    whatsappConfiguradoMock.mockReturnValue(false);
    await avisarInternoPorEvento({ tipo: 'RETENCION_CREADA', payloadResumen: {} });
    expect(warn).not.toHaveBeenCalled();

    whatsappConfiguradoMock.mockReturnValue(true);
    await avisarInternoPorEvento({ tipo: 'RETENCION_CREADA', payloadResumen: {} });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/WHATSAPP_INTERNAL_NUMBERS vacío/);

    warn.mockRestore();
  });

  it('sends one message per configured internal number, reusing the AGORA mirror wording', async () => {
    process.env.WHATSAPP_INTERNAL_NUMBERS = '+525511111111, +525522222222';
    const out = await avisarInternoPorEvento({
      operacionId: 'abcdef12-3456-7890-abcd-ef1234567890',
      tipo: 'HOLD_GLOBAL_ABIERTO',
      payloadResumen: {
        tipoHold: 'auditoria',
        motivo: 'auditoría de autoridad',
        efecto: 'Se suspende la solicitud de unidades; la operación no se programa.',
      },
    });
    expect(out).toHaveLength(2);
    expect(sendWhatsappMock).toHaveBeenCalledTimes(2);
    expect(sendWhatsappMock).toHaveBeenNthCalledWith(1, {
      to: '+525511111111',
      text: expect.stringContaining('HOLD GLOBAL'),
    });
    expect(sendWhatsappMock).toHaveBeenNthCalledWith(2, {
      to: '+525522222222',
      text: expect.stringContaining('HOLD GLOBAL'),
    });
    // The short operación prefix, when one is given.
    expect(sendWhatsappMock.mock.calls[0][0].text).toMatch(/^\[abcdef12\]/);
  });

  it('omits the operación prefix for a global event with none', async () => {
    process.env.WHATSAPP_INTERNAL_NUMBERS = '+525511111111';
    await avisarInternoPorEvento({
      tipo: 'HOLD_GLOBAL_CERRADO',
      payloadResumen: { efecto: 'Se reanuda la solicitud de unidades.' },
    });
    expect(sendWhatsappMock.mock.calls[0][0].text).not.toMatch(/^\[/);
  });

  it('never throws even when sendWhatsapp rejects', async () => {
    process.env.WHATSAPP_INTERNAL_NUMBERS = '+525511111111';
    sendWhatsappMock.mockRejectedValue(new Error('boom'));
    await expect(
      avisarInternoPorEvento({ tipo: 'RETENCION_CREADA', payloadResumen: {} }),
    ).resolves.toEqual([]);
  });
});

describe('escalarPorWhatsapp', () => {
  it('does not escalate when the primary channel confirmed delivery', async () => {
    const out = await escalarPorWhatsapp({
      telefono: '+525511111111',
      canalPrimarioEstado: 'enviado',
      texto: 'hola',
    });
    expect(out).toBeNull();
    expect(sendWhatsappMock).not.toHaveBeenCalled();
  });

  it('escalates when the primary channel was omitted', async () => {
    const out = await escalarPorWhatsapp({
      telefono: '+525511111111',
      canalPrimarioEstado: 'omitido',
      texto: 'ACTION REQUIRED',
    });
    expect(sendWhatsappMock).toHaveBeenCalledWith({ to: '+525511111111', text: 'ACTION REQUIRED' });
    expect(out).toEqual({ status: 'enviado', destinatario: '525500000000', messageId: 'x' });
  });

  it('escalates when the primary channel errored', async () => {
    await escalarPorWhatsapp({ telefono: '+525511111111', canalPrimarioEstado: 'error', texto: 't' });
    expect(sendWhatsappMock).toHaveBeenCalledTimes(1);
  });

  it('does not escalate when there is no phone number to escalate to', async () => {
    const out = await escalarPorWhatsapp({ telefono: null, canalPrimarioEstado: 'error', texto: 't' });
    expect(out).toBeNull();
    expect(sendWhatsappMock).not.toHaveBeenCalled();
  });
});
