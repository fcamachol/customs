import { Router, type Request, type Response, type NextFunction } from 'express';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { validate } from '../validation/middleware';
import { reporteOperativoQuery, type ReporteOperativoQuery } from '../validation/schemas';
import { etiquetaTipoUnidad } from '../../../shared/operaciones/catalogos';
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
         f.moneda                    AS "monedaFactura"
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
   WHERE ($1::date IS NULL OR COALESCE(o.arribo_vuelo_at, o.created_at)::date >= $1::date)
     AND ($2::date IS NULL OR COALESCE(o.arribo_vuelo_at, o.created_at)::date <= $2::date)
     AND ($3::uuid IS NULL OR COALESCE(g.client_id, o.client_id) = $3::uuid)
   ORDER BY COALESCE(o.arribo_vuelo_at, o.created_at) DESC, o.mawb, g.guia_norm
   LIMIT 5000`;

type Fila = Record<string, any>;

async function cargarFilas(f: ReporteOperativoQuery): Promise<Fila[]> {
  const { rows } = await query(SQL_FILAS, [f.desde ?? null, f.hasta ?? null, f.clientId ?? null]);
  return rows as Fila[];
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
function filaExport(r: Fila & { leadTimes: LeadTimes }): Record<string, unknown> {
  const lt = r.leadTimes;
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
      const filas = (await cargarFilas(filtros)).map(conLeadTimes);
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
      enviarLibro(res, filas.map(filaExport), 'Reporte operativo', 'Reporte_operativo.xlsx');
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
