import { normPedimentoNumero } from './subdivision';

export interface PedimentoCoverageInput {
  numeroPedimento: string;
  coveredGuias: string[];
  siblings?: string[];
  isLast?: boolean;
  ordinal?: number | null;
}

export type ManifestCoverageStatus = 'sin_pedimento' | 'parcial' | 'completo';

export interface CoverageResult {
  status: ManifestCoverageStatus;
  expectedCount: number | null;
  uploadedNumeros: string[];
  missingNumeros: string[];
  uncoveredGuias: string[];
  duplicatedGuias: string[];
  manifestGuiaCount: number;
  coveredGuiaCount: number;
}

export function computeCoverage(manifestGuias: string[], pedimentos: PedimentoCoverageInput[]): CoverageResult {
  const uploaded = pedimentos.map((p) => normPedimentoNumero(p.numeroPedimento)).filter(Boolean);
  const uploadedSet = new Set(uploaded);

  // Expected set = union of every pedimento's own number + declared siblings.
  const expected = new Set<string>();
  for (const p of pedimentos) {
    const self = normPedimentoNumero(p.numeroPedimento);
    if (self) expected.add(self);
    for (const s of p.siblings ?? []) {
      const n = normPedimentoNumero(s);
      if (n) expected.add(n);
    }
  }
  const expectedCount = expected.size > 0 ? expected.size : null;
  const missingNumeros = [...expected].filter((n) => !uploadedSet.has(n));

  // Coverage count per manifest guía.
  const coverCount = new Map<string, number>();
  for (const g of manifestGuias) coverCount.set(g, 0);
  for (const p of pedimentos) {
    for (const g of p.coveredGuias) {
      if (coverCount.has(g)) coverCount.set(g, (coverCount.get(g) ?? 0) + 1);
    }
  }
  const uncoveredGuias = [...coverCount].filter(([, c]) => c === 0).map(([g]) => g);
  const duplicatedGuias = [...coverCount].filter(([, c]) => c > 1).map(([g]) => g);
  const coveredGuiaCount = manifestGuias.length - uncoveredGuias.length;

  // A manifest with zero guías can never be 'completo': with nothing to cover, the uncovered/
  // duplicated checks pass vacuously and would paint a green badge over a broken state (manifest
  // whose shipments never loaded). Surface it as 'parcial' so someone looks at it.
  let status: ManifestCoverageStatus;
  if (pedimentos.length === 0) status = 'sin_pedimento';
  else if (manifestGuias.length === 0) status = 'parcial';
  else if (missingNumeros.length === 0 && uncoveredGuias.length === 0 && duplicatedGuias.length === 0) status = 'completo';
  else status = 'parcial';

  return {
    status,
    expectedCount,
    uploadedNumeros: uploaded,
    missingNumeros,
    uncoveredGuias,
    duplicatedGuias,
    manifestGuiaCount: manifestGuias.length,
    coveredGuiaCount,
  };
}
