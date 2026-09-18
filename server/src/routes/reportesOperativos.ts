import { Router, type Request, type Response, type NextFunction } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { validate } from '../validation/middleware';
import { reporteOperativoQuery, type ReporteOperativoQuery } from '../validation/schemas';
import { etiquetaTipoUnidad } from '../../../shared/operaciones/catalogos';
import { resolverTasa, tipoOrigenDe, type TasaVigencia } from '../../../shared/impuestos/tasaGlobal';
import {
  LEAD_TIME_RULESET_VERSION,
  METRICAS_LEAD_TIME,
  calcularLeadTimes,
  resumirLeadTimes,
  type LeadTimes,
} from '../../../shared/operaciones/leadTimes';

/**
 * OPERATIONAL REPORTING — points 6 and 7 of the authorised requirement (Fase C).
 *
 * TWO REPORTS, ONE QUERY, AND THAT IS THE POINT. The client's spreadsheet had a "Reportes" tab and a
 * "Dashboard" tab, and they disagreed with each other because each was maintained by hand. Here they
 * are two renderings of the SAME row set: the combined export is every operational and financial
 * column side by side, and the lead-time report is the arithmetic over those same rows
 * (shared/operaciones/leadTimes.ts, version-stamped and unit-tested). Two views that cannot drift.
 *
 * WHY ONE ROW PER GUÍA AND NOT PER CASO. The unit somebody asks about is the house guía: it is what
 * the client wrote in the email, what the pedimento covers, what rides on a truck and what an invoice
 * line charges for. A caso-level row would have to collapse several guías that may have taken
 * different trucks on different days — which is the summarisation that made the spreadsheet unable
 * to answer anything specific. A caso with no guías still produces its row, because a shipment whose
 * manifest never arrived is exactly the kind of thing a report must not hide.
 *
 * THE DATE AXIS IS THE CASO'S OWN CLOCK, not the trip's: `arribo_vuelo_at`, falling back to
 * `created_at`. Filtering by `despachos.fecha_operacion` would silently drop every shipment that
 * never got a truck — the excluded, the held, the delayed — and those are precisely the rows a
 * coordinator opens the report to find.
 *
 * NO CONSIGNEE PII TRAVELS IN THESE COLUMNS, which is why `autoridad` reads them without the
 * redaction machinery `routes/reports.ts` needs: guía, flight, timestamps, folios and amounts are
 * operational facts about cargo, not identity data about people. The access is still audited.
 */
export const reportesOperativosRouter = Router();

/**
 * The row behind both reports.
 *
 * `LEFT JOIN` all the way down on purpose: every join is a stage the shipment may not have reached
 * yet, and an INNER JOIN anywhere would turn "not delivered yet" into "does not exist".
 */
