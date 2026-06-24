import { describe, it } from 'vitest';
// computeSeguimientoStatus was removed (dead production code — records.ts uses computeCoverage).
// SeguimientoScanVerdict is still exported and imported by SeguimientoView; no runtime behaviour
// to test for a plain type alias.

describe('seguimientoStatus module', () => {
  it('exports SeguimientoScanVerdict type (compile-time only; module loads without error)', async () => {
    // If this import resolves, the module is intact.
    await import('./seguimientoStatus');
  });
});
