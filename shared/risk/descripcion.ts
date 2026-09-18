/**
 * descripcion.ts — ¿la descripción alcanza para saber QUÉ es la mercancía?
 *
 * Competencia: el sistema de Hound Express evalúa "¿Es genérica?" como columna propia de su
 * análisis de riesgo. Nosotros no teníamos nada: una línea que dice "artículo" pasaba por el
 * motor sin una sola observación, y con ella se vuelve inútil todo lo que viene después
 * (fracción arancelaria, cotejo de valor, RRNA). Ésta es esa señal.
 *
 * La regla NO mide longitud. "anillo de acero" son 15 caracteres y nombra el objeto; "mercancía
 * general para uso doméstico" son 38 y no nombra nada. Lo que se mide es si queda **al menos un
 * token informativo** — uno que no sea relleno gramatical, material ni un genérico de catálogo.
 *
 * Tres veredictos:
 *   - `vacia`        → no hay texto. Nota: el motor ya manda estas filas a `gris` por
 *                      `insufficientData`; se clasifica igual para que esta función sea
 *                      completa por sí sola y utilizable fuera del scorecard.
 *   - `solo_generica`→ todo lo que dice es un genérico ("mercancía", "gift", "varios").
 *   - `solo_material`→ nombra de qué está hecho pero no qué es ("plástico de cristal").
 *   - `informativa`  → hay un sustantivo útil. No dispara.
 *
 * Determinista y sin modelo: el veredicto sale de tres catálogos cerrados, versionados junto al
 * ruleset. Un catálogo administrable entra por `terminosGenericos` (config `descripciones_genericas`),
 * igual que `prohibited` y `piracy_brands`, y viaja dentro de `resolved.lists` para que el
 * `ruleset_hash` cambie cuando cambia la lista — un score viejo se puede volver a derivar.
 */
import { norm } from './normalize';

/** Genéricos puros: palabras que ocupan el lugar del sustantivo sin decir cuál es. */
export const GENERICOS_DEFAULT: readonly string[] = [
  // español
  'articulo', 'articulos', 'mercancia', 'mercancias', 'producto', 'productos',
  'muestra', 'muestras', 'regalo', 'regalos', 'obsequio', 'obsequios',
  'varios', 'varias', 'otros', 'otras', 'surtido', 'surtidos', 'diversos',
  'accesorio', 'accesorios', 'repuesto', 'repuestos', 'refaccion', 'refacciones',
  'parte', 'partes', 'pieza', 'piezas', 'cosa', 'cosas', 'objeto', 'objetos',
  'articulos varios', 'efectos personales', 'uso personal', 'mercancia general',
  // inglés (los manifiestos llegan mezclados)
  'item', 'items', 'goods', 'good', 'merchandise', 'general merchandise',
  'sample', 'samples', 'gift', 'gifts', 'misc', 'miscellaneous',
  'parts', 'spare', 'spares', 'accessories', 'accessory', 'stuff',
  'personal effects', 'assorted', 'various', 'others', 'other',
];

/** Materiales: dicen de qué está hecho, no qué es. */
export const MATERIALES_DEFAULT: readonly string[] = [
  'plastico', 'acero', 'inoxidable', 'hierro', 'metal', 'metalico', 'aluminio',
  'cobre', 'laton', 'zinc', 'estano', 'vidrio', 'cristal', 'ceramica', 'porcelana',
  'madera', 'bambu', 'papel', 'carton', 'tela', 'textil', 'fibra', 'poliester',
  'algodon', 'lana', 'seda', 'nylon', 'nailon', 'lino', 'piel', 'cuero', 'goma',
  'caucho', 'silicona', 'silicon', 'resina', 'pu', 'pvc', 'abs', 'eva', 'tpu',
  // Los equivalentes en inglés que NO coinciden con la lista de arriba ('metal' y 'nylon' ya
  // están y se escriben igual en los dos idiomas).
  'plastic', 'steel', 'glass', 'wood', 'paper', 'cotton', 'leather', 'rubber',
  'polyester', 'silicone',
];

/**
 * Relleno: preposiciones, artículos y las muletillas de propósito que abundan en los
 * manifiestos traducidos del chino ("para uso doméstico", "uso diario", "para llevar").
 */
export const RELLENO_DEFAULT: readonly string[] = [
  'a', 'al', 'ante', 'con', 'contra', 'de', 'del', 'desde', 'e', 'el', 'en', 'entre',
  'la', 'las', 'lo', 'los', 'o', 'para', 'por', 'segun', 'sin', 'sobre', 'tras',
  'un', 'una', 'unas', 'unos', 'y',
  'uso', 'usar', 'usos', 'llevar', 'uso diario', 'diario', 'domestico', 'domesticos',
  'hogar', 'casa', 'humano', 'humana', 'personal', 'general', 'generales', 'comun',
  'nuevo', 'nueva', 'nuevos', 'nuevas', 'tipo', 'modelo', 'marca', 'estilo', 'color',
  'set', 'kit', 'juego', 'conjunto', 'paquete', 'caja', 'bolsa', 'unidad', 'unidades',
  'pcs', 'pza', 'pzas', 'und', 'uds', 'ea',
  'and', 'for', 'of', 'the', 'to', 'with', 'use', 'used', 'home', 'household', 'daily',
  'new', 'type', 'model', 'brand', 'style', 'color', 'colour', 'pack', 'box', 'bag',
];