const SQL_FILAS = `
  SELECT o.id                        AS "operacionId",
         o.mawb,
         g.id                        AS "operacionGuiaId",
         g.guia_norm                 AS "guia",
         c.name                      AS "cliente",
         o.numero_vuelo              AS "numeroVuelo",
         o.origen_iata               AS "origenIata",
         o.destino_iata              AS "destinoIata",
         o.etd_origen                AS "etdOrigen",
         o.eta_pais                  AS "etaPais",
         o.arribo_vuelo_at           AS "arriboVueloAt",
         o.disponible_at             AS "disponibleAt",
         o.modulacion_at             AS "modulacionAt",
         o.salida_rojo_at            AS "salidaRojoAt",
         o.etapa,
         o.estado_documental         AS "estadoDocumental",
         o.estado_planeacion         AS "estadoPlaneacion",
         o.semaforo,
         o.hold_activo               AS "holdActivo",
         COALESCE(jsonb_array_length(o.discrepancias), 0) AS "banderas",
         COALESCE(g.piezas, o.piezas_prealerta)    AS "piezas",
         COALESCE(g.cartones, o.cartones_prealerta) AS "cartones",
         COALESCE(g.peso_kg, o.peso_kg_prealerta)   AS "pesoKg",
         g.estado                    AS "estadoGuia",
         ped.numero_pedimento        AS "pedimento",
         d.id                        AS "despachoId",
         d.folio                     AS "despachoFolio",
         d.fecha_operacion           AS "fechaOperacion",
         d.tipo_unidad               AS "tipoUnidad",
         t.razon_social              AS "transportista",
         d.placas,
         cd.alias                    AS "destinoEntrega",
         d.estado                    AS "estadoDespacho",
         d.cita_at                   AS "citaAt",
         d.ingreso_patio_at          AS "ingresoPatioAt",
         d.ingreso_aduana_at         AS "ingresoAduanaAt",
         d.inicio_carga_at           AS "inicioCargaAt",
         d.fin_carga_at              AS "finCargaAt",
         d.salida_at                 AS "salidaAt",
         d.eta_calculado             AS "etaCalculado",
         d.arribo_real               AS "arriboReal",
         d.tarifa_monto              AS "costoFlete",
         pod.folio                   AS "podFolio",
         pod.estado                  AS "podEstado",
         pod.firmado_por             AS "firmadoPor",
         pod.firmado_at              AS "podFirmadoAt",
         f.folio                     AS "facturaFolio",
         f.tipo                      AS "facturaTipo",
         f.uuid_cfdi                 AS "uuidCfdi",
         f.estado                    AS "facturaEstado",
         f.periodo                   AS "periodoFactura",
         fp.importe                  AS "importeFacturado",
         f.moneda                    AS "monedaFactura",
         g.pedimento_id              AS "pedimentoId",
         sh.valor_aduanal_usd        AS "valorAduanalUsd",
         sh.origen_tasa              AS "origenTasa",
         -- El día se resuelve AQUÍ, casteado a date igual que el WHERE y el ORDER BY de abajo, no
         -- con toISOString() en JS: eso daría el día en UTC mientras el filtro usa la zona del
         -- servidor, y un arribo de las 19:00 hora de México caería en el día siguiente. Un reporte
         -- de agosto con una fila estimada a la tasa de septiembre es justo la cifra irreproducible
         -- que este módulo existe para evitar.
         COALESCE(o.arribo_vuelo_at, o.created_at)::date AS "fechaReferencia"
    FROM operaciones o
    LEFT JOIN operacion_guias g ON g.operacion_id = o.id
    LEFT JOIN clients c ON c.id = COALESCE(g.client_id, o.client_id)
    LEFT JOIN pedimentos ped ON ped.id = g.pedimento_id
    LEFT JOIN despacho_partidas dp
           ON dp.operacion_id = o.id
          AND (dp.operacion_guia_id = g.id OR (dp.operacion_guia_id IS NULL AND g.id IS NULL))
    LEFT JOIN despachos d ON d.id = dp.despacho_id
    LEFT JOIN transportistas t ON t.id = d.transportista_id
    LEFT JOIN client_direcciones cd ON cd.id = d.direccion_entrega_id
    LEFT JOIN pods pod ON pod.despacho_id = d.id
    LEFT JOIN factura_partidas fp
           ON fp.operacion_id = o.id
          AND (fp.operacion_guia_id = g.id OR (fp.operacion_guia_id IS NULL AND g.id IS NULL))
    LEFT JOIN facturas f ON f.id = fp.factura_id AND f.estado <> 'cancelada'
    -- Valor aduanal y origen de la guía, sumados desde las líneas del manifiesto. El join va por la
    -- guía NORMALIZADA con la misma regla que normGuia() en shared/pedimento/guia.ts (quitar todo lo
    -- que no sea alfanumérico y pasar a mayúsculas), porque operacion_guias.guia_norm se escribió con
    -- esa función y el manifiesto guarda la guía tal como venía escrita.
    LEFT JOIN LATERAL (
      -- El cast va detrás de una guarda de tipo: shipments.data es jsonb libre sin CHECK, y un
      -- solo valor no numérico ahí tumbaría la consulta entera con 22P02 — el reporte completo
      -- respondería 500 en lugar de degradar esta columna a "sin valor aduanal".
      SELECT SUM(CASE WHEN jsonb_typeof(s.data->'customsValueUsd') = 'number'
                      THEN (s.data->>'customsValueUsd')::numeric END) AS valor_aduanal_usd,
             -- El origen NO se agrega con MIN(). 'CA' precede alfabéticamente a casi todo, así que
             -- una guía con líneas de CA y de CN colapsaría a TMEC y se estimaría entera con la tasa
             -- más baja. La regla del módulo de tasas es la contraria: ante duda, nunca subestimar.
             -- Basta UNA línea fuera del T-MEC para que la guía se estime como GENERAL.
             CASE WHEN bool_and(COALESCE(UPPER(TRIM(s.data->'sender'->>'countryCode')), '') IN ('MX','US','CA'))
                  THEN 'TMEC' ELSE 'GENERAL' END AS origen_tasa
        FROM shipments s
       WHERE s.manifest_id = o.manifest_id
         AND g.guia_norm IS NOT NULL
         AND UPPER(REGEXP_REPLACE(COALESCE(s.data->>'guideId', ''), '[^a-zA-Z0-9]', '', 'g')) = g.guia_norm
    ) sh ON TRUE
   WHERE ($1::date IS NULL OR COALESCE(o.arribo_vuelo_at, o.created_at)::date >= $1::date)
     AND ($2::date IS NULL OR COALESCE(o.arribo_vuelo_at, o.created_at)::date <= $2::date)
     AND ($3::uuid IS NULL OR COALESCE(g.client_id, o.client_id) = $3::uuid)
   ORDER BY COALESCE(o.arribo_vuelo_at, o.created_at) DESC, o.mawb, g.guia_norm
   LIMIT 5000`;

