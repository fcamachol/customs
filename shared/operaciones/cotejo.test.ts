import { describe, expect, it } from 'vitest';
import { COTEJO_RULESET_VERSION, cotejarVuelo, tieneError, type VueloObservado } from './cotejo';

const declarado = {
  numeroVuelo: 'CI5218',
  origenIata: 'HKG',
  destinoIata: 'NLU',
  etaPais: '2026-08-18T06:00:00.000Z',
};

function observado(over: Partial<VueloObservado> = {}): VueloObservado {
  return {
    origenIata: 'HKG',
    destinoIata: 'NLU',
    etaProgramado: '2026-08-18T06:00:00.000Z',
    etaEstimado: null,
    arriboReal: null,
    estado: 'programado',
    fuente: 'flightaware.aeroapi',
    tieneItinerario: true,
    ...over,
  };
}

const codes = (ds: ReturnType<typeof cotejarVuelo>) => ds.map((d) => d.codigo);

describe('cotejarVuelo — the happy path stays silent', () => {
  it('raises nothing when the feed agrees with the declaration', () => {
    expect(cotejarVuelo(declarado, observado())).toEqual([]);
  });
});

describe('PA-04 — route consistency', () => {
  it('fires as an error when the real destination differs', () => {
    const ds = cotejarVuelo(declarado, observado({ destinoIata: 'MEX' }));
    expect(codes(ds)).toContain('PA-04');
    expect(tieneError(ds)).toBe(true);
    expect(ds[0].detalle).toMatchObject({ lado: 'destino', declarado: 'NLU', observado: 'MEX' });
  });

  it('fires for the origin too, and can fire for both sides at once', () => {
    const ds = cotejarVuelo(declarado, observado({ origenIata: 'PVG', destinoIata: 'MEX' }));
    expect(ds.filter((d) => d.codigo === 'PA-04')).toHaveLength(2);
  });

  it('is case-insensitive', () => {
    expect(codes(cotejarVuelo(declarado, observado({ destinoIata: 'nlu' })))).not.toContain('PA-04');
  });

  it('does not treat a missing value as a contradiction', () => {
    // An unknown is not a mismatch. Claiming otherwise would flood the board with false red flags.
    expect(codes(cotejarVuelo(declarado, observado({ destinoIata: null })))).not.toContain('PA-04');
    expect(
      codes(cotejarVuelo({ ...declarado, destinoIata: null }, observado())),
    ).not.toContain('PA-04');
  });
});

describe('PA-05 — ETA consistency', () => {
  it('stays silent inside the tolerance window', () => {
    const ds = cotejarVuelo(declarado, observado({ etaEstimado: '2026-08-18T11:00:00.000Z' }));
    expect(codes(ds)).not.toContain('PA-05');
  });

  it('fires as a warning outside the tolerance window', () => {
    const ds = cotejarVuelo(declarado, observado({ etaEstimado: '2026-08-18T20:00:00.000Z' }));
    const pa05 = ds.find((d) => d.codigo === 'PA-05');
    expect(pa05?.severidad).toBe('advertencia');
    expect(pa05?.detalle).toMatchObject({ base: 'eta_estimado' });
  });

  it('honours a caller-supplied tolerance', () => {
    const obs = observado({ etaEstimado: '2026-08-18T10:00:00.000Z' }); // 4h out
    expect(codes(cotejarVuelo(declarado, obs, { etaToleranciaHoras: 2 }))).toContain('PA-05');
    expect(codes(cotejarVuelo(declarado, obs, { etaToleranciaHoras: 8 }))).not.toContain('PA-05');
  });

  it('prefers an actual arrival over an estimate over the schedule', () => {
    const ds = cotejarVuelo(
      declarado,
      observado({ arriboReal: '2026-08-19T06:00:00.000Z', etaEstimado: '2026-08-18T06:30:00.000Z' }),
    );
    expect(ds.find((d) => d.codigo === 'PA-05')?.detalle).toMatchObject({ base: 'arribo_real' });
  });

  it('reports itself as uncheckable, not as passing, when the source saw the aircraft but has no itinerary', () => {
    // The genuine ADS-B case: a position WAS observed, there is just no schedule to compare against.
    // Silence here would make an unverified ETA look verified.
    const ds = cotejarVuelo(
      declarado,
      observado({
        tieneItinerario: false,
        posicionVista: true,
        etaProgramado: null,
        etaEstimado: null,
        fuente: 'adsb.lol',
      }),
    );
    const pa05 = ds.find((d) => d.codigo === 'PA-05');
    expect(pa05?.severidad).toBe('informativa');
    expect(tieneError(ds)).toBe(false);
  });
});

describe('PA-10 — unverifiable flight', () => {
  it('fires when a position-only provider returned a snapshot but OBSERVED NOTHING', () => {
    // The masking bug this guards against, found on live data: adsb.lol returns a snapshot even when it
    // finds no aircraft — it is recording that it looked — and treating that as an observation made an
    // unidentifiable flight read as perfectly clean. Which is the one case a human must be told about.
    const ds = cotejarVuelo(
      declarado,
      observado({
        tieneItinerario: false,
        posicionVista: false,
        etaProgramado: null,
        etaEstimado: null,
        origenIata: null,
        destinoIata: null,
        fuente: 'adsb.lol',
      }),
    );
    expect(codes(ds)).toEqual(['PA-10']);
    expect(ds[0].detalle).toMatchObject({ fuente: 'adsb.lol' });
  });

  it('fires as a warning when no source could identify the flight', () => {
    const ds = cotejarVuelo(declarado, null);
    expect(codes(ds)).toEqual(['PA-10']);
    // A warning, not an error: bare digits or an unmapped carrier are the common causes and neither
    // implies wrongdoing. But it must never be silent.
    expect(ds[0].severidad).toBe('advertencia');
    expect(tieneError(ds)).toBe(false);
  });
});

describe('determinism', () => {
  it('is reproducible and version-stamped, so a finding can be re-derived on demand', () => {
    const a = cotejarVuelo(declarado, observado({ destinoIata: 'MEX' }));
    const b = cotejarVuelo(declarado, observado({ destinoIata: 'MEX' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Pinned to a literal on purpose: the version is the handle an auditor uses to re-derive a
    // finding, so a bump must be a deliberate edit here rather than something that drifts silently.
    // Bumped to 2026-08b when PA-07/PA-08 (cotejarOperacion) joined the ruleset, and to 2026-08c when
    // PA-01..PA-03 became provenance-aware (an inferred value can no longer produce an `error`), which
    // CHANGES the severity a stored finding replays with — exactly the kind of change the stamp exists
    // to make visible.
    expect(COTEJO_RULESET_VERSION).toBe('2026-08c');
  });
});
