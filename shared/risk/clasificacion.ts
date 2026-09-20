/**
 * clasificacion.ts — ¿la misma mercancía va declarada bajo dos fracciones distintas?
 *
 * Competencia: Sabueso evalúa "¿Permite la clasificación correcta?" como columna propia. Responder
 * eso de verdad —si la descripción alcanza para asignar LA fracción correcta— exige un catálogo
 * TIGIE al día, que es un compromiso permanente y no una feature. Ésta es la parte de esa pregunta
 * que sí se puede contestar sin catálogo, y que además es la que un auditor puede verificar solo:
 *
 *   si la misma mercancía aparece en el mismo manifiesto bajo dos fracciones distintas,
 *   al menos una de las dos está mal, sin necesidad de saber cuál.
 *
 * Es una contradicción interna, no una opinión sobre la clasificación. Por eso no requiere fuente
 * externa y por eso es defendible meses después: la evidencia es el propio manifiesto.
 *
 * Por qué NO se marca la fracción "los demás" (las que terminan en 99/90), que sería lo obvio:
 * se midió sobre el manifiesto golden de 501 filas y marca 131 —el 26%—. Una señal que barre un
 * cuarto del manifiesto no dirige la revisión a ningún lado. La contradicción marca 6 (1.2%).
 */
import { norm } from './normalize';

/** Quita el sufijo de cantidad que el manifiesto pega al final ("Linterna * 1"). */
function sinSufijoCantidad(s: string): string {
  return s.replace(/\s*[*xX×]\s*\d+\s*$/u, '').trim();
}

/**
 * La clave por la que dos líneas cuentan como "la misma mercancía".
 *
 * Deliberadamente conservadora: normalización de acentos y espacios, nada más. NO reduce a tokens
 * informativos ni agrupa sinónimos. Agrupar de más aquí no produce una señal más sensible, produce
 * una acusación falsa —"clasificaste igual dos cosas distintas"— que es justo lo que destruye la
 * confianza en el semáforo. Cuando dos descripciones son literalmente la misma cadena y las
 * fracciones difieren, no hay margen de interpretación.
 *
 * Devuelve null cuando no hay descripción: sin clave no hay grupo, y una fila sin descripción ya la
 * marca `descripcion_generica`.
 */
export function claveMercancia(descripcion: string | null | undefined): string | null {
  const v = norm(sinSufijoCantidad(descripcion ?? '')).replace(/\s+/gu, ' ').trim();
  return v.length > 0 ? v : null;
}

/**
 * La fracción arancelaria a 8 dígitos, que es el nivel en el que se decide la clasificación.
 *
 * Los últimos dos dígitos de una fracción de 10 son el NICO (número de identificación comercial),
 * que desagrega dentro de la MISMA fracción. Dos líneas con igual fracción y distinto NICO no se
 * contradicen en la clasificación, así que compararlas a 10 dígitos inventaría hallazgos.
 *
 * Devuelve null si no hay 8 dígitos que leer — `validateManifest` ya avisa del formato, y esta capa
 * no vuelve a opinar sobre eso.
 */
export function fraccionBase(hsCode: string | null | undefined): string | null {
  const d = String(hsCode ?? '').replace(/\D/gu, '');
  return d.length >= 8 ? d.slice(0, 8) : null;
}

export interface IndiceClasificacion {
  /** clave de mercancía → fracciones distintas (a 8 dígitos) con las que se declaró, ordenadas. */
  fraccionesPorMercancia: Record<string, string[]>;
}

/**
 * PASO 1: recorre el manifiesto y agrupa fracciones por mercancía.
 *
 * Se construye una vez por manifiesto, igual que `entityValueTotal` y `addressDistinctConsignees`,
 * porque es una propiedad del conjunto y no de la fila: una sola línea nunca se contradice consigo
 * misma.
 */
export function indexarClasificacion(
  filas: ReadonlyArray<{ description?: string | null; hsCode?: string | null }>,
): IndiceClasificacion {
  const acc = new Map<string, Set<string>>();
  for (const f of filas) {
    const clave = claveMercancia(f.description);
    const fraccion = fraccionBase(f.hsCode);
    if (!clave || !fraccion) continue;
    let set = acc.get(clave);
    if (!set) { set = new Set<string>(); acc.set(clave, set); }
    set.add(fraccion);
  }
  const out: Record<string, string[]> = {};
  for (const [clave, set] of acc) {
    // Sólo los grupos en conflicto. Guardar los demás sería cargar un índice del tamaño del
    // manifiesto entero para consultar un puñado de claves.
    if (set.size > 1) out[clave] = [...set].sort();
  }
  return { fraccionesPorMercancia: out };
}