type Fila = Record<string, any>;

/**
 * Tabla de tasas vigentes (configuración "Tasa global", Super Admin). Misma fuente que usa el
 * estimado del cotejo en `routes/pedimentoUpload.ts`. Devuelve null si no está configurada — el
 * estimado entonces se omite con nota.
 *
 * MISMA TABLA NO ES MISMO NÚMERO, y conviene saberlo antes de conciliar los dos: el cotejo estima
 * sobre la FECHA DE ENTRADA del pedimento y partida por partida; este reporte, sobre el DÍA DE LA
 * OPERACIÓN y agregando por guía. Para un embarque a caballo de un cambio de vigencia las dos
 * cifras difieren legítimamente, y en guías multi-línea pueden diferir en centavos por el momento
 * del redondeo. Unificarlos exige decidir cuál es la fecha canónica del estimado — una decisión de
 * negocio, no de código.
 */
async function cargarVigencias(): Promise<TasaVigencia[] | null> {
  const { rows } = await query<{ value: TasaVigencia[] | null }>(
    `SELECT value FROM config WHERE key = 'tasa_vigencias'`,
  );
  const v = rows[0]?.value;
  return Array.isArray(v) && v.length ? v : null;
}

async function cargarFilas(f: ReporteOperativoQuery): Promise<Fila[]> {
  const { rows } = await query(SQL_FILAS, [f.desde ?? null, f.hasta ?? null, f.clientId ?? null]);
  return rows as Fila[];
}

