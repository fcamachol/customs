import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import * as XLSX from 'xlsx';
import { query } from '../db/pool';
import { withTransaction } from '../db/tx';
import { isUniqueViolation } from '../db/errors';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { encryptField, decryptField } from '../crypto/fieldCrypto';
import { saveFile } from '../storage/files';
import { validate } from '../validation/middleware';
import {
  facturaCancelarBody,
  facturaCrearBody,
  facturaEstadoBody,
  facturaListQuery,
  facturaParam,
  facturaTimbradoBody,
  preliquidacionQuery,
  reporteMensualQuery,
  trazabilidadQuery,
  type FacturaCancelarBody,
  type FacturaCrearBody,
  type FacturaEstadoBody,
  type FacturaPartidaBody,
  type FacturaTimbradoBody,
  type PreliquidacionQuery,
  type ReporteMensualQuery,
} from '../validation/schemas';
import {
  FACTURACION_RULESET_VERSION,
  calcularImporte,
  desviacionTarifa,
  proponerLinea,
  redondearImporte,
  type LineaPropuesta,
  type TarifaCliente,
  type UnidadTarifa,
} from '../../../shared/operaciones/facturacion';

/**
 * FINANCIAL TRACEABILITY — guía ↔ piezas ↔ factura (PRD-02 §8.10, R43–R48, D17/D18).
 *
 * THE FILE IN ONE SENTENCE: this is the join that makes ANAM's question answerable — "this guía,
 * these pieces, what was charged for it, on which invoice, against which pedimento?" — without a
 * spreadsheet anywhere in the answer.
 *
 * D17 IS WHY THE LINK LIVES HERE AND NOT IN THE CFDI. A CFDI is a fiscal document with a fixed
 * schema; stuffing house guías and piece counts into its concepts would be fragile and, worse,
 * unverifiable. So the stamped document is ATTACHED (`facturas.file_id`, hashed like every other
 * artifact) and IDENTIFIED (`uuid_cfdi`), and the guía-piezas-importe detail is rows in
 * `factura_partidas` — queryable, exportable, and joined to the operational chain by foreign key.
 *
 * ONLY A SIGNED POD PRODUCES A BILLABLE LINE (R39 → R43). The preliquidación reads deliveries, not
 * departures: a truck that left is not revenue, a truck whose POD the client signed is. That single
 * rule is what stops the invoice from ever being ahead of the operation, and it is why #30 had to
 * exist before #32 could.
 *
 * THE PERIOD IS THE DELIVERY MONTH. `periodo` (YYYY-MM) selects guías whose POD was SIGNED inside
 * it, not whose flight landed in it. A shipment that lands on 31 August and is delivered on
 * 2 September belongs to September's invoice, because what is being billed is the completed service.
 * The spec did not say which; this is the reading, it is stated in the response as `criterioPeriodo`,
 * and it is the one the monthly report and the "already billed" check both use, so all three agree.
 *
 * NOTHING HERE COMPUTES TAX. `total` equals `subtotal`: IVA, retenciones and the rest belong to the
 * CFDI and to the pedimento, both of which exist and are authoritative. A tax rate invented here
 * would be this system making a fiscal claim it has no standing to make (D18: income only).
 *
 * FISCAL PII IS ENCRYPTED AND STAYS OUT OF THE AUDIT CHAIN. `receptor_rfc` and `receptor_correo` are
 * `v1:`-enveloped at rest and never copied into `audit_log.after` — the same discipline the carrier
 * contacts got in #29, for the same reason: the audit row is permanent and hash-chained, so writing
 * PII into it would defeat encrypting it.
 */
export const facturacionRouter = Router();

type Q = (text: string, params?: unknown[]) => Promise<any>;

const uploadFactura = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/** The pool as a `Q`, so the read-only paths can share the helpers the transactional ones use. */
const qPool: Q = (text, params) => query(text, params);

/** Encrypt on the way in; '' and absent both mean "no value", never the ciphertext of an empty string. */
function cifrar(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? encryptField(s) : null;
}

function descifrar(v: string | null | undefined): string | null {
  return v ? decryptField(v) : null;
}

function orNull(v: string | null | undefined): string | null {
  const s = (v ?? '').trim();
  return s ? s : null;
}

/** First and last day of a `YYYY-MM`, as the SQL range the period means. */
function rangoPeriodo(periodo: string): { desde: string; hasta: string } {
  const [y, m] = periodo.split('-').map(Number);
  const desde = `${periodo}-01`;
  const fin = new Date(Date.UTC(y, m, 0));
  return { desde, hasta: fin.toISOString().slice(0, 10) };
}

const SELECT_FACTURA = `
  f.id,
  f.client_id             AS "clientId",
  c.name                  AS "cliente",
  f.tipo,
  f.folio,
  f.uuid_cfdi             AS "uuidCfdi",
  f.periodo,
  f.subtotal,
  f.total,
  f.moneda,
  f.file_id               AS "fileId",
  f.estado,
  f.timbrado_prueba       AS "timbradoPrueba",
  f.timbrado_at           AS "timbradoAt",
  f.receptor_rfc          AS "receptorRfc",
  f.receptor_razon_social AS "receptorRazonSocial",
  f.receptor_correo       AS "receptorCorreo",
  f.motivo_cancelacion    AS "motivoCancelacion",
  f.cancelada_at          AS "canceladaAt",
  f.observaciones,
  f.created_at            AS "createdAt"`;

