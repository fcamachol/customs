// The living plan and its diff (R14, R19, principle P4).
//
// WHAT THIS REPLACES. Today the day's programme is an Excel workbook mailed to the warehouse, to the
// transportista and to the client; when something changes, a second workbook is mailed, and from
// that moment nobody in the chain can say with certainty which version they are working from. The
// meeting's phrase for the fix was "sustituye el Excel corrigiendo al Excel": the plan stays a
// document people receive, but it is versioned, and every version after the first ships with the
// DELTA rather than asking the reader to spot it.
//
// WHY THE DIFF IS COMPUTED HERE AND NOT IN SQL. It is the part of the feature that has to be
// reproducible on demand and reviewable by a human: a published version stores its own snapshot and
// its own diff, so re-deriving the delta between any two versions later must give the same answer as
// the one that was mailed. Pure functions over stored snapshots do that; a query against the live
// tables would silently re-answer the question against today's data.
//
// The snapshot is deliberately a FLAT, human-shaped document — folios, plates, guías, client names —
// not a graph of ids. Six weeks later the reader is a warehouse supervisor or an auditor, not this
// codebase, and a snapshot full of uuids would preserve nothing they can check.

export interface PlanPartidaSnapshot {
  /** House guía, normalized — the line the warehouse actually picks. */
  guia: string;
  /** The guía máster it travels under, so the line stays traceable if the caso is gone. */
  mawb: string;
  cliente: string | null;
  cartones: number | null;
  piezas: number | null;
  /** The consecutive the warehouse asked for (R14). */
  ordenCarga: number | null;
}

export interface PlanDespachoSnapshot {
  folio: string;
  tipoUnidad: string;
  transportista: string | null;
  placas: string | null;
  operadorNombre: string | null;
  destino: string | null;
  estado: string;
  citaAt: string | null;
  partidas: PlanPartidaSnapshot[];
}

/** A caso that could have been planned and was not, WITH the reason. */
export interface PlanExclusionSnapshot {
  mawb: string;
  guia: string | null;
  causa: string;
  detalle: string | null;
}

export interface PlanSnapshot {
  /** YYYY-MM-DD. */
  fechaOperacion: string;
  generadoAt: string;
  despachos: PlanDespachoSnapshot[];
  exclusiones: PlanExclusionSnapshot[];
}

export interface CambioCampo {
  antes: unknown;
  despues: unknown;
}

export interface PlanDespachoDiff {
  folio: string;
  cambios: Record<string, CambioCampo>;
  partidasAgregadas: string[];
  partidasRetiradas: string[];
  /** Guías whose loading consecutive moved — the warehouse re-stacks on this alone (R14). */
  ordenCargaCambiada: Array<{ guia: string; antes: number | null; despues: number | null }>;
}

export interface PlanDiff {
  despachosAgregados: string[];
  despachosRetirados: string[];
  despachosModificados: PlanDespachoDiff[];
  exclusionesAgregadas: PlanExclusionSnapshot[];
  exclusionesResueltas: PlanExclusionSnapshot[];
  /** True only for the first published version of a date. */
  esPrimeraVersion: boolean;
  /** True when nothing at all moved — the caller decides whether that is worth mailing. */
  sinCambios: boolean;
}

/** Fields whose change is worth telling the warehouse and the transportista about. */
const CAMPOS_COMPARADOS: Array<keyof PlanDespachoSnapshot> = [
  'tipoUnidad',
  'transportista',
  'placas',
  'operadorNombre',
  'destino',
  'estado',
  'citaAt',
];

function porFolio(s: PlanSnapshot): Map<string, PlanDespachoSnapshot> {
  return new Map(s.despachos.map((d) => [d.folio, d]));
}

function claveExclusion(e: PlanExclusionSnapshot): string {
  return `${e.mawb}|${e.guia ?? ''}|${e.causa}`;
}

/**
 * The delta between the previously published version and the one about to be published.
 *
 * `anterior === null` means this is version 1: everything in it is new, and `esPrimeraVersion`
 * says so explicitly rather than leaving the reader to infer it from an all-additions diff — the
 * first plan of the day and a plan that replaced every unit are very different pieces of news.
 *
 * A folio present in both is compared field by field AND line by line. The line comparison is
 * separate from the field comparison on purpose: a unit that kept its plates but lost two guías is
 * the change the warehouse cares about most, and folding it into a generic "modified" would bury it.
 */