/**
 * Estimado de impuesto de la guía, para el export.
 *
 * CUATRO REGLAS, todas aprendidas a golpes:
 *
 * 1. SÓLO SE ESTIMA LO QUE VA AL PEDIMENTO. Una guía sin pedimento es carga que el análisis de
 *    riesgo no dejó pasar o que aún no se transmitió — "no puedo calcular impuestos sobre algo que
 *    no puede pasar". La condición es `pedimentoId`, NO el número de pedimento: un PDF escaneado
 *    ilegible produce un pedimento real con `numero_pedimento` null, y usar el número diría
 *    "No va al pedimento" sobre carga que sí se despacha — la mentira más cara que esta columna
 *    puede contar.
 * 2. LA TASA ES LA VIGENTE EL DÍA DE LA OPERACIÓN, y ese día llega ya resuelto desde SQL, en el
 *    mismo eje de fechas con el que el reporte filtra y ordena.
 * 3. SIN TASA CONFIGURADA NO HAY ESTIMADO: null con motivo, nunca un default.
 * 4. EL NÚMERO SE ESCRIBE UNA SOLA VEZ POR GUÍA. Ver `marcarPrimeraFilaPorGuia`.
 */
function estimadoDeFila(r: Fila, vigencias: TasaVigencia[] | null): {
  valorUsd: number | null;
  origen: 'GENERAL' | 'TMEC' | null;
  tasaPct: number | null;
  impuestoUsd: number | null;
  nota: string;
} {
  const vacio = { valorUsd: null, origen: null, tasaPct: null, impuestoUsd: null };

  // Regla 4: en una repetición de la misma guía la celda va vacía, con la nota que lo explica.
  if (r.__guiaRepetida) return { ...vacio, nota: 'Ya contabilizado en la primera fila de esta guía' };

  if (!r.pedimentoId) return { ...vacio, nota: 'No va al pedimento' };

  const valor = r.valorAduanalUsd == null ? null : Number(r.valorAduanalUsd);
  if (valor == null || !Number.isFinite(valor)) return { ...vacio, nota: 'Sin valor aduanal en el manifiesto' };

  const origen: 'GENERAL' | 'TMEC' = r.origenTasa === 'TMEC' ? 'TMEC' : 'GENERAL';
  const fecha = diaDeReferencia(r.fechaReferencia);
  if (!fecha) return { valorUsd: valor, origen, tasaPct: null, impuestoUsd: null, nota: 'Sin fecha de referencia' };

  const { vigencia, motivo } = resolverTasa(vigencias, fecha, origen);
  if (!vigencia) {
    return {
      valorUsd: valor, origen, tasaPct: null, impuestoUsd: null,
      nota: motivo === 'sin_tabla' ? 'Sin tabla de tasas configurada' : 'Sin tasa vigente para la fecha',
    };
  }
  return {
    valorUsd: valor,
    origen,
    tasaPct: vigencia.rate,
    impuestoUsd: Math.round(valor * (vigencia.rate / 100) * 100) / 100,
    nota: '',
  };
}

/**
 * El día de la operación, ya resuelto por SQL como `date`.
 *
 * node-pg entrega un `date` como Date a medianoche LOCAL, así que se leen los componentes locales.
 * Usar `toISOString()` aquí devolvería el día en UTC y desfasaría las operaciones de la tarde.
 */
