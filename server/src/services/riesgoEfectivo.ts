import { resolveBands, resolveWeights } from '../../../shared/risk/ruleset';
import type { ReasonCode, SignalId } from '../../../shared/risk/signals';
import {
  colorEfectivo,
  evaluarDisposiciones,
  type DisposicionVigente,
} from '../../../shared/risk/efectivo';

/**
 * `shipments.risk_color_efectivo` — LA ÚNICA materialización del color tras las disposiciones
 * humanas (diseño 2026-08-10, §3).
 *
 * ESTE MÓDULO COPIA A `services/holdActivo.ts`, Y LA PROPIEDAD COPIADA ES LA IMPORTANTE: **la
 * fórmula es ABSOLUTA, no incremental**. Nunca alterna, nunca acumula, nunca confía en la intención
 * de quien llama. Le pregunta a las tablas qué es verdad AHORA —*qué razones produjo el motor en su
 * última corrida y qué afirmó un humano sobre ellas*— y escribe eso. Por eso salen bien, sin ninguna
 * rama especial y sin suposiciones de orden: disponer un hallazgo, retractarse insertando un
 * `confirmado`, corregir el manifiesto de modo que el hallazgo desaparezca, y volver a correr el
 * riesgo con una lista de sancionados nueva. Cada uno de esos cuatro caminos termina en una única
 * llamada a esta función y en el valor correcto.
 *
 * NULL SIGNIFICA "SIN DISPOSICIÓN, MANDA EL MOTOR", y por eso una fila sin disposiciones se escribe
 * con las TRES columnas en NULL en vez de con una copia del color crudo. No es un detalle de
 * eficiencia: es lo que permite que las cuatro superficies de lectura usen `COALESCE` y nada más, y
 * lo que hace que esta fase sea un no-op verificable mientras no exista una sola disposición.
 *
 * NO ESCRIBE AUDITORÍA A PROPÓSITO. Materializar no es un acto humano: es estado DERIVADO de dos
 * hechos que ya están auditados cada uno por su lado (la corrida del motor y la inserción en
 * `riesgo_disposiciones`, que además es append-only). Una fila de auditoría por recálculo diría "el
 * sistema recalculó lo que ya se podía recalcular" y enterraría los actos reales bajo ruido derivado.
 *
 * Recibe la función de consulta de quien llama —la `q` de `withTransaction` o el `query` pelón— por
 * la misma razón que `holdActivo`: hay caminos que materializan dentro de la transacción que acaba de
 * escribir la disposición, y recalcular fuera de ella leería un mundo donde esa fila todavía no
 * existe.
 */

/** La función de consulta que reparte `withTransaction`, y la forma que cumple `query` de `db/pool`. */
export type QueryFn = (text: string, params?: unknown[]) => Promise<any>;

export interface ResultadoMaterializacion {
  /** Filas visitadas: TODAS las del objetivo, porque las que ya no tienen disposición hay que limpiarlas. */
  filas: number;
  /** Filas que quedaron con color efectivo (al menos una disposición vigente sobre ellas). */
  conDisposicion: number;
}

/** El resumen que se denormaliza en `shipments.risk_disposiciones` para que las listas no hagan join. */
interface ResumenDisposiciones {
  aplicadas: Array<{
    id: string;
    signalId: SignalId;
    hallazgoHash: string;
    estado: DisposicionVigente['estado'];
    motivo: string;
    createdAt: string;
    createdBy: string | null;
    revalidacionPendiente: boolean;
  }>;
  /** Las señales que dejaron de contar para el color. Sólo ids de señal: nunca PII. */
  suprimidas: SignalId[];
  /** Las que ya no sostiene ninguna razón vigente. Se listan para que la pantalla pueda explicarlo. */
  caducadas: string[];
  revalidacionPendiente: boolean;
}

interface FilaOro {
  id: string;
  risk_color: string | null;
  risk_reasons: ReasonCode[] | null;
  risk_insufficient_data: boolean | null;
  ruleset_hash: string | null;
}

interface FilaDisposicion {
  id: string;
  shipment_id: string;
  signal_id: SignalId;
  hallazgo_hash: string;
  estado: DisposicionVigente['estado'];
  ruleset_hash: string;
  motivo: string;
  created_at: Date | string;
  created_by: string | null;
}

/**
 * Recalcular el color efectivo de UNA línea o de un manifiesto entero.
 *
 * Se llama al final de cada corrida de riesgo (`riskService`) y tras escribir una disposición
 * (fase 3). Devuelve conteos, no colores: quien necesite el color lo lee de la fila, que es donde
 * acaba de quedar escrito.
 */