export function diffPlan(anterior: PlanSnapshot | null, actual: PlanSnapshot): PlanDiff {
  const previos = anterior ? porFolio(anterior) : new Map<string, PlanDespachoSnapshot>();
  const actuales = porFolio(actual);

  const despachosAgregados = [...actuales.keys()].filter((f) => !previos.has(f)).sort();
  const despachosRetirados = [...previos.keys()].filter((f) => !actuales.has(f)).sort();

  const despachosModificados: PlanDespachoDiff[] = [];
  for (const [folio, ahora] of actuales) {
    const antes = previos.get(folio);
    if (!antes) continue;

    const cambios: Record<string, CambioCampo> = {};
    for (const campo of CAMPOS_COMPARADOS) {
      if ((antes[campo] ?? null) !== (ahora[campo] ?? null)) {
        cambios[campo] = { antes: antes[campo] ?? null, despues: ahora[campo] ?? null };
      }
    }

    const guiasAntes = new Map(antes.partidas.map((p) => [p.guia, p]));
    const guiasAhora = new Map(ahora.partidas.map((p) => [p.guia, p]));
    const partidasAgregadas = [...guiasAhora.keys()].filter((g) => !guiasAntes.has(g)).sort();
    const partidasRetiradas = [...guiasAntes.keys()].filter((g) => !guiasAhora.has(g)).sort();

    const ordenCargaCambiada: PlanDespachoDiff['ordenCargaCambiada'] = [];
    for (const [guia, p] of guiasAhora) {
      const previa = guiasAntes.get(guia);
      if (previa && (previa.ordenCarga ?? null) !== (p.ordenCarga ?? null)) {
        ordenCargaCambiada.push({
          guia,
          antes: previa.ordenCarga ?? null,
          despues: p.ordenCarga ?? null,
        });
      }
    }
    ordenCargaCambiada.sort((a, b) => a.guia.localeCompare(b.guia));

    if (
      Object.keys(cambios).length ||
      partidasAgregadas.length ||
      partidasRetiradas.length ||
      ordenCargaCambiada.length
    ) {
      despachosModificados.push({
        folio,
        cambios,
        partidasAgregadas,
        partidasRetiradas,
        ordenCargaCambiada,
      });
    }
  }
  despachosModificados.sort((a, b) => a.folio.localeCompare(b.folio));

  const exclAntes = new Map((anterior?.exclusiones ?? []).map((e) => [claveExclusion(e), e]));
  const exclAhora = new Map(actual.exclusiones.map((e) => [claveExclusion(e), e]));
  const exclusionesAgregadas = [...exclAhora.entries()]
    .filter(([k]) => !exclAntes.has(k))
    .map(([, e]) => e);
  // "Resuelta" is the honest word: the caso stopped being excluded. It does NOT assert that it was
  // planned — it may simply have left the date. The snapshot pair is what a reader checks.
  const exclusionesResueltas = [...exclAntes.entries()]
    .filter(([k]) => !exclAhora.has(k))
    .map(([, e]) => e);

  return {
    despachosAgregados,
    despachosRetirados,
    despachosModificados,
    exclusionesAgregadas,
    exclusionesResueltas,
    esPrimeraVersion: anterior === null,
    sinCambios:
      !despachosAgregados.length &&
      !despachosRetirados.length &&
      !despachosModificados.length &&
      !exclusionesAgregadas.length &&
      !exclusionesResueltas.length,
  };
}

/** One-line human summary for the notification body and the timeline payload. */
export function resumenDiff(diff: PlanDiff): string {
  if (diff.esPrimeraVersion) {
    return `Plan inicial: ${diff.despachosAgregados.length} unidad(es) programada(s).`;
  }
  if (diff.sinCambios) return 'Sin cambios respecto de la versión anterior.';
  const partes: string[] = [];
  if (diff.despachosAgregados.length) partes.push(`${diff.despachosAgregados.length} unidad(es) agregada(s)`);
  if (diff.despachosRetirados.length) partes.push(`${diff.despachosRetirados.length} retirada(s)`);
  if (diff.despachosModificados.length) partes.push(`${diff.despachosModificados.length} modificada(s)`);
  if (diff.exclusionesAgregadas.length) partes.push(`${diff.exclusionesAgregadas.length} exclusión(es) nueva(s)`);
  if (diff.exclusionesResueltas.length) partes.push(`${diff.exclusionesResueltas.length} exclusión(es) resuelta(s)`);
  return partes.join('; ') + '.';
}
