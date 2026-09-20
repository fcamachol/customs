/**
 * Re-export. El catálogo vive en `shared/rrna/catalogo.ts` desde que el servidor también lo
 * necesita: dos copias de una lista regulatoria es la forma más segura de que una se quede vieja.
 */
export { RRNA_PATTERNS, RRNA_LABELS, type RRNACategory } from '../../shared/rrna/catalogo';
