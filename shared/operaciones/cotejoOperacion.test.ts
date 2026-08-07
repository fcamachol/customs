import { describe, expect, it } from 'vitest';
import {
  CODIGOS_MANIFIESTO,
  CODIGOS_OPERACION,
  cotejarOperacion,
  mergeDiscrepancias,
  tieneError,
  type ContextoOperacion,
  type Discrepancia,
} from './cotejo';

/**
 * PA-07 (the same house guía on two open operaciones) and PA-08 (the sender resolves to no client).
 *
 * These are the two rules that judge the CASO rather than the paperwork, and the distinction that
 * matters most in them is severity: duplicate cargo is an error a human must clear, while an
 * unrecognized sender is usually a new mailbox and must be visible without blocking anything.
 */

const codes = (ds: Discrepancia[]) => ds.map((d) => d.codigo);

function ctx(over: Partial<ContextoOperacion> = {}): ContextoOperacion {
  return {
    clientId: '11111111-1111-1111-1111-111111111111',
    clientMatchedBy: 'platform_email',
    remitente: 'robot@shein.example',
    guiasDuplicadas: [],
    ...over,
  };
}

describe('cotejarOperacion — a resolved sender with unique cargo is silent', () => {
  it('raises nothing when the client came from an address and no guía repeats', () => {
    expect(cotejarOperacion(ctx())).toEqual([]);
    expect(cotejarOperacion(ctx({ clientMatchedBy: 'client_email' }))).toEqual([]);
  });
});

describe('PA-07 — the same house guía on another open operación', () => {
  it('fires as an ERROR, because one shipment declared twice must not be planned twice', () => {
    const ds = cotejarOperacion(ctx({ guiasDuplicadas: ['16094705516001'] }));
    expect(codes(ds)).toEqual(['PA-07']);
    expect(tieneError(ds)).toBe(true);
    expect(ds[0].detalle).toMatchObject({ guias: ['16094705516001'], total: 1 });
  });

  it('caps the guía list at 20 in the detalle but reports the true total', () => {
    // A manifiesto is thousands of house guías; a whole duplicate manifest would otherwise inline
    // thousands of strings into the jsonb the board reads on every poll. The count stays exact so the
    // magnitude of the finding is never understated by the truncation.
    const guias = Array.from({ length: 57 }, (_, i) => `1609470551${String(i).padStart(4, '0')}`);
    const ds = cotejarOperacion(ctx({ guiasDuplicadas: guias }));
    const detalle = ds[0].detalle as { guias: string[]; total: number };
    expect(detalle.guias).toHaveLength(20);
    expect(detalle.guias).toEqual(guias.slice(0, 20));
    expect(detalle.total).toBe(57);
    expect(ds[0].mensaje).toContain('57');
  });

  it('fires independently of how (or whether) the client resolved', () => {
    const ds = cotejarOperacion(ctx({ clientId: null, guiasDuplicadas: ['A1'] }));
    expect(codes(ds)).toEqual(['PA-07', 'PA-08']);
  });
});

describe('PA-08 — the sender resolves to no client', () => {
  it('is an ADVERTENCIA, not an error: an unknown mailbox is usually a new client', () => {
    const ds = cotejarOperacion(ctx({ clientId: null, clientMatchedBy: 'sin_resolver' }));
    expect(codes(ds)).toEqual(['PA-08']);
    expect(ds[0].severidad).toBe('advertencia');
    expect(tieneError(ds)).toBe(false);
    // The address is carried in the finding so a human can register it without hunting for the email.
    expect(ds[0].detalle).toMatchObject({ remitente: 'robot@shein.example' });
  });

  it('never stays silent, because an unattached caso has no tariff, address or monthly report', () => {
    expect(cotejarOperacion(ctx({ clientId: null, remitente: null }))).toHaveLength(1);
  });

  it('downgrades to INFORMATIVA when the client was identified by the subject name only', () => {
    // Not a failure — the caso is attached and can proceed — but the reviewer must be able to see the
    // identification rested on a subject line rather than on an address.
    const ds = cotejarOperacion(ctx({ clientMatchedBy: 'nombre_asunto' }));
    expect(codes(ds)).toEqual(['PA-08']);
    expect(ds[0].severidad).toBe('informativa');
    expect(ds[0].detalle).toMatchObject({ matchedBy: 'nombre_asunto' });
    expect(tieneError(ds)).toBe(false);
  });

  it('emits exactly one PA-08: unresolved and weakly-resolved are mutually exclusive', () => {
    const ds = cotejarOperacion(ctx({ clientId: null, clientMatchedBy: 'nombre_asunto' }));
    expect(ds.filter((d) => d.codigo === 'PA-08')).toHaveLength(1);
    // With no client at all, the stronger warning wins over the informational note.
    expect(ds[0].severidad).toBe('advertencia');
  });
});

describe('the operation family owns only its own codes', () => {
  it('replaces PA-07/PA-08 on a re-run without touching the manifest findings', () => {
    // The failure this guards against is a caso losing its PA-02 red flag because a later rule family
    // rewrote the whole array.
    const stored: Discrepancia[] = [
      { codigo: 'PA-02', severidad: 'error', mensaje: 'piezas' },
      { codigo: 'PA-08', severidad: 'advertencia', mensaje: 'remitente desconocido' },
    ];
    const fresh = cotejarOperacion(ctx({ guiasDuplicadas: ['A1'] })); // now resolved, now duplicated
    const merged = mergeDiscrepancias(stored, fresh, CODIGOS_OPERACION);
    expect(codes(merged)).toEqual(['PA-02', 'PA-07']);

    // And symmetrically: the manifest family must not erase the operation findings.
    const afterManifest = mergeDiscrepancias(
      merged,
      [{ codigo: 'PA-02', severidad: 'error', mensaje: 'piezas otra vez' }],
      CODIGOS_MANIFIESTO,
    );
    expect(codes(afterManifest).sort()).toEqual(['PA-02', 'PA-07']);
  });
});

describe('determinism', () => {
  it('produces byte-identical findings for identical input, so a finding can be re-derived', () => {
    const input = ctx({ clientId: null, guiasDuplicadas: ['A1', 'A2'] });
    expect(JSON.stringify(cotejarOperacion(input))).toBe(JSON.stringify(cotejarOperacion(input)));
  });

  it('orders PA-07 before PA-08 regardless of input order', () => {
    expect(codes(cotejarOperacion(ctx({ clientId: null, guiasDuplicadas: ['A1'] })))).toEqual([
      'PA-07',
      'PA-08',
    ]);
  });
});