function diaDeReferencia(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v.slice(0, 10) || null;
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return null;
  const mes = String(d.getMonth() + 1).padStart(2, '0');
  const dia = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mes}-${dia}`;
}

/**
 * Marca las filas que REPITEN una guía ya vista.
 *
 * Una fila del export no es una guía: es guía × partida de despacho × partida de factura. La misma
 * guía aparece varias veces cuando viajó en dos camiones o cuando se le facturaron dos conceptos.
 * El valor aduanal y el impuesto son propiedades de la GUÍA, así que se replicarían idénticos en
 * cada repetición — y quien recibe el archivo selecciona la columna y suma, que es el primer acto
 * reflejo frente a una columna de dinero. El total saldría multiplicado por un entero exacto, que
 * es la peor clase de error: parece correcto.
 *
 * Escribir el número sólo en la primera aparición mantiene la autosuma correcta y deja dicho en la
 * nota por qué la celda está vacía. El orden es el del reporte, así que la "primera" es estable.
 */
function marcarPrimeraFilaPorGuia(filas: Fila[]): Fila[] {
  const vistas = new Set<string>();
  return filas.map((r) => {
    const g = r.guia ? String(r.guia) : null;
    if (!g) return r;
    if (vistas.has(g)) return { ...r, __guiaRepetida: true };
    vistas.add(g);
    return r;
  });
}

/** Attach the lead-time metrics to a row. The formulas live in the shared, tested module. */
function conLeadTimes(r: Fila): Fila & { leadTimes: LeadTimes } {
  return {
    ...r,
    leadTimes: calcularLeadTimes({
      arriboVueloAt: r.arriboVueloAt,
      disponibleAt: r.disponibleAt,
      modulacionAt: r.modulacionAt,
      salidaRojoAt: r.salidaRojoAt,
      citaAt: r.citaAt,
      ingresoPatioAt: r.ingresoPatioAt,
      ingresoAduanaAt: r.ingresoAduanaAt,
      inicioCargaAt: r.inicioCargaAt,
      finCargaAt: r.finCargaAt,
      salidaAt: r.salidaAt,
      etaCalculado: r.etaCalculado,
      arriboReal: r.arriboReal,
      podFirmadoAt: r.podFirmadoAt,
    }),
  };
}

function iso(v: unknown): string {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

function num(v: unknown): number | '' {
  return v == null ? '' : Number(v);
}

/** The combined sheet: operational and financial columns, one row per guía. */
function filaExport(r: Fila & { leadTimes: LeadTimes }, vigencias: TasaVigencia[] | null): Record<string, unknown> {
  const lt = r.leadTimes;
  const imp = estimadoDeFila(r, vigencias);
  return {
    MAWB: r.mawb ?? '',
    Guía: r.guia ?? '',
    Cliente: r.cliente ?? '',
    Vuelo: r.numeroVuelo ?? '',
    Origen: r.origenIata ?? '',
    Destino: r.destinoIata ?? '',
    ETD: iso(r.etdOrigen),
    'ETA declarada': iso(r.etaPais),
    'Arribo real del vuelo': iso(r.arriboVueloAt),
    'Carga disponible': iso(r.disponibleAt),
    Etapa: r.etapa ?? '',
    'Estado documental': r.estadoDocumental ?? '',
    'Estado planeación': r.estadoPlaneacion ?? '',
    'Estado de la guía': r.estadoGuia ?? '',
    // Never translated: the client reads it (D16).
    Semáforo: r.semaforo ?? '',
    Hold: r.holdActivo ? 'Sí' : 'No',
    'Banderas rojas': num(r.banderas),
    Cartones: num(r.cartones),
    Piezas: num(r.piezas),
    'Peso (kg)': num(r.pesoKg),
    Pedimento: r.pedimento ?? '',
    Despacho: r.despachoFolio ?? '',
    'Fecha de operación': r.fechaOperacion ? iso(r.fechaOperacion).slice(0, 10) : '',
    'Tipo de unidad': r.tipoUnidad ? etiquetaTipoUnidad(String(r.tipoUnidad)) : '',
    Transportista: r.transportista ?? '',
    Placas: r.placas ?? '',
    'Destino de entrega': r.destinoEntrega ?? '',
    'Estado del despacho': r.estadoDespacho ?? '',
    Cita: iso(r.citaAt),
    'Ingreso a patio': iso(r.ingresoPatioAt),
    'Ingreso a aduana': iso(r.ingresoAduanaAt),
    'Inicio de carga': iso(r.inicioCargaAt),
    'Fin de carga': iso(r.finCargaAt),
    Modulación: iso(r.modulacionAt),
    'Salida de rojo': iso(r.salidaRojoAt),
    'Salida de aduana': iso(r.salidaAt),
    'Arribo estimado': iso(r.etaCalculado),
    'Arribo real': iso(r.arriboReal),
    POD: r.podFolio ?? '',
    'Estado del POD': r.podEstado ?? '',
    'Firmado por': r.firmadoPor ?? '',
    'Fecha de firma': iso(r.podFirmadoAt),
    Factura: r.facturaFolio ?? '',
    'Tipo de factura': r.facturaTipo ?? '',
    'UUID CFDI': r.uuidCfdi ?? '',
    'Estado de la factura': r.facturaEstado ?? '',
    'Periodo facturado': r.periodoFactura ?? '',
    'Importe facturado': num(r.importeFacturado),
    Moneda: r.monedaFactura ?? '',
    // The carrier cost travels beside the client charge deliberately: both sides of the same trip in
    // one row is the whole reason to have a combined export at all (D18 keeps them as facts, not as
    // a computed margin, which would be a fourth place the same number could disagree with itself).
    'Costo de flete': num(r.costoFlete),
    // Estimado de impuesto, guía por guía (pedido en la junta del 15-sep). Va junto al resto del
    // dinero y NO se suma a nada: es informativo, el cálculo legal lo determina el agente aduanal.
    // La columna "Nota del estimado" existe para que una celda vacía nunca se lea como "no paga":
    // dice si la guía no fue al pedimento, si le faltó valor aduanal o si no había tasa vigente.
    'Valor aduanal USD': imp.valorUsd ?? '',
    'Origen de la tasa': imp.origen ?? '',
    'Tasa aplicada %': imp.tasaPct ?? '',
    'Impuesto estimado USD': imp.impuestoUsd ?? '',
    'Nota del estimado': imp.nota,
    // Lead times, in the order the dashboard reads them.
    ...Object.fromEntries(METRICAS_LEAD_TIME.map((m) => [m.label, lt[m.id] ?? ''])),
  };
}

function enviarLibro(res: Response, filas: Array<Record<string, unknown>>, hoja: string, nombre: string): void {
  const ws = XLSX.utils.json_to_sheet(filas.length ? filas : [{ Aviso: 'Sin registros para los filtros indicados.' }]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, hoja);
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
  res.setHeader('Content-Disposition', `attachment; filename="${nombre}"`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
}

const rolesReporte = ['admin', 'capturista', 'autoridad'] as const;

/**
 * GET /api/reportes/operativo — the combined report by date and client (requirement point 6).
 *
 * Everything the operation knows about a guía in one row: the flight, the warehouse, the truck, the
 * semáforo, the POD, the pedimento and the invoice line. This is what "Reporte general por
 * fecha/cliente con trazabilidad por MAWB" means once the data stops living in tabs.
 */
reportesOperativosRouter.get(
  '/operativo',
  requireAuth,
  requireRole(...rolesReporte),
  validate({ query: reporteOperativoQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filtros = req.query as unknown as ReporteOperativoQuery;
      const filas = (await cargarFilas(filtros)).map(conLeadTimes);
      await recordAudit({
        userId: req.user!.userId,
        action: 'VIEW_REPORTE_OPERATIVO',
        entity: 'operacion',
        entityId: `${filtros.desde ?? 'inicio'}:${filtros.hasta ?? 'hoy'}`,
        after: { role: req.user!.role, ...filtros, filas: filas.length },
        ip: req.ip,
      });
      res.json({
        filtros,
        rulesetVersion: LEAD_TIME_RULESET_VERSION,
        criterioFecha:
          'Fecha del arribo real del vuelo; si no hay arribo registrado, la fecha de alta del caso.',
        filas,
        total: filas.length,
      });
    } catch (err) {
      next(err);
    }
  },
);

reportesOperativosRouter.get(
  '/operativo.xlsx',
  requireAuth,
  requireRole(...rolesReporte),
  validate({ query: reporteOperativoQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filtros = req.query as unknown as ReporteOperativoQuery;
      const [filas, vigencias] = await Promise.all([
        cargarFilas(filtros).then((rs) => rs.map(conLeadTimes)),
        cargarVigencias(),
      ]);
      // Audit BEFORE send, same discipline as the PRD-01 exports: the access is durably logged
      // whether or not the download completes.
      await recordAudit({
        userId: req.user!.userId,
        action: 'EXPORT_REPORTE_OPERATIVO',
        entity: 'operacion',
        entityId: `${filtros.desde ?? 'inicio'}:${filtros.hasta ?? 'hoy'}`,
        after: { role: req.user!.role, ...filtros, filas: filas.length },
        ip: req.ip,
      });
      enviarLibro(
        res,
        marcarPrimeraFilaPorGuia(filas).map((r) => filaExport(r as Fila & { leadTimes: LeadTimes }, vigencias)),
        'Reporte operativo',
        'Reporte_operativo.xlsx',
      );
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/reportes/lead-times — the dashboard's arithmetic (requirement point 7).
 *
 * Warehouse time, dispatch time, transit time, last mile and total lead time, per guía and
 * aggregated. Every one of them is computed from timestamps this system already refuses to let
 * anybody edit, which is the entire difference between this and the tab it replaces.
 */
reportesOperativosRouter.get(
  '/lead-times',
  requireAuth,
  requireRole(...rolesReporte),
  validate({ query: reporteOperativoQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filtros = req.query as unknown as ReporteOperativoQuery;
      const filas = (await cargarFilas(filtros)).map(conLeadTimes);
      await recordAudit({
        userId: req.user!.userId,
        action: 'VIEW_LEAD_TIMES',
        entity: 'operacion',
        entityId: `${filtros.desde ?? 'inicio'}:${filtros.hasta ?? 'hoy'}`,
        after: { role: req.user!.role, ...filtros, filas: filas.length },
        ip: req.ip,
      });
      res.json({
        filtros,
        rulesetVersion: LEAD_TIME_RULESET_VERSION,
        metricas: METRICAS_LEAD_TIME,
        // `muestras` travels with every average: an average over three of ninety shipments is a
        // sample, and a dashboard that hid the denominator would be the spreadsheet again.
        resumen: resumirLeadTimes(filas.map((f) => f.leadTimes)),
        filas: filas.map((f) => ({
          operacionId: f.operacionId,
          mawb: f.mawb,
          guia: f.guia,
          cliente: f.cliente,
          etapa: f.etapa,
          despachoFolio: f.despachoFolio,
          podEstado: f.podEstado,
          ...f.leadTimes,
        })),
        total: filas.length,
      });
    } catch (err) {
      next(err);
    }
  },
);

reportesOperativosRouter.get(
  '/lead-times.xlsx',
  requireAuth,
  requireRole(...rolesReporte),
  validate({ query: reporteOperativoQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const filtros = req.query as unknown as ReporteOperativoQuery;
      const filas = (await cargarFilas(filtros)).map(conLeadTimes);
      await recordAudit({
        userId: req.user!.userId,
        action: 'EXPORT_LEAD_TIMES',
        entity: 'operacion',
        entityId: `${filtros.desde ?? 'inicio'}:${filtros.hasta ?? 'hoy'}`,
        after: { role: req.user!.role, ...filtros, filas: filas.length },
        ip: req.ip,
      });
      enviarLibro(
        res,
        filas.map((f) => ({
          MAWB: f.mawb ?? '',
          Guía: f.guia ?? '',
          Cliente: f.cliente ?? '',
          Etapa: f.etapa ?? '',
          Despacho: f.despachoFolio ?? '',
          'Estado del POD': f.podEstado ?? '',
          ...Object.fromEntries(METRICAS_LEAD_TIME.map((m) => [m.label, f.leadTimes[m.id] ?? ''])),
        })),
        'Lead times',
        'Lead_times.xlsx',
      );
    } catch (err) {
      next(err);
    }
  },
);