export type VeredictoDescripcion = 'vacia' | 'solo_generica' | 'solo_material' | 'informativa';

export interface AnalisisDescripcion {
  veredicto: VeredictoDescripcion;
  /** Tokens que sobrevivieron al filtro; vacío salvo en `informativa`. */
  tokensUtiles: string[];
  /** Los tokens genéricos/material que motivaron el veredicto, para la evidencia del hallazgo. */
  tokensVacios: string[];
}

export interface CatalogosDescripcion {
  /** Sobrescribe `GENERICOS_DEFAULT` (config `descripciones_genericas`). */
  terminosGenericos?: readonly string[];
}

/**
 * Quita el sufijo de cantidad que el manifiesto pega al final de cada descripción
 * ("Linterna Para iluminar * 1"). Sin esto el "1" cuenta como token y nada sería vacío.
 */
function sinSufijoCantidad(s: string): string {
  return s.replace(/\s*[*xX×]\s*\d+\s*$/u, '').trim();
}

function tokenizar(s: string): string[] {
  return norm(sinSufijoCantidad(s))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0 && !/^\p{N}+$/u.test(t));
}

/**
 * Los catálogos traen entradas de varias palabras ("mercancia general", "personal effects").
 * Se indexan por palabra suelta porque el veredicto se decide token a token; la frase completa
 * se cubre sola cuando todas sus palabras están en el set.
 */
function aSet(lista: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const entrada of lista) {
    for (const palabra of norm(entrada).split(/[^\p{L}\p{N}]+/u)) {
      if (palabra) out.add(palabra);
    }
  }
  return out;
}

// Los tres catálogos se indexan UNA vez. `analizarDescripcion` corre por fila y un manifiesto
// grande trae decenas de miles: reconstruir estos sets en cada llamada convertía ~150 `norm` +
// split en trabajo por fila, para un resultado que nunca cambia.
const MATERIALES_SET = aSet(MATERIALES_DEFAULT);
const RELLENO_SET = aSet(RELLENO_DEFAULT);
const GENERICOS_SET = aSet(GENERICOS_DEFAULT);

/**
 * El catálogo administrable sí cambia, pero llega como el MISMO arreglo en todas las filas de un
 * manifiesto (lo inyecta `scoreManifest` una vez). Se cachea por referencia; si el admin edita la
 * config, el arreglo es otro y el set se recalcula solo.
 */
const cacheGenericos = new WeakMap<readonly string[], Set<string>>();

function setGenericos(override?: readonly string[]): Set<string> {
  if (!override) return GENERICOS_SET;
  let set = cacheGenericos.get(override);
  if (!set) {
    set = aSet(override);
    cacheGenericos.set(override, set);
  }
  return set;
}

/**
 * ¿Esta descripción dice qué es la mercancía?
 *
 * Nunca lanza: una descripción ausente o ilegible responde `vacia`, no una excepción — el motor
 * de riesgo corre sobre datos de terceros y una fila mal formada no puede tumbar el manifiesto.
 */
export function analizarDescripcion(
  descripcion: string | null | undefined,
  catalogos?: CatalogosDescripcion,
): AnalisisDescripcion {
  const genericos = setGenericos(catalogos?.terminosGenericos);
  const materiales = MATERIALES_SET;
  const relleno = RELLENO_SET;

  const tokens = tokenizar(descripcion ?? '');
  if (tokens.length === 0) return { veredicto: 'vacia', tokensUtiles: [], tokensVacios: [] };

  const utiles: string[] = [];
  const vacios: string[] = [];
  let vioGenerico = false;
  let vioMaterial = false;

  for (const t of tokens) {
    if (genericos.has(t)) { vioGenerico = true; vacios.push(t); continue; }
    if (materiales.has(t)) { vioMaterial = true; vacios.push(t); continue; }
    if (relleno.has(t)) { vacios.push(t); continue; }
    utiles.push(t);
  }

  if (utiles.length > 0) return { veredicto: 'informativa', tokensUtiles: utiles, tokensVacios: vacios };

  // Sin tokens útiles. Qué tan mal está depende de lo que sí había:
  //   un genérico explícito ("mercancía", "gift") es peor que un material a secas, porque el
  //   material al menos acota la fracción arancelaria a un capítulo.
  if (vioGenerico) return { veredicto: 'solo_generica', tokensUtiles: [], tokensVacios: vacios };
  if (vioMaterial) return { veredicto: 'solo_material', tokensUtiles: [], tokensVacios: vacios };

  // Sólo relleno ("para uso doméstico"): no nombra objeto ni material. Cuenta como genérica.
  return { veredicto: 'solo_generica', tokensUtiles: [], tokensVacios: vacios };
}
