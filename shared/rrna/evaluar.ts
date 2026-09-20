/**
 * evaluar.ts — qué regulaciones no arancelarias parece tocar una guía.
 *
 * Sabueso evalúa RRNA como columna de su análisis de riesgo. Nosotros teníamos el catálogo entero
 * (`./catalogo.ts`) y el campo `rrnaNote` del manifiesto, y ninguna de las dos cosas se miraba.
 *
 * TRES DECISIONES QUE DEFINEN QUÉ VALE ESTE MÓDULO:
 *
 * 1. **El resultado es INFORMATIVO, no un veredicto.** El catálogo es por palabra clave, así que
 *    "aceite" pega igual en aceite de oliva que en aceite para cadena de bicicleta. Un match dice
 *    "esto se parece a algo que requiere permiso", que es una pregunta para quien revisa, no una
 *    respuesta. Por eso nada de esto alimenta el semáforo.
 *
 * 2. **Las coincidencias se devuelven con el término que las disparó.** Sin eso, "COFEPRIS" a secas
 *    obliga a adivinar por qué; con `termino: 'crema'` quien revisa descarta en dos segundos un
 *    falso positivo, que es la diferencia entre una columna que se usa y una que se ignora.
 *
 * 3. **`ZERO_VALUE` no se busca por texto.** Su lista de patrones está vacía en el catálogo a
 *    propósito —lo dice su propio comentario— porque es una condición numérica. Se evalúa aparte,
 *    contra el valor declarado, y no contra la descripción.
 */
import { RRNA_PATTERNS, RRNA_LABELS, type RRNACategory } from './catalogo';
import { norm } from '../risk/normalize';

export interface CoincidenciaRrna {
  categoria: RRNACategory;
  label: string;
  autoridad: string;
  descripcion: string;
  /** El término del catálogo que disparó la coincidencia, para poder descartar un falso positivo. */
  termino: string;
}

export interface EntradaRrna {
  descripcion?: string | null;
  /** El valor declarado, para `ZERO_VALUE`. `null`/ausente = no se evalúa esa categoría. */
  valorDeclarado?: number | null;
  /** Lo que el remitente escribió en la columna de RRNA del manifiesto. Se conserva tal cual. */
  rrnaNote?: string | null;
}

/**
 * Coincidencia por PALABRA COMPLETA, no por subcadena.
 *
 * El catálogo trae patrones de tres letras (`'te '`, `'gel'`, `'oil'`). Buscados como subcadena,
 * `te` pega en "teléfono", "textil" y "terminal", y `gel` en "gelatina" y "ángel": la columna se
 * llenaría de coincidencias que nadie puede descartar sin abrir cada guía. Rodear ambos lados de
 * espacios cuesta una línea y elimina esa clase entera de falso positivo. Los patrones de varias
 * palabras ("protector solar") siguen funcionando igual.
 *
 * El precio es recall: "chocolates" no pega con el patrón "chocolate". Es el lado correcto en el
 * que equivocarse — esto es una lista de triaje para un humano, y una que grita en todo deja de
 * leerse. Si hace falta, el catálogo admite la forma plural como una entrada más.
 */
function contiene(textoNorm: string, patron: string): boolean {
  const p = norm(patron).replace(/\s+/gu, ' ').trim();
  if (!p) return false;
  return ` ${textoNorm} `.includes(` ${p} `);
}

/**
 * Evalúa una guía contra el catálogo.
 *
 * Devuelve una coincidencia por categoría como máximo —la primera que pegue—, no una por palabra:
 * marcar tres veces COFEPRIS porque la descripción dice "crema", "gel" y "jabón" no agrega
 * información y ensucia la columna.
 */
export function evaluarRrna(
  entrada: EntradaRrna,
  patrones: Record<string, readonly string[]> = RRNA_PATTERNS,
): CoincidenciaRrna[] {
  const out: CoincidenciaRrna[] = [];
  const textoNorm = norm(entrada.descripcion ?? '').replace(/\s+/gu, ' ').trim();

  for (const [cat, lista] of Object.entries(patrones)) {
    const categoria = cat as RRNACategory;
    if (categoria === 'ZERO_VALUE') continue; // condición numérica, se evalúa abajo
    if (!textoNorm) continue;
    const termino = lista.find((p) => contiene(textoNorm, p));
    if (termino) {
      const meta = RRNA_LABELS[categoria];
      out.push({
        categoria,
        label: meta?.label ?? categoria,
        autoridad: meta?.authority ?? '',
        descripcion: meta?.description ?? '',
        termino,
      });
    }
  }

  // ZERO_VALUE: RGCE 3.7.3 prohíbe declarar valor cero. Se evalúa sólo si el valor VINO; una guía
  // sin valor declarado es un dato faltante, no un cero — y confundirlos inventaría la infracción.
  const v = entrada.valorDeclarado;
  if (typeof v === 'number' && Number.isFinite(v) && v <= 0) {
    const meta = RRNA_LABELS.ZERO_VALUE;
    out.push({
      categoria: 'ZERO_VALUE',
      label: meta?.label ?? 'Valor Cero',
      autoridad: meta?.authority ?? '',
      descripcion: meta?.description ?? '',
      termino: String(v),
    });
  }

  return out;
}