interface FilaFactura {
  receptorRfc: string | null;
  receptorCorreo: string | null;
  [k: string]: unknown;
}

const descifrarFactura = (f: FilaFactura): FilaFactura => ({
  ...f,
  receptorRfc: descifrar(f.receptorRfc),
  receptorCorreo: descifrar(f.receptorCorreo),
});

/**
 * One ledger row per caso named by an invoice.
 *
 * Financial events land on the CARGO's timeline, not only in the invoice's own history, because the
 * authority's question arrives from the cargo end: "this guía — what was it charged?". A shipment
 * whose timeline stops at delivery leaves that to a spreadsheet, which is the thing being replaced.
 */
async function registrarEventoFactura(
  q: Q,
  args: { operacionIds: string[]; tipo: string; payload: Record<string, unknown>; userId: string },
): Promise<number> {
  const ids = [...new Set(args.operacionIds.filter(Boolean))];
  if (!ids.length) return 0;
  const { rowCount } = await q(
    `INSERT INTO operacion_eventos
       (operacion_id, operacion_mawb, tipo, origen, ocurrido_at, payload, created_by)
     SELECT o.id, o.mawb, $1, 'coordinador', now(), $2::jsonb, $3
       FROM operaciones o
      WHERE o.id = ANY($4::uuid[])`,
    [args.tipo, JSON.stringify(args.payload), args.userId, ids],
  );
  return rowCount ?? 0;
}

/** The client's rate card, in the shape the pure pricing module expects. */
async function tarifasDeCliente(q: Q, clientId: string): Promise<TarifaCliente[]> {
  const { rows } = await q(
    `SELECT id, concepto, unidad, precio, moneda,
            vigencia_desde::text AS "vigenciaDesde", vigencia_hasta::text AS "vigenciaHasta", activo
       FROM client_tarifas WHERE client_id = $1`,
    [clientId],
  );
  return (rows as Array<Record<string, any>>).map((r) => ({
    id: String(r.id),
    concepto: String(r.concepto),
    unidad: r.unidad as UnidadTarifa,
    precio: Number(r.precio),
    moneda: String(r.moneda),
    vigenciaDesde: r.vigenciaDesde ?? null,
    vigenciaHasta: r.vigenciaHasta ?? null,
    activo: Boolean(r.activo),
  }));
}

interface GuiaEntregada {
  operacionId: string;
  operacionGuiaId: string | null;
  despachoId: string;
  mawb: string;
  guiaNorm: string | null;
  piezas: number | null;
  cartones: number | null;
  pesoKg: number | null;
  pedimento: string | null;
  entregaAt: string;
  podFolio: string;
  despachoFolio: string;
}

/**
 * Guías whose delivery a client SIGNED FOR inside the period.
 *
 * The `pods.estado = 'firmado'` join is the load-bearing part: it is what makes an invoice line
 * impossible to produce for cargo the client never accepted. `cartones_cargados` is preferred over
 * `cartones_planeados` for the same reason — what left on the truck, not what the plan hoped would.
 */
async function guiasEntregadas(
  q: Q,
  args: { clientId: string; periodo: string },
): Promise<GuiaEntregada[]> {
  const { desde, hasta } = rangoPeriodo(args.periodo);
  const { rows } = await q(
    `SELECT dp.operacion_id                              AS "operacionId",
            dp.operacion_guia_id                         AS "operacionGuiaId",
            dp.despacho_id                               AS "despachoId",
            o.mawb,
            g.guia_norm                                  AS "guiaNorm",
            COALESCE(g.piezas, dp.piezas)                AS piezas,
            COALESCE(dp.cartones_cargados, dp.cartones_planeados, g.cartones) AS cartones,
            g.peso_kg                                    AS "pesoKg",
            ped.numero_pedimento                         AS pedimento,
            pod.firmado_at                               AS "entregaAt",
            pod.folio                                    AS "podFolio",
            d.folio                                      AS "despachoFolio"
       FROM pods pod
       JOIN despachos d ON d.id = pod.despacho_id
       JOIN despacho_partidas dp ON dp.despacho_id = d.id
       JOIN operaciones o ON o.id = dp.operacion_id
       LEFT JOIN operacion_guias g ON g.id = dp.operacion_guia_id
       LEFT JOIN pedimentos ped ON ped.id = COALESCE(dp.pedimento_id, g.pedimento_id)
      WHERE pod.estado = 'firmado'
        AND pod.firmado_at >= $2::date
        AND pod.firmado_at < ($3::date + interval '1 day')
        AND COALESCE(g.client_id, o.client_id) = $1::uuid
      ORDER BY pod.firmado_at, o.mawb, g.guia_norm`,
    [args.clientId, desde, hasta],
  );
  return rows as GuiaEntregada[];
}

/** Guías already carried by a live invoice of this type — the double-billing check (R44). */
async function yaFacturadas(
  q: Q,
  args: { clientId: string; periodo: string; tipo: string },
): Promise<Set<string>> {
  const { rows } = await q(
    `SELECT fp.operacion_id AS "operacionId", fp.operacion_guia_id AS "operacionGuiaId"
       FROM factura_partidas fp
       JOIN facturas f ON f.id = fp.factura_id
      WHERE f.client_id = $1::uuid AND f.periodo = $2 AND f.tipo = $3
        AND f.estado <> 'cancelada'`,
    [args.clientId, args.periodo, args.tipo],
  );
  return new Set(
    (rows as Array<{ operacionId: string | null; operacionGuiaId: string | null }>).map(
      (r) => `${r.operacionId ?? ''}|${r.operacionGuiaId ?? ''}`,
    ),
  );
}