export async function materializarRiesgoEfectivo(
  q: QueryFn,
  objetivo: { shipmentId?: string; manifestId?: string },
): Promise<ResultadoMaterializacion> {
  const porManifiesto = Boolean(objetivo.manifestId);
  const clave = objetivo.manifestId ?? objetivo.shipmentId;
  if (!clave) throw new Error('materializarRiesgoEfectivo requiere shipmentId o manifestId');

  const { rows: oro } = (await q(
    `SELECT id, risk_color, risk_reasons, risk_insufficient_data, ruleset_hash
       FROM shipments
      WHERE ${porManifiesto ? 'manifest_id' : 'id'} = $1`,
    [clave],
  )) as { rows: FilaOro[] };
  if (!oro.length) return { filas: 0, conDisposicion: 0 };

  /**
   * LA ÚLTIMA DISPOSICIÓN POR `(línea, señal, huella)` GANA. `riesgo_disposiciones` es append-only:
   * retractarse es INSERTAR un `confirmado` con `supersede_a`, no borrar ni actualizar. Así que la
   * vigencia es una lectura, no un estado que alguien tenga que mantener — y `DISTINCT ON` es
   * exactamente esa lectura. El desempate por `id` sólo importa si dos filas comparten `created_at`
   * al microsegundo; sin él el resultado sería no determinista, y un color que cambia entre dos
   * lecturas idénticas es indefendible ante un auditor.
   */
  const { rows: disposiciones } = (await q(
    `SELECT DISTINCT ON (d.shipment_id, d.signal_id, d.hallazgo_hash)
            d.id, d.shipment_id, d.signal_id, d.hallazgo_hash, d.estado,
            d.ruleset_hash, d.motivo, d.created_at, d.created_by
       FROM riesgo_disposiciones d
      WHERE d.shipment_id = ANY($1::uuid[])
      ORDER BY d.shipment_id, d.signal_id, d.hallazgo_hash, d.created_at DESC, d.id DESC`,
    [oro.map((r) => r.id)],
  )) as { rows: FilaDisposicion[] };

  const porLinea = new Map<string, FilaDisposicion[]>();
  for (const d of disposiciones) {
    const lista = porLinea.get(d.shipment_id);
    if (lista) lista.push(d);
    else porLinea.set(d.shipment_id, [d]);
  }

  /**
   * Pesos y bandas: los MISMOS que usó la corrida que produjo estas razones. Hoy el servidor no
   * expone ninguna clave de config que los sobreescriba (`validation_params` cubre umbrales, que
   * afectan a qué señales disparan y no a cómo se suman), así que los resueltos por defecto son
   * literalmente los de la corrida. El día que exista una clave `weights` o `bands`, ÉSTE es el
   * segundo sitio que tiene que leerla, junto a `services/riskService.ts`.
   */
  const weights = resolveWeights();
  const bands = resolveBands();

  const escrituras: Array<{
    id: string;
    color: string | null;
    score: number | null;
    disposiciones: ResumenDisposiciones | null;
  }> = [];

  for (const fila of oro) {
    const vigentes = porLinea.get(fila.id) ?? [];
    const razones = fila.risk_reasons ?? [];
    // Una línea sin disposiciones —el caso normal, y el único que existe hasta la fase 3— vuelve a
    // NULL SIEMPRE, aunque antes tuviera color efectivo: eso es lo que hace absoluta la fórmula.
    if (!vigentes.length || !fila.risk_color) {
      escrituras.push({ id: fila.id, color: null, score: null, disposiciones: null });
      continue;
    }

    const ev = evaluarDisposiciones(
      razones,
      vigentes.map((d) => ({
        id: d.id,
        signalId: d.signal_id,
        hallazgoHash: d.hallazgo_hash,
        estado: d.estado,
        rulesetHash: d.ruleset_hash,
        motivo: d.motivo,
        createdAt: new Date(d.created_at).toISOString(),
        createdBy: d.created_by,
      })),
      { rulesetHashVigente: fila.ruleset_hash ?? '' },
    );

    if (!ev.aplicadas.length) {
      // Todas caducaron (cambió el dato, o el ruleset en una señal forzada). Sin disposición vigente
      // manda el motor otra vez, y eso se dice con NULL, no copiando su color.
      escrituras.push({ id: fila.id, color: null, score: null, disposiciones: null });
      continue;
    }

    /**
     * La regla de backfill de `risk_insufficient_data`, en una línea. NULL = fila calificada antes de
     * la migración B: se lee como `false` SALVO que la banda cruda sea `gris`, que es justo el caso en
     * que suprimir un forzado-rojo debe devolver `gris` y no `verde`.
     */
    const insufficientData = fila.risk_insufficient_data ?? fila.risk_color === 'gris';

    const { score, band } = colorEfectivo(razones, ev.suprimidas, { weights, bands, insufficientData });
    const pendientes = new Set(ev.revalidacionPendiente.map((d) => d.id));
    escrituras.push({
      id: fila.id,
      color: band,
      score,
      disposiciones: {
        aplicadas: ev.aplicadas.map((d) => ({
          id: d.id,
          signalId: d.signalId,
          hallazgoHash: d.hallazgoHash,
          estado: d.estado,
          motivo: d.motivo,
          createdAt: d.createdAt,
          createdBy: d.createdBy,
          revalidacionPendiente: pendientes.has(d.id),
        })),
        suprimidas: ev.suprimidas.map((r) => r.signalId),
        caducadas: ev.caducadas.map((d) => d.id),
        revalidacionPendiente: pendientes.size > 0,
      },
    });
  }

  /**
   * UN SOLO STATEMENT para todo el objetivo, incluidas las filas que vuelven a NULL. No es una
   * optimización: es la misma razón por la que `materializarHoldActivoAbiertas` no hace un bucle. Un
   * manifiesto puede tener miles de líneas, y dejar la mitad recalculada y la otra mitad con el valor
   * de la corrida anterior —porque algo falló a medio bucle— produciría una pantalla en la que dos
   * filas idénticas muestran colores distintos.
   */
  await q(
    `UPDATE shipments s
        SET risk_color_efectivo = v.color,
            risk_score_efectivo = v.score,
            risk_disposiciones  = v.disposiciones
       FROM jsonb_to_recordset($1::jsonb)
            AS v(id uuid, color text, score integer, disposiciones jsonb)
      WHERE s.id = v.id`,
    [JSON.stringify(escrituras)],
  );

  return {
    filas: oro.length,
    conDisposicion: escrituras.filter((e) => e.color !== null).length,
  };
}
