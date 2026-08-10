import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clasificarDestino,
  contactosDeRol,
  enviarNotificacion,
  enviarNotificaciones,
  resumirEnvios,
} from '../../src/services/notificaciones';

/**
 * The outbound notification fan-out (R19/N5, #22 + #31).
 *
 * THE RULE UNDER TEST is that the CHANNEL IS DERIVED FROM THE HANDLE. `plan_publicaciones.
 * destinatarios` is a free-form `string[]` — whatever the coordinator typed — so an address goes by
 * SMTP, a phone number goes over WhatsApp, and anything else is reported as `omitido` NAMING ITSELF.
 * Guessing, or silently dropping, is how a warehouse ends up never told about a republished plan
 * while the record says the plan was distributed.
 *
 * And the invariant this whole module exists to protect: `omitido` is never `enviado`. With SMTP and
 * evolution-api unprovisioned — the state of every test process and, until an operator acts, of
 * production — every send must come back skipped WITH ITS REASON.
 *
 * No network here: both channel modules are config-gated and return `omitido` when unconfigured, so
 * the honest default state is exactly what these tests exercise.
 */

const ENV = {
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_FROM: process.env.SMTP_FROM,
  EVOLUTION_API_URL: process.env.EVOLUTION_API_URL,
  NOTIFICACION_ALMACEN: process.env.NOTIFICACION_ALMACEN,
  NOTIFICACION_COORDINACION: process.env.NOTIFICACION_COORDINACION,
  NOTIFICACION_DIRECCION: process.env.NOTIFICACION_DIRECCION,
  WHATSAPP_INTERNAL_NUMBERS: process.env.WHATSAPP_INTERNAL_NUMBERS,
};

beforeEach(() => {
  for (const k of Object.keys(ENV)) delete process.env[k];
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  for (const [k, v] of Object.entries(ENV)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
});

const MENSAJE = { asunto: 'Plan de despacho 2026-08-10 — versión 2', texto: 'Cambios: 1 despacho.' };

describe('clasificarDestino — el canal sale de la forma del handle', () => {
  it('reads an address as email', () => {
    expect(clasificarDestino('almacen@capitalc.com.mx')).toBe('email');
    expect(clasificarDestino('  ops@cliente.example  ')).toBe('email');
  });

  it('reads a phone number as WhatsApp, however a human wrote it', () => {
    expect(clasificarDestino('+525512345678')).toBe('whatsapp');
    expect(clasificarDestino('55 1234 5678')).toBe('whatsapp');
    expect(clasificarDestino('(55) 1234-5678')).toBe('whatsapp');
  });

  it('refuses to guess at anything else', () => {
    // "bodega 3" is a place, not a way to reach anybody. Naming that is the useful answer.
    expect(clasificarDestino('bodega 3')).toBeNull();
    expect(clasificarDestino('')).toBeNull();
    expect(clasificarDestino('12345')).toBeNull(); // too short to be a phone number
  });
});

describe('enviarNotificacion — omitido no es enviado', () => {
  it('skips an email with the reason when SMTP is not provisioned', async () => {
    const r = await enviarNotificacion('almacen@capitalc.com.mx', MENSAJE);
    expect(r).toMatchObject({ canal: 'email', estado: 'omitido' });
    expect(r.detalle).toMatch(/SMTP no configurado/);
  });

  it('skips a WhatsApp message with the reason when evolution-api is not provisioned', async () => {
    const r = await enviarNotificacion('+525512345678', MENSAJE);
    expect(r).toMatchObject({ canal: 'whatsapp', estado: 'omitido' });
    expect(r.detalle.length).toBeGreaterThan(0);
  });

  it('quotes an unrecognized handle back instead of dropping it', async () => {
    const r = await enviarNotificacion('bodega 3', MENSAJE);
    expect(r).toMatchObject({ canal: null, estado: 'omitido' });
    expect(r.detalle).toContain('bodega 3');
  });

  it('never throws, whatever it is handed', async () => {
    await expect(enviarNotificacion('', MENSAJE)).resolves.toMatchObject({ estado: 'omitido' });
    await expect(
      enviarNotificacion(undefined as unknown as string, MENSAJE),
    ).resolves.toMatchObject({ estado: 'omitido' });
  });
});

describe('enviarNotificaciones — la lista', () => {
  it('de-duplicates case-insensitively: one obligation, one message, one outcome', async () => {
    const rs = await enviarNotificaciones(
      ['almacen@capitalc.com.mx', 'ALMACEN@capitalc.com.mx', ' almacen@capitalc.com.mx '],
      MENSAJE,
    );
    expect(rs).toHaveLength(1);
  });

  it('keeps one outcome per distinct recipient, in order', async () => {
    const rs = await enviarNotificaciones(['a@b.com', '+525512345678', 'bodega 3'], MENSAJE);
    expect(rs.map((r) => r.canal)).toEqual(['email', 'whatsapp', null]);
  });

  it('drops empties without inventing a recipient', async () => {
    expect(await enviarNotificaciones(['', '   '], MENSAJE)).toHaveLength(0);
  });
});

describe('resumirEnvios — cuatro números, no un booleano', () => {
  it('counts each outcome separately so a partial fan-out cannot read as a success', () => {
    const resumen = resumirEnvios([
      { destino: 'a@b.com', canal: 'email', estado: 'enviado', detalle: 'ok' },
      { destino: 'c@d.com', canal: 'email', estado: 'omitido', detalle: 'SMTP no configurado' },
      { destino: '+52551', canal: null, estado: 'omitido', detalle: 'no reconocido' },
      { destino: 'e@f.com', canal: 'email', estado: 'error', detalle: 'timeout' },
    ]);
    expect(resumen).toEqual({ intentados: 4, enviados: 1, omitidos: 2, errores: 1 });
  });
});

describe('contactosDeRol — los padrones fijos', () => {
  it('splits a comma-separated roster and mixes channels freely', () => {
    process.env.NOTIFICACION_ALMACEN = 'almacen@capitalc.com.mx, +525512345678 ,';
    expect(contactosDeRol('almacen')).toEqual(['almacen@capitalc.com.mx', '+525512345678']);
  });

  it('returns nothing when the roster is unset — the caller reports omitido, never a send', () => {
    expect(contactosDeRol('almacen')).toEqual([]);
    expect(contactosDeRol('coordinacion')).toEqual([]);
  });

  it('falls back to #31 WHATSAPP_INTERNAL_NUMBERS for dirección, without duplicating', () => {
    process.env.NOTIFICACION_DIRECCION = '+525500000001';
    process.env.WHATSAPP_INTERNAL_NUMBERS = '+525500000001,+525500000002';
    expect(contactosDeRol('direccion')).toEqual(['+525500000001', '+525500000002']);
  });

  it('uses the #31 roster alone when no dedicated variable is set', () => {
    process.env.WHATSAPP_INTERNAL_NUMBERS = '+525500000009';
    expect(contactosDeRol('direccion')).toEqual(['+525500000009']);
  });
});