export interface LineaPreliquidacion extends LineaPropuesta {
  operacionId: string;
  operacionGuiaId: string | null;
  despachoId: string;
  mawb: string;
  guiaNorm: string | null;
  pedimento: string | null;
  entregaAt: string;
  podFolio: string;
  despachoFolio: string;
  piezas: number | null;
  yaFacturada: boolean;
  facturable: boolean;
}

/** Build the month's proposed lines. Pure pricing lives in shared/operaciones/facturacion.ts. */
async function construirPreliquidacion(
  q: Q,
  args: { clientId: string; periodo: string; tipo: string },
): Promise<{ lineas: LineaPreliquidacion[]; moneda: string | null }> {
  // Sequential, NOT Promise.all: `q` may be a single transaction client, and pg refuses concurrent
  // queries on one client. Three round trips is the correct price for the transactional path.
  const tarifas = await tarifasDeCliente(q, args.clientId);
  const entregadas = await guiasEntregadas(q, { clientId: args.clientId, periodo: args.periodo });
  const facturadas = await yaFacturadas(q, args);

  const lineas = entregadas.map((g): LineaPreliquidacion => {
    const fecha = new Date(g.entregaAt).toISOString().slice(0, 10);
    const propuesta = proponerLinea({
      tarifas,
      cantidades: {
        piezas: g.piezas == null ? null : Number(g.piezas),
        cartones: g.cartones == null ? null : Number(g.cartones),
        pesoKg: g.pesoKg == null ? null : Number(g.pesoKg),
      },
      fecha,
    });
    const clave = `${g.operacionId}|${g.operacionGuiaId ?? ''}`;
    const yaFacturada = facturadas.has(clave);
    return {
      ...propuesta,
      operacionId: g.operacionId,
      operacionGuiaId: g.operacionGuiaId,
      despachoId: g.despachoId,
      mawb: g.mawb,
      guiaNorm: g.guiaNorm,
      pedimento: g.pedimento,
      entregaAt: new Date(g.entregaAt).toISOString(),
      podFolio: g.podFolio,
      despachoFolio: g.despachoFolio,
      piezas: g.piezas == null ? null : Number(g.piezas),
      yaFacturada,
      // A line is billable only when it has an amount AND has not already been billed. Both
      // conditions are reported per line, so an excluded delivery is visible rather than missing.
      facturable: propuesta.importe != null && !yaFacturada,
      advertencia: yaFacturada
        ? `Ya facturada en un ${args.tipo} vigente de este periodo.`
        : propuesta.advertencia,
    };
  });

  const moneda = lineas.find((l) => l.moneda)?.moneda ?? null;
  return { lineas, moneda };
}

// =================================================================================================
// Preliquidación — R43 / R44 / R46
// =================================================================================================

/**
 * GET /api/facturacion/preliquidacion — what this client owes for this month, before anybody commits.
 *
 * Every delivered guía appears, including the ones that cannot be priced. A line that is dropped
 * silently is a delivery that quietly never gets invoiced, which is the failure this module exists
 * to make impossible; a line with an `advertencia` is a question somebody answers in ten seconds.
 */
