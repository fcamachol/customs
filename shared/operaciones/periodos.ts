/**
 * periodos.ts — a qué día, semana, mes o año pertenece un instante.
 *
 * Existe porque el tablero tiene que poder contestar "¿cómo vamos este mes contra el año pasado?",
 * y esa pregunta no se puede contestar sin fijar antes DOS convenciones que, mal elegidas, producen
 * números creíbles y falsos:
 *
 * 1. EL DÍA ES LOCAL, NO UTC. Se delega en `fechaLocalMexico` (shared/operaciones/eta.ts), que ya
 *    existe y ya documenta el bug que evita: CDMX va seis horas atrás, así que todo lo que pasa
 *    entre las 18:00 y la medianoche cae en el día SIGUIENTE si se pregunta en UTC. Un vuelo que
 *    aterriza a las 19:30 se contaría en el día que nadie lo trabajó. No se reimplementa aquí a
 *    propósito: dos formas de decidir qué día es un instante terminan discrepando.
 *
 * 2. LA SEMANA ES ISO 8601 — empieza en lunes, y la semana pertenece al año de su JUEVES. Esto
 *    último no es un tecnicismo: el 1 de enero de 2027 cae en viernes, así que esa semana es la
 *    W53 de 2026, no la W01 de 2027. Etiquetarla por el año calendario partiría una semana en dos
 *    años y el comparativo anual arrancaría con una semana de tres días contra una de siete.
 */
import { fechaLocalMexico } from './eta';

export const CORTES = [
  { id: 'dia', label: 'Diario' },
  { id: 'semana', label: 'Semanal' },
  { id: 'mes', label: 'Mensual' },
  { id: 'anio', label: 'Anual' },
] as const;

export type Corte = (typeof CORTES)[number]['id'];

/** Etiqueta usada cuando el instante ancla no existe. Se cuenta aparte; nunca se descarta. */
export const PERIODO_SIN_FECHA = 'sin-fecha';

function aFecha(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Semana ISO de una fecha civil `YYYY-MM-DD`, como `{ anio, semana }`.
 *
 * Toda la aritmética corre en UTC a propósito — no porque el día sea UTC (ya se resolvió antes, en
 * `fechaLocalMexico`) sino porque aquí ya sólo hay una fecha de calendario sin hora, y `Date.UTC`
 * es la única forma de hacer aritmética de calendario sin que el huso del servidor se meta.
 */
export function semanaIso(fechaCivil: string): { anio: number; semana: number } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fechaCivil);
  if (!m) return null;
  const [, y, mes, dia] = m;
  const d = new Date(Date.UTC(Number(y), Number(mes) - 1, Number(dia)));
  if (Number.isNaN(d.getTime())) return null;
  // Lunes=1 … Domingo=7. `getUTCDay()` da 0 para domingo, que rompería el corrimiento.
  const diaSemana = d.getUTCDay() || 7;
  // Salto al jueves de esta semana: el año de ese jueves ES el año ISO de la semana.
  d.setUTCDate(d.getUTCDate() + 4 - diaSemana);
  const anio = d.getUTCFullYear();
  const inicioAnio = Date.UTC(anio, 0, 1);
  const semana = Math.ceil(((d.getTime() - inicioAnio) / 86400000 + 1) / 7);
  return { anio, semana };
}

/**
 * La cubeta a la que pertenece un instante, en el corte pedido.
 *
 * Las etiquetas se eligieron para que ORDENEN ALFABÉTICAMENTE igual que cronológicamente
 * (`2026-01` < `2026-02`, `2026-W09` < `2026-W10`). Así el tablero, el export y cualquier consulta
 * futura ordenan igual sin acordar nada más, y una semana de un dígito no se cuela antes que otra
 * de dos.
 */
export function cubeta(instante: Date | string | null | undefined, corte: Corte): string {
  const d = aFecha(instante);
  if (!d) return PERIODO_SIN_FECHA;
  const civil = fechaLocalMexico(d);
  if (!civil) return PERIODO_SIN_FECHA;
  switch (corte) {
    case 'dia':
      return civil;
    case 'mes':
      return civil.slice(0, 7);
    case 'anio':
      return civil.slice(0, 4);
    case 'semana': {
      const iso = semanaIso(civil);
      return iso ? `${iso.anio}-W${String(iso.semana).padStart(2, '0')}` : PERIODO_SIN_FECHA;
    }
  }
}

/**
 * Parte una etiqueta de cubeta en (año, resto), para comparar el MISMO periodo entre años.
 *
 * El resto es lo que se compara: `09` contra `09`, `W38` contra `W38`. Un corte anual no tiene
 * resto —el año entero ES el periodo— así que devuelve resto vacío y el comparativo anual no
 * aplica; eso lo decide quien llama, no esta función.
 */
export function partirPeriodo(periodo: string): { anio: string; resto: string } | null {
  if (periodo === PERIODO_SIN_FECHA) return null;
  const m = /^(\d{4})(?:-(.+))?$/.exec(periodo);
  if (!m) return null;
  return { anio: m[1], resto: m[2] ?? '' };
}
