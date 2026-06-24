import { describe, expect, it } from 'vitest';
import { computeSeguimientoStatus } from './seguimientoStatus';

describe('computeSeguimientoStatus', () => {
  it('pendiente — nothing captured', () => {
    const r = computeSeguimientoStatus({});
    expect(r.status).toBe('pendiente');
    expect(r.locked).toBe(false);
    expect(r.scanVerdict).toBeNull();
  });

  it('capturado — import data present, no prevalidation, no PDF', () => {
    const r = computeSeguimientoStatus({ importData: { patente: '3250' } });
    expect(r.status).toBe('capturado');
    expect(r.locked).toBe(false);
  });

  it('treats an empty import_data object as pendiente, not capturado', () => {
    expect(computeSeguimientoStatus({ importData: {} }).status).toBe('pendiente');
    expect(computeSeguimientoStatus({ importData: null }).status).toBe('pendiente');
  });

  it('rechazado — prevalidation REJECTED, still editable, still in the pending set', () => {
    const r = computeSeguimientoStatus({ importData: { patente: '3250' }, prevalidationStatus: 'REJECTED' });
    expect(r.status).toBe('rechazado');
    expect(r.locked).toBe(false);
  });

  it('prevalidado — prevalidation APPROVED, no PDF → locked', () => {
    const r = computeSeguimientoStatus({ prevalidationStatus: 'APPROVED' });
    expect(r.status).toBe('prevalidado');
    expect(r.locked).toBe(true);
  });

  it('cargado — PDF uploaded → locked, carries the scan verdict', () => {
    const r = computeSeguimientoStatus({ fileId: 'file-1', scanVerdict: 'clean' });
    expect(r.status).toBe('cargado');
    expect(r.locked).toBe(true);
    expect(r.scanVerdict).toBe('clean');
  });

  it('cargado wins over prevalidado when both a PDF and APPROVED exist', () => {
    const r = computeSeguimientoStatus({ fileId: 'file-1', prevalidationStatus: 'APPROVED', scanVerdict: 'suspicious' });
    expect(r.status).toBe('cargado');
    expect(r.locked).toBe(true);
    expect(r.scanVerdict).toBe('suspicious');
  });

  it('locked set equals APPROVED ∪ file_id (the editable tab is its complement)', () => {
    expect(computeSeguimientoStatus({}).locked).toBe(false);
    expect(computeSeguimientoStatus({ importData: { x: '1' } }).locked).toBe(false);
    expect(computeSeguimientoStatus({ prevalidationStatus: 'REJECTED' }).locked).toBe(false);
    expect(computeSeguimientoStatus({ prevalidationStatus: 'APPROVED' }).locked).toBe(true);
    expect(computeSeguimientoStatus({ fileId: 'f' }).locked).toBe(true);
  });
});