facturacionRouter.get(
  '/preliquidacion',
  requireAuth,
  requireRole('admin'),
  validate({ query: preliquidacionQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientId, periodo, tipo } = req.query as unknown as PreliquidacionQuery;
      const cliente = await query<{ name: string }>('SELECT name FROM clients WHERE id = $1', [clientId]);
      if (!cliente.rows.length) {
        res.status(404).json({ error: 'Cliente no encontrado' });
        return;
      }

      const { lineas, moneda } = await construirPreliquidacion(qPool, {
        clientId,
        periodo,
        tipo: tipo ?? 'proforma',
      });
      const facturables = lineas.filter((l) => l.facturable);
      const subtotal = redondearImporte(facturables.reduce((a, l) => a + (l.importe ?? 0), 0));

      res.json({
        clientId,
        cliente: cliente.rows[0].name,
        periodo,
        tipo: tipo ?? 'proforma',
        rulesetVersion: FACTURACION_RULESET_VERSION,
        // Stated, not implied: the same rule the monthly report and the double-billing check use.
        criterioPeriodo: 'Guías cuyo POD fue FIRMADO dentro del periodo (se factura el servicio completado, R39).',
        moneda,
        lineas,
        totales: {
          guias: lineas.length,
          facturables: facturables.length,
          sinTarifa: lineas.filter((l) => l.importe == null && !l.yaFacturada).length,
          yaFacturadas: lineas.filter((l) => l.yaFacturada).length,
          piezas: facturables.reduce((a, l) => a + (l.piezas ?? 0), 0),
          subtotal,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Facturas — R43 / R44 / R45
// =================================================================================================

facturacionRouter.get(
  '/facturas',
  requireAuth,
  requireRole('admin', 'autoridad'),
  validate({ query: facturaListQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientId, periodo, estado, tipo } = req.query as Record<string, string | undefined>;
      const { rows } = await query(
        `SELECT ${SELECT_FACTURA},
                (SELECT count(*)::int FROM factura_partidas p WHERE p.factura_id = f.id) AS "partidas"
           FROM facturas f
           LEFT JOIN clients c ON c.id = f.client_id
          WHERE ($1::uuid IS NULL OR f.client_id = $1::uuid)
            AND ($2::text IS NULL OR f.periodo = $2)
            AND ($3::text IS NULL OR f.estado = $3)
            AND ($4::text IS NULL OR f.tipo = $4)
          ORDER BY f.periodo DESC, f.created_at DESC
          LIMIT 500`,
        [clientId ?? null, periodo ?? null, estado ?? null, tipo ?? null],
      );
      res.json((rows as unknown as FilaFactura[]).map(descifrarFactura));
    } catch (err) {
      next(err);
    }
  },
);

/** GET /api/facturacion/facturas/:id — the invoice with the lines that ARE the traceability (R44). */
facturacionRouter.get(
  '/facturas/:id',
  requireAuth,
  requireRole('admin', 'autoridad'),
  validate({ params: facturaParam }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const f = await query(
        `SELECT ${SELECT_FACTURA} FROM facturas f LEFT JOIN clients c ON c.id = f.client_id WHERE f.id = $1`,
        [req.params.id],
      );
      if (!f.rows.length) {
        res.status(404).json({ error: 'Factura no encontrada' });
        return;
      }
      const partidas = await query(
        `SELECT fp.id, fp.operacion_id AS "operacionId", fp.operacion_guia_id AS "operacionGuiaId",
                fp.despacho_id AS "despachoId", fp.guia_norm AS "guiaNorm", fp.mawb,
                fp.concepto, fp.unidad, fp.cantidad, fp.piezas,
                fp.precio_unitario AS "precioUnitario", fp.precio_contratado AS "precioContratado",
                fp.importe, fp.client_tarifa_id AS "clientTarifaId",
                d.folio AS "despachoFolio", pod.folio AS "podFolio", pod.firmado_at AS "entregaAt",
                ped.numero_pedimento AS pedimento
           FROM factura_partidas fp
           LEFT JOIN despachos d ON d.id = fp.despacho_id
           LEFT JOIN pods pod ON pod.despacho_id = fp.despacho_id
           LEFT JOIN operacion_guias g ON g.id = fp.operacion_guia_id
           LEFT JOIN pedimentos ped ON ped.id = g.pedimento_id
          WHERE fp.factura_id = $1
          ORDER BY fp.mawb, fp.guia_norm`,
        [req.params.id],
      );

      res.json({
        ...descifrarFactura(f.rows[0] as unknown as FilaFactura),
        partidas: (partidas.rows as Array<Record<string, any>>).map((p) => ({
          ...p,
          // R45, computed rather than stored: two columns already hold the truth and a third could
          // disagree with both. Signed — over-charging and under-charging are both findings.
          desviacionTarifa: desviacionTarifa(
            Number(p.precioUnitario),
            p.precioContratado == null ? null : Number(p.precioContratado),
          ),
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * POST /api/facturacion/facturas — the proforma or the CFDI shell, with its lines (R43/R44).
 *
 * With no `partidas` in the body it bills the preliquidación: every delivered, priced, not-yet-billed
 * guía of the month. That is the month-end path and it is deliberately the DEFAULT, because the
 * alternative — a human retyping guías into an invoice — is the step where the spreadsheet used to
 * lose things.
 *
 * It refuses to create an empty invoice. An invoice with no lines is a total with nothing behind it,
 * which is exactly the artifact R44 exists to abolish.
 */
facturacionRouter.post(
  '/facturas',
  requireAuth,
  requireRole('admin'),
  validate({ body: facturaCrearBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const b = req.body as FacturaCrearBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q: Q) => {
        const cliente = await q('SELECT id, name FROM clients WHERE id = $1', [b.clientId]);
        if (!cliente.rows.length) return { kind: 'cliente_no_encontrado' as const };

        let partidas: Array<FacturaPartidaBody & { mawb: string | null; guiaNorm: string | null }> = [];
        let desdePreliquidacion = false;

        if (b.partidas?.length) {
          // Explicit lines: fill the contracted price from the rate card when the caller omitted it,
          // so the R45 comparison is never simply skipped.
          const tarifas = await tarifasDeCliente(q, b.clientId);
          const porId = new Map(tarifas.map((t) => [t.id, t]));
          partidas = await Promise.all(
            b.partidas.map(async (p) => {
              const ref = p.operacionGuiaId
                ? await q(
                    `SELECT g.guia_norm AS "guiaNorm", o.mawb
                       FROM operacion_guias g JOIN operaciones o ON o.id = g.operacion_id
                      WHERE g.id = $1`,
                    [p.operacionGuiaId],
                  )
                : p.operacionId
                  ? await q('SELECT NULL AS "guiaNorm", mawb FROM operaciones WHERE id = $1', [p.operacionId])
                  : { rows: [] as Array<{ guiaNorm: string | null; mawb: string }> };
              const contratado =
                p.precioContratado ?? (p.clientTarifaId ? porId.get(p.clientTarifaId)?.precio ?? null : null);
              return {
                ...p,
                precioContratado: contratado ?? undefined,
                mawb: ref.rows[0]?.mawb ?? null,
                guiaNorm: ref.rows[0]?.guiaNorm ?? null,
              };
            }),
          );
        } else {
          desdePreliquidacion = true;
          const { lineas } = await construirPreliquidacion(q, {
            clientId: b.clientId,
            periodo: b.periodo,
            tipo: b.tipo,
          });
          partidas = lineas
            .filter((l) => l.facturable)
            .map((l) => ({
              operacionId: l.operacionId,
              operacionGuiaId: l.operacionGuiaId ?? undefined,
              despachoId: l.despachoId,
              concepto: l.concepto,
              unidad: l.unidad,
              cantidad: l.cantidad as number,
              piezas: l.piezas ?? undefined,
              precioUnitario: l.precioUnitario as number,
              precioContratado: l.precioContratado ?? undefined,
              clientTarifaId: l.clientTarifaId ?? undefined,
              mawb: l.mawb,
              guiaNorm: l.guiaNorm,
            }));
        }

        if (!partidas.length) {
          return { kind: 'sin_partidas' as const, desdePreliquidacion };
        }

        const importes = partidas.map((p) => calcularImporte(Number(p.cantidad), Number(p.precioUnitario)));
        const subtotal = redondearImporte(importes.reduce((a, x) => a + x, 0));
        const moneda = b.moneda ?? 'MXN';

        const ins = await q(
          `INSERT INTO facturas
             (client_id, tipo, folio, periodo, subtotal, total, moneda, estado,
              receptor_rfc, receptor_razon_social, receptor_correo, observaciones, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,'borrador',$8,$9,$10,$11,$12)
           RETURNING id, folio, tipo, periodo, subtotal, total, moneda, estado, created_at AS "createdAt"`,
          [
            b.clientId,
            b.tipo,
            orNull(b.folio),
            b.periodo,
            subtotal,
            // total = subtotal on purpose: taxes belong to the CFDI, never to a number invented here.
            subtotal,
            moneda,
            cifrar(b.receptorRfc),
            orNull(b.receptorRazonSocial) ?? cliente.rows[0].name,
            cifrar(b.receptorCorreo),
            orNull(b.observaciones),
            userId,
          ],
        );
        const factura = ins.rows[0];

        for (let i = 0; i < partidas.length; i += 1) {
          const p = partidas[i];
          await q(
            `INSERT INTO factura_partidas
               (factura_id, operacion_id, operacion_guia_id, despacho_id, guia_norm, mawb,
                concepto, unidad, cantidad, piezas, precio_unitario, precio_contratado, importe,
                client_tarifa_id)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
            [
              factura.id,
              p.operacionId ?? null,
              p.operacionGuiaId ?? null,
              p.despachoId ?? null,
              p.guiaNorm ?? null,
              p.mawb ?? null,
              p.concepto,
              p.unidad,
              p.cantidad,
              p.piezas ?? null,
              p.precioUnitario,
              p.precioContratado ?? null,
              importes[i],
              p.clientTarifaId ?? null,
            ],
          );
        }

        const eventos = await registrarEventoFactura(q, {
          operacionIds: partidas.map((p) => p.operacionId).filter((x): x is string => Boolean(x)),
          tipo: 'FACTURA_CREADA',
          payload: {
            facturaId: factura.id,
            tipo: b.tipo,
            periodo: b.periodo,
            folio: factura.folio,
            subtotal,
            moneda,
            partidas: partidas.length,
            rulesetVersion: FACTURACION_RULESET_VERSION,
          },
          userId,
        });

        return { kind: 'ok' as const, factura, partidas, importes, subtotal, moneda, eventos, desdePreliquidacion };
      });

      switch (resultado.kind) {
        case 'cliente_no_encontrado':
          res.status(404).json({ error: 'Cliente no encontrado' });
          return;
        case 'sin_partidas':
          res.status(409).json({
            error: resultado.desdePreliquidacion
              ? 'No hay guías entregadas y facturables en ese periodo: una factura sin partidas es un total sin nada detrás.'
              : 'No se recibió ninguna partida.',
          });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'FACTURA_CREADA',
        entity: 'factura',
        entityId: resultado.factura.id,
        // The receptor's fiscal data is deliberately absent: the audit row is permanent and
        // hash-chained, so copying encrypted PII into it would defeat the encryption.
        after: {
          clientId: b.clientId,
          tipo: b.tipo,
          periodo: b.periodo,
          folio: resultado.factura.folio,
          subtotal: resultado.subtotal,
          moneda: resultado.moneda,
          partidas: resultado.partidas.length,
          desdePreliquidacion: resultado.desdePreliquidacion,
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        ...resultado.factura,
        clientId: b.clientId,
        partidas: resultado.partidas.length,
        desdePreliquidacion: resultado.desdePreliquidacion,
        eventosRegistrados: resultado.eventos,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({
          error: 'Esa guía ya tiene una partida con ese concepto en esta factura: cobrarla dos veces es lo que este renglón existe para impedir.',
        });
        return;
      }
      next(err);
    }
  },
);

/**
 * POST /api/facturacion/facturas/:id/timbrado — R48, and the D17 moment made explicit.
 *
 * The CFDI arrives from outside (there is no SAT integration; the T1-specific stamping is not
 * enabled). What this records is the link: the SAT's uuid, the stamped file, and the fact that the
 * lines already in `factura_partidas` are what that document covers. `timbradoPrueba` defaults to
 * TRUE — a caller who says nothing produced a TEST stamp, and the record must say so rather than let
 * a rehearsal be read later as a fiscal act.
 */
facturacionRouter.post(
  '/facturas/:id/timbrado',
  requireAuth,
  requireRole('admin'),
  uploadFactura.single('file'),
  validate({ params: facturaParam, body: facturaTimbradoBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as FacturaTimbradoBody;
      const userId = req.user!.userId;
      const timbrado = b.timbradoAt ? new Date(b.timbradoAt) : new Date();

      const previa = await query<{ estado: string; tipo: string }>(
        'SELECT estado, tipo FROM facturas WHERE id = $1',
        [id],
      );
      if (!previa.rows.length) {
        res.status(404).json({ error: 'Factura no encontrada' });
        return;
      }
      if (previa.rows[0].estado === 'cancelada') {
        res.status(409).json({ error: 'La factura está cancelada: no se timbra sobre una cancelación.' });
        return;
      }
      if (previa.rows[0].estado === 'timbrada') {
        res.status(409).json({ error: 'La factura ya está timbrada: un segundo UUID sobre el mismo documento sería doble facturación.' });
        return;
      }

      const archivo = req.file
        ? await saveFile({
            kind: 'factura',
            originalName: req.file.originalname,
            bytes: req.file.buffer,
            uploadedBy: userId,
          })
        : null;

      const resultado = await withTransaction(async (q: Q) => {
        const upd = await q(
          `UPDATE facturas
              SET estado = 'timbrada', uuid_cfdi = $2, timbrado_at = $3,
                  timbrado_prueba = COALESCE($4, true),
                  folio = COALESCE($5, folio),
                  file_id = COALESCE($6, file_id)
            WHERE id = $1 AND estado <> 'cancelada'
            RETURNING id, folio, tipo, periodo, uuid_cfdi AS "uuidCfdi", estado,
                      timbrado_prueba AS "timbradoPrueba", timbrado_at AS "timbradoAt", client_id AS "clientId"`,
          [id, b.uuidCfdi, timbrado, b.timbradoPrueba ?? null, orNull(b.folio), archivo?.id ?? null],
        );
        if (!upd.rows.length) return { kind: 'no_encontrado' as const };
        const factura = upd.rows[0];

        const ops = await q(
          'SELECT DISTINCT operacion_id FROM factura_partidas WHERE factura_id = $1 AND operacion_id IS NOT NULL',
          [id],
        );
        const eventos = await registrarEventoFactura(q, {
          operacionIds: (ops.rows as Array<{ operacion_id: string }>).map((r) => r.operacion_id),
          tipo: 'FACTURA_LIGADA',
          payload: {
            facturaId: id,
            folio: factura.folio,
            uuidCfdi: b.uuidCfdi,
            timbradoPrueba: factura.timbradoPrueba,
            fileId: archivo?.id ?? null,
            contentHash: archivo?.contentHash ?? null,
            efecto:
              'El CFDI queda ligado a las partidas guía-piezas-importe; el vínculo vive en el sistema, no dentro del CFDI (D17).',
          },
          userId,
        });
        return { kind: 'ok' as const, factura, eventos };
      });

      if (resultado.kind === 'no_encontrado') {
        res.status(404).json({ error: 'Factura no encontrada' });
        return;
      }

      await recordAudit({
        userId,
        action: 'FACTURA_LIGADA',
        entity: 'factura',
        entityId: id,
        after: {
          uuidCfdi: b.uuidCfdi,
          timbradoPrueba: resultado.factura.timbradoPrueba,
          timbradoAt: timbrado.toISOString(),
          fileId: archivo?.id ?? null,
          contentHash: archivo?.contentHash ?? null,
        },
        ip: req.ip,
      });

      res.status(201).json({
        ok: true,
        ...resultado.factura,
        fileId: archivo?.id ?? null,
        contentHash: archivo?.contentHash ?? null,
        eventosRegistrados: resultado.eventos,
        advertencia: resultado.factura.timbradoPrueba
          ? 'Timbrado de PRUEBA: el timbrado T1 especial aún no está habilitado (R48).'
          : null,
      });
    } catch (err) {
      if (isUniqueViolation(err)) {
        res.status(409).json({ error: 'Ese UUID de CFDI ya está registrado en otra factura.' });
        return;
      }
      next(err);
    }
  },
);

/**
 * POST /api/facturacion/facturas/:id/estado — `emitida` or `pagada`, and nothing else.
 *
 * `timbrada` and `cancelada` are unreachable from here on purpose: each has its own endpoint that
 * records what makes the claim true (a SAT uuid and a file; a stated reason). A state a caller can
 * simply declare is a state that means nothing, which is the property of the spreadsheet column this
 * replaces.
 */
facturacionRouter.post(
  '/facturas/:id/estado',
  requireAuth,
  requireRole('admin'),
  validate({ params: facturaParam, body: facturaEstadoBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const b = req.body as FacturaEstadoBody;

      const { rows } = await query(
        `UPDATE facturas SET estado = $2
          WHERE id = $1 AND estado NOT IN ('cancelada')
          RETURNING id, folio, tipo, periodo, estado`,
        [id, b.estado],
      );
      if (!rows.length) {
        const existe = await query('SELECT estado FROM facturas WHERE id = $1', [id]);
        if (!existe.rows.length) {
          res.status(404).json({ error: 'Factura no encontrada' });
          return;
        }
        res.status(409).json({ error: 'La factura está cancelada: su estado ya no cambia.' });
        return;
      }

      await recordAudit({
        userId: req.user!.userId,
        action: 'FACTURA_ESTADO',
        entity: 'factura',
        entityId: id,
        after: { ...rows[0], motivo: b.motivo ?? null },
        ip: req.ip,
      });

      res.json({ ok: true, ...rows[0] });
    } catch (err) {
      next(err);
    }
  },
);

/** POST /api/facturacion/facturas/:id/cancelar — with a stated reason, always. */
facturacionRouter.post(
  '/facturas/:id/cancelar',
  requireAuth,
  requireRole('admin'),
  validate({ params: facturaParam, body: facturaCancelarBody }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const { motivo } = req.body as FacturaCancelarBody;
      const userId = req.user!.userId;

      const resultado = await withTransaction(async (q: Q) => {
        const f = await q('SELECT id, folio, estado FROM facturas WHERE id = $1 FOR UPDATE', [id]);
        if (!f.rows.length) return { kind: 'no_encontrado' as const };
        if (f.rows[0].estado === 'cancelada') return { kind: 'noop' as const };

        const upd = await q(
          `UPDATE facturas SET estado = 'cancelada', motivo_cancelacion = $2, cancelada_at = now()
            WHERE id = $1 RETURNING id, folio, estado, cancelada_at AS "canceladaAt"`,
          [id, motivo],
        );
        const ops = await q(
          'SELECT DISTINCT operacion_id FROM factura_partidas WHERE factura_id = $1 AND operacion_id IS NOT NULL',
          [id],
        );
        const eventos = await registrarEventoFactura(q, {
          operacionIds: (ops.rows as Array<{ operacion_id: string }>).map((r) => r.operacion_id),
          tipo: 'FACTURA_CANCELADA',
          payload: {
            facturaId: id,
            folio: f.rows[0].folio,
            motivo,
            // The lines stay: a cancelled invoice is part of the history, and the guías become
            // billable again through the preliquidación (which ignores cancelled invoices).
            efecto: 'Las partidas se conservan; las guías vuelven a ser facturables en la preliquidación.',
          },
          userId,
        });
        return { kind: 'ok' as const, factura: upd.rows[0], eventos };
      });

      switch (resultado.kind) {
        case 'no_encontrado':
          res.status(404).json({ error: 'Factura no encontrada' });
          return;
        case 'noop':
          res.json({ ok: true, noop: true, estado: 'cancelada' });
          return;
        default:
          break;
      }

      await recordAudit({
        userId,
        action: 'FACTURA_CANCELADA',
        entity: 'factura',
        entityId: id,
        after: { folio: resultado.factura.folio, motivo },
        ip: req.ip,
      });

      res.json({ ok: true, ...resultado.factura, motivo, eventosRegistrados: resultado.eventos });
    } catch (err) {
      next(err);
    }
  },
);

// =================================================================================================
// Trazabilidad y reporte mensual — R43 / R44
// =================================================================================================

/**
 * GET /api/facturacion/trazabilidad?guia=…|mawb=… — the authority's question, asked their way.
 *
 * It arrives with a number written on a piece of paper, not with a uuid, so the lookup is by
 * `guia_norm` or `mawb` and it answers with the whole chain: the caso, the trip, the signed POD, the
 * pedimento and every invoice line that ever charged for it. `autoridad` may read it.
 */
facturacionRouter.get(
  '/trazabilidad',
  requireAuth,
  requireRole('admin', 'capturista', 'autoridad'),
  validate({ query: trazabilidadQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const guia = orNull(req.query.guia as string | undefined);
      const mawb = orNull(req.query.mawb as string | undefined);
      if (!guia && !mawb) {
        res.status(400).json({ error: 'Indica `guia` o `mawb`.' });
        return;
      }

      const { rows } = await query(
        `SELECT o.id            AS "operacionId",
                o.mawb,
                o.etapa,
                c.name          AS cliente,
                g.id            AS "operacionGuiaId",
                g.guia_norm     AS "guia",
                g.piezas,
                g.cartones,
                ped.numero_pedimento AS pedimento,
                d.id            AS "despachoId",
                d.folio         AS "despachoFolio",
                d.placas,
                t.razon_social  AS transportista,
                pod.folio       AS "podFolio",
                pod.estado      AS "podEstado",
                pod.firmado_por AS "firmadoPor",
                pod.firmado_at  AS "entregaAt",
                fp.id           AS "partidaId",
                fp.concepto,
                fp.cantidad,
                fp.precio_unitario AS "precioUnitario",
                fp.precio_contratado AS "precioContratado",
                fp.importe,
                f.id            AS "facturaId",
                f.folio         AS "facturaFolio",
                f.tipo          AS "facturaTipo",
                f.uuid_cfdi     AS "uuidCfdi",
                f.estado        AS "facturaEstado",
                f.periodo,
                f.timbrado_prueba AS "timbradoPrueba"
           FROM operaciones o
           LEFT JOIN operacion_guias g ON g.operacion_id = o.id
           LEFT JOIN clients c ON c.id = COALESCE(g.client_id, o.client_id)
           LEFT JOIN pedimentos ped ON ped.id = g.pedimento_id
           LEFT JOIN despacho_partidas dp
                  ON dp.operacion_id = o.id
                 AND (dp.operacion_guia_id = g.id OR (dp.operacion_guia_id IS NULL AND g.id IS NULL))
           LEFT JOIN despachos d ON d.id = dp.despacho_id
           LEFT JOIN transportistas t ON t.id = d.transportista_id
           LEFT JOIN pods pod ON pod.despacho_id = d.id
           LEFT JOIN factura_partidas fp
                  ON fp.operacion_id = o.id
                 AND (fp.operacion_guia_id = g.id OR (fp.operacion_guia_id IS NULL AND g.id IS NULL))
           LEFT JOIN facturas f ON f.id = fp.factura_id
          WHERE ($1::text IS NULL OR g.guia_norm = $1)
            AND ($2::text IS NULL OR o.mawb = $2)
          ORDER BY o.mawb, g.guia_norm, f.created_at
          LIMIT 500`,
        [guia, mawb],
      );

      await recordAudit({
        userId: req.user!.userId,
        action: 'CONSULTA_TRAZABILIDAD_FINANCIERA',
        entity: 'operacion',
        entityId: guia ?? mawb ?? 'desconocido',
        after: { role: req.user!.role, guia, mawb, filas: rows.length },
        ip: req.ip,
      });

      res.json({
        guia,
        mawb,
        // Said out loud: nothing found is not the same as nothing happened.
        encontrado: rows.length > 0,
        filas: rows,
      });
    } catch (err) {
      next(err);
    }
  },
);

/**
 * GET /api/facturacion/reporte-mensual.xlsx — the monthly report for the authority (R43).
 *
 * One row per invoice LINE, not per invoice: an authority asking "what did you charge for this
 * shipment?" needs the line, and a report that only listed totals would be the CFDI again. The
 * contracted price travels beside the charged one so R45's finding is visible in the file itself.
 */
facturacionRouter.get(
  '/reporte-mensual.xlsx',
  requireAuth,
  requireRole('admin', 'autoridad'),
  validate({ query: reporteMensualQuery }),
  async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { clientId, periodo } = req.query as unknown as ReporteMensualQuery;
      const { rows } = await query(
        `SELECT c.name AS cliente, f.periodo, f.tipo, f.folio, f.uuid_cfdi, f.estado,
                f.timbrado_prueba, f.moneda,
                fp.mawb, fp.guia_norm, fp.concepto, fp.unidad, fp.cantidad, fp.piezas,
                fp.precio_unitario, fp.precio_contratado, fp.importe,
                d.folio AS despacho, pod.folio AS pod, pod.firmado_at AS entrega,
                ped.numero_pedimento AS pedimento
           FROM factura_partidas fp
           JOIN facturas f ON f.id = fp.factura_id
           LEFT JOIN clients c ON c.id = f.client_id
           LEFT JOIN despachos d ON d.id = fp.despacho_id
           LEFT JOIN pods pod ON pod.despacho_id = fp.despacho_id
           LEFT JOIN operacion_guias g ON g.id = fp.operacion_guia_id
           LEFT JOIN pedimentos ped ON ped.id = g.pedimento_id
          WHERE f.periodo = $1
            AND ($2::uuid IS NULL OR f.client_id = $2::uuid)
          ORDER BY c.name, f.folio, fp.mawb, fp.guia_norm`,
        [periodo, clientId ?? null],
      );

      const filas = (rows as Array<Record<string, any>>).map((r) => ({
        Cliente: r.cliente ?? '',
        Periodo: r.periodo,
        'Tipo de documento': r.tipo,
        Factura: r.folio ?? '',
        'UUID CFDI': r.uuid_cfdi ?? '',
        'Estado factura': r.estado,
        'Timbrado de prueba': r.timbrado_prueba ? 'Sí' : 'No',
        MAWB: r.mawb ?? '',
        Guía: r.guia_norm ?? '',
        Pedimento: r.pedimento ?? '',
        Despacho: r.despacho ?? '',
        POD: r.pod ?? '',
        'Fecha de entrega': r.entrega ? new Date(r.entrega).toISOString() : '',
        Concepto: r.concepto,
        Unidad: r.unidad,
        Cantidad: Number(r.cantidad),
        Piezas: r.piezas == null ? '' : Number(r.piezas),
        'Precio unitario': Number(r.precio_unitario),
        'Precio contratado': r.precio_contratado == null ? '' : Number(r.precio_contratado),
        'Desviación de tarifa':
          r.precio_contratado == null
            ? ''
            : (desviacionTarifa(Number(r.precio_unitario), Number(r.precio_contratado)) ?? ''),
        Importe: Number(r.importe),
        Moneda: r.moneda,
      }));

      // Audit BEFORE send, same discipline as the PRD-01 exports: the access is durably logged
      // whether or not the download completes.
      await recordAudit({
        userId: req.user!.userId,
        action: 'EXPORT_REPORTE_MENSUAL',
        entity: 'factura',
        entityId: `${clientId ?? 'todos'}:${periodo}`,
        after: { role: req.user!.role, periodo, clientId: clientId ?? null, partidas: filas.length },
        ip: req.ip,
      });

      const ws = XLSX.utils.json_to_sheet(
        filas.length
          ? filas
          : // An empty month is reported as an empty sheet with headers, never as a 404: "no billing
            // in September" is an answer, and a missing file is not.
            [{ Cliente: '', Periodo: periodo, Importe: 0 }],
      );
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Reporte mensual');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

      res.setHeader('Content-Disposition', `attachment; filename="Reporte_mensual_${periodo}.xlsx"`);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.send(buf);
    } catch (err) {
      next(err);
    }
  },
);
