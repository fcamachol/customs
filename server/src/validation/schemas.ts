import { z } from 'zod';
import {
  ESTADOS_DESPACHO,
  ESTADOS_FIRMA_CONVENIO,
  ESTADOS_TRANSPORTISTA,
  TIPOS_UNIDAD_IDS,
} from '../../../shared/operaciones/catalogos';
import { UNIDADES_TARIFA } from '../../../shared/operaciones/facturacion';

// Shared role enum. `tramitador` is creatable through the users API (PRD-02 §13): it is the field
// role, so somebody has to be able to hand out accounts for it. `super_admin` stays out on purpose —
// it is provisioned by migration, never by an HTTP call.
const roleEnum = z.enum(['capturista', 'admin', 'autoridad', 'tramitador']);

// users routes
export const createUserBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  role: roleEnum,
});

export const updateUserRoleBody = z.object({
  role: roleEnum,
});

// auth routes
export const loginBody = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
  code: z.string().optional(),
});

export const mfaEnableBody = z.object({
  code: z.string().min(1),
});

// catalogs — clients
export const createClientBody = z.object({
  name: z.string().min(1),
  tax_id: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  website: z.string().optional(),
  platform: z.object({
    commercialName: z.string().optional(),
    countryOfOrigin: z.string().optional(),
    legalName: z.string().optional(),
    email: z.string().email().optional().or(z.literal('')),
    url: z.string().optional(),
  }).optional(),
});

export const updateClientBody = z.object({
  name: z.string().optional(),
  tax_id: z.string().optional(),
  address: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  website: z.string().optional(),
  platform: z.unknown().optional(),
});

// catalogs — client platforms (one client → many)
export const clientPlatformBody = z.object({
  commercialName: z.string().optional(),
  countryOfOrigin: z.string().optional(),
  legalName: z.string().optional(),
  email: z.string().email().optional().or(z.literal('')),
  url: z.string().optional(),
});

// catalogs — config
const ALLOWED_CONFIG_KEYS = ['prohibited', 'piracy_brands', 'branding', 'validation_params', 'denied_parties', 'tasa_vigencias', 'pedimento_scan_policy', 'importer_of_record', 'customs_agent'] as const;
export const configKeyParam = z.object({
  key: z.enum(ALLOWED_CONFIG_KEYS),
});

export const configValueBody = z.object({
  value: z.unknown().refine((v) => v !== undefined, 'value is required'),
});

// catalogs — validated-rfcs
export const validatedRfcBody = z.object({
  id_ref: z.string().min(1),
  rfc: z.string().optional(),
  curp: z.string().optional(),
  name: z.string().optional(),
});

// manifests
export const manifestCreateBody = z.object({
  mawbReference: z.string().min(1),
  clientName: z.string().optional(),
  // Optional: bind the upload to a known client so its saved header mappings apply and the
  // association is recorded up front (the /:id/client route can still set it later).
  clientId: z.string().min(1).optional(),
});

// catalogs — per-client header mappings
export const headerMappingCreateBody = z.object({
  clientId: z.string().min(1).nullable().optional(), // null/absent = global mapping
  header: z.string().min(1),
  canonicalPath: z.string().min(1),
});

export const manifestClientBody = z.object({
  clientId: z.string().min(1),
  platformId: z.string().min(1).optional(),
});

// importData
export const importDataBody = z.object({
  cveT1: z.unknown().optional(),
  patente: z.unknown().optional(),
  agenteAduanal: z.unknown().optional(),
  tasaImportacion: z.unknown().optional(),
  fechaEntrada: z.unknown().optional(),
  claveAduanaEntrada: z.unknown().optional(),
  claveAduanaDespacho: z.unknown().optional(),
  version: z.number().optional(),
}).passthrough();  // allow other unknown fields (allowlist via FIELDS in handler)

// pedimento
export const importerSchema = z.object({
  rfc: z.string().min(1),
  name: z.string().min(1),
  fiscalAddress: z.string().min(1),
}).passthrough();

export const agentSchema = z.object({
  patente: z.string().min(1),
  name: z.string().min(1),
  agentRfc: z.string().min(1),
  agencyRfc: z.string().min(1),
}).passthrough();

export const pedimentoBody = z.object({
  numeroPedimento: z.string().min(1),
  tipoCambio: z.union([z.string().min(1), z.number()]),
  customsEntryCode: z.string().min(1),
  customsClearanceCode: z.string().min(1),
  entryDate: z.string().min(1),
  paymentDate: z.string().min(1),
  importer: importerSchema,
  agent: agentSchema,
}).passthrough();

// risk
export const riskBody = z.object({
  period: z.string().regex(/^\d{4}-\d{2}$/).optional(),
});

// shared id param
export const idParam = z.object({
  id: z.string().min(1),
});

// ---------------------------------------------------------------------------------------------
// campo — field capture by the tramitador (PRD-02 R11, R30–R35)
//
// Everything here has to survive a phone: multipart fields arrive as strings, a cancelled input box
// arrives as '', and the same route is called by a retry queue. So numbers are coerced, empty
// strings collapse to `undefined` rather than to 0, and timestamps are accepted as any string Date
// can parse instead of a strict ISO profile (a client that sends '2026-08-01 10:00:00-06' is being
// useful, not wrong; the range/monotonicity rules that actually matter live in routes/campo.ts).
// ---------------------------------------------------------------------------------------------

/** Optional number tolerant of the empty string a blank form field sends. */
const numeroOpcional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().optional(),
);

/** Optional free text where '' means "not provided". */
const textoOpcional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.string().optional(),
);

const fechaHora = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'La fecha/hora no es válida.');

const fechaHoraOpcional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  fechaHora.optional(),
);

/**
 * `operaciones.id` is a uuid, so a malformed one is validated here rather than left to Postgres —
 * otherwise a typo in the CampoView deep link comes back as a 500 (22P02) instead of a 400.
 */
export const campoOperacionParam = z.object({
  id: z.string().uuid('El id de la operación debe ser un UUID.'),
});

/** The seven buttons of CampoView, in the order a real operation walks them. */
export const campoEventoTipos = [
  'CARGA_DISPONIBLE',
  'INGRESO_PATIO',
  'INGRESO_ADUANA',
  'INICIO_CARGA',
  'FIN_CARGA',
  'MODULACION',
  'SALIDA_ROJO',
] as const;
export type CampoEventoTipo = (typeof campoEventoTipos)[number];

export const campoEventoBody = z.object({
  tipo: z.enum(campoEventoTipos, {
    errorMap: () => ({ message: `tipo debe ser uno de: ${campoEventoTipos.join(', ')}.` }),
  }),
  /**
   * When the fact HAPPENED, per the device. Optional because six of the seven buttons are pressed on
   * the spot; MODULACION is the exception — phones are banned at the semáforo, so it is captured a
   * few minutes late and must carry the real time (R33). Never confused with `registrado_at`.
   */
  ocurridoAt: fechaHoraOpcional,
  lat: numeroOpcional,
  lng: numeroOpcional,
  // English on purpose: the client reads this value (D16). Never verde/rojo.
  semaforo: z
    .enum(['green', 'red'], {
      errorMap: () => ({ message: "semaforo debe ser 'green' o 'red' (en inglés, lo lee el cliente)." }),
    })
    .optional(),
  /** Appointment time given to the transportista, so the delay against it can be measured (R30). */
  citaAt: fechaHoraOpcional,
  motivo: textoOpcional,
  // NOT z.coerce.boolean(): that turns the string 'false' into `true`, so a form-encoded retry could
  // silently mark an event as a human override. Strings are mapped explicitly instead.
  override: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v === 'false' ? false : v === 'true' ? true : v),
    z.boolean().optional(),
  ),
});
export type CampoEventoBody = z.infer<typeof campoEventoBody>;

/** Matches the operacion_evidencias tipo CHECK (migration 1700004500000_campo.ts). */
export const campoEvidenciaTipos = [
  'disponible',
  'inicio_carga',
  'fin_carga',
  'modulacion',
  'entrega',
  'retencion',
  'patio',
  'otro',
] as const;

export const campoEvidenciaBody = z.object({
  tipo: z.enum(campoEvidenciaTipos, {
    errorMap: () => ({ message: `tipo debe ser uno de: ${campoEvidenciaTipos.join(', ')}.` }),
  }),
  /** Required, unlike the evento route: a photo with no capture time proves almost nothing (R32/D5). */
  capturadoAt: fechaHora,
  lat: numeroOpcional,
  lng: numeroOpcional,
  deviceId: textoOpcional,
  /** Ledger event this photo backs — a bigserial id, so it travels as digits. */
  eventoId: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : String(v)),
    z.string().regex(/^\d+$/, 'eventoId debe ser el id numérico de un evento.').optional(),
  ),
});
export type CampoEvidenciaBody = z.infer<typeof campoEvidenciaBody>;

// ---------------------------------------------------------------------------------------------
// holds y retenciones — the blocking layer (PRD-02 §8.4/§8.5, CT-3…CT-6)
//
// `motivo` is required and trimmed-nonempty EVERYWHERE. That is not input hygiene, it is the whole
// point: a block with no stated reason cannot be defended to the authority, and `'   '` would satisfy
// the database's notNull while telling a reader nothing.
// ---------------------------------------------------------------------------------------------

/** Trimmed, non-empty free text. Rejects the whitespace-only string a form sends for "I left it blank". */
const motivoRequerido = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, 'El `motivo` es obligatorio: un bloqueo sin razón no es auditable.');

/** Matches the operacion_holds tipo CHECK (migration 1700004600000_holds_retenciones.ts). */
export const holdTipos = [
  'riesgo',
  'csa',
  'no_transmitida',
  'auditoria_autoridad',
  'documental',
  'cliente_sin_respuesta',
  'otro',
] as const;
export type HoldTipo = (typeof holdTipos)[number];

/**
 * `/api/operaciones/holds/global` sits on the same prefix as `/api/operaciones/:id`, so every
 * parameterized route in the holds router validates its `:id` as a UUID. That is what guarantees the
 * literal string 'holds' can never be captured as an operación id (see routes/holds.ts).
 */
export const holdOperacionParam = z.object({
  id: z.string().uuid('El id de la operación debe ser un UUID.'),
});

export const holdOperacionHoldParam = z.object({
  id: z.string().uuid('El id de la operación debe ser un UUID.'),
  holdId: z.string().uuid('El id del hold debe ser un UUID.'),
});

export const holdGlobalIdParam = z.object({
  holdId: z.string().uuid('El id del hold debe ser un UUID.'),
});

/**
 * The CT-6 button. `tipo` defaults to `auditoria_autoridad` because that is what the button IS — an
 * authority audit of the warehouse — while staying open for the other systemic freezes (a customs
 * system outage, say) so nobody has to mislabel one as an audit.
 */
export const holdGlobalBody = z.object({
  tipo: z.enum(holdTipos).default('auditoria_autoridad'),
  motivo: motivoRequerido,
});
export type HoldGlobalBody = z.infer<typeof holdGlobalBody>;

export const holdOperacionBody = z.object({
  tipo: z.enum(holdTipos, {
    errorMap: () => ({ message: `tipo debe ser uno de: ${holdTipos.join(', ')}.` }),
  }),
  // 'global' is deliberately NOT accepted here: a global freeze is opened through its own admin-only
  // endpoint, never as a side effect of a per-caso call.
  alcance: z.enum(['operacion', 'guia'], {
    errorMap: () => ({ message: "alcance debe ser 'operacion' o 'guia' (el global tiene su propio endpoint)." }),
  }),
  operacionGuiaId: z.string().uuid('operacionGuiaId debe ser un UUID.').optional(),
  motivo: motivoRequerido,
});
export type HoldOperacionBody = z.infer<typeof holdOperacionBody>;

/** Matches the retenciones unidad CHECK. */
export const retencionUnidades = ['pallet', 'carton', 'pieza'] as const;

export const retencionBody = z.object({
  alcance: z.enum(['total', 'parcial'], {
    errorMap: () => ({ message: "alcance debe ser 'total' o 'parcial'." }),
  }),
  unidad: z.enum(retencionUnidades).optional(),
  // Coerced and capped at ≥1: this is what the tramitador types on a phone, and a retención of zero
  // pallets is not a retención.
  cantidad: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().int().positive('cantidad debe ser un entero positivo.').optional(),
  ),
  motivo: motivoRequerido,
  oficioReferencia: textoOpcional,
  operacionGuiaId: z.string().uuid('operacionGuiaId debe ser un UUID.').optional(),
});
export type RetencionBody = z.infer<typeof retencionBody>;

export const retencionParam = z.object({
  id: z.string().uuid('El id de la operación debe ser un UUID.'),
  rid: z.string().uuid('El id de la retención debe ser un UUID.'),
});

// ---------------------------------------------------------------------------------------------
// riesgo_requerimientos — the risk→client bridge with a hard deadline (PRD-02 R18/D13, CT-4)
//
// Two things are required and never optional: WHAT is wrong (`reasonCodes`, or a `detalle` the
// client can act on) and WHO decided (the authenticated caller). A demand that cannot say what it
// wants is a delay with paperwork, and this one can end with a client's cargo frozen.
// ---------------------------------------------------------------------------------------------

/** Shared with the requerimientos routes, which live on the /api/operaciones prefix too. */
export const operacionIdParam = z.object({
  id: z.string().uuid('El id de la operación debe ser un UUID.'),
});

export const requerimientoIdParam = z.object({
  id: z.string().uuid('El id del requerimiento debe ser un UUID.'),
});

/**
 * One entry of the risk engine's `ReasonCode[]` (shared/risk/signals.ts). Validated loosely on
 * purpose — `signalId` is the only field this system reads back, and rejecting a ruleset that grew a
 * field would break emission for the exact findings the client most needs to hear about.
 */
const reasonCode = z
  .object({
    signalId: z.string().min(1),
    points: z.number().optional(),
    weight: z.number().optional(),
    detail: z.string().optional(),
  })
  .passthrough();

export const requerimientoEmitirBody = z
  .object({
    reasonCodes: z.array(reasonCode).default([]),
    rulesetVersion: textoOpcional,
    rulesetHash: textoOpcional,
    /** Free text the client reads, in English (N6). */
    detalle: textoOpcional,
    operacionGuiaId: z.string().uuid('operacionGuiaId debe ser un UUID.').optional(),
    shipmentId: z.string().uuid('shipmentId debe ser un UUID.').optional(),
    /**
     * The offload window added to the caso's ETA (D13). Omitted → the configured default. Capped at
     * a week: a "hard deadline" a month out is not a deadline, it is a way of never deciding.
     */
    ventanaHoras: z.preprocess(
      (v) => (v === '' || v === null || v === undefined ? undefined : v),
      z.coerce.number().positive('ventanaHoras debe ser mayor que cero.').max(168).optional(),
    ),
    /**
     * An explicit deadline, for the caso whose `eta_pais` is unknown (a prealerta that never declared
     * a flight). Required in that case — see routes/riesgoRequerimientos.ts — because inventing a
     * deadline from `now()` would silently shorten the window the client was promised.
     */
    venceAt: fechaHoraOpcional,
    /** Overrides the client-catalog address for this one demand. */
    destinatarioEmail: z.preprocess(
      (v) => (v === '' || v === null || v === undefined ? undefined : v),
      z.string().email('destinatarioEmail debe ser un correo válido.').optional(),
    ),
  })
  .refine((b) => b.reasonCodes.length > 0 || (b.detalle ?? '').trim().length > 0, {
    message:
      'Un requerimiento debe decir qué está mal: envía `reasonCodes` del motor de riesgo o un `detalle`.',
    path: ['reasonCodes'],
  });
export type RequerimientoEmitirBody = z.infer<typeof requerimientoEmitirBody>;

export const requerimientoResolverBody = z.object({
  /** Trimmed-nonempty: "resolved" with no note is indistinguishable from someone closing a ticket. */
  nota: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, 'La `nota` es obligatoria: hay que decir cómo se resolvió.'),
  evidenciaFileId: z.string().uuid('evidenciaFileId debe ser un UUID.').optional(),
});
export type RequerimientoResolverBody = z.infer<typeof requerimientoResolverBody>;

export const requerimientoCancelarBody = z.object({
  motivo: z
    .string()
    .transform((s) => s.trim())
    .refine((s) => s.length > 0, 'El `motivo` es obligatorio: retirar una exigencia debe quedar explicado.'),
});
export type RequerimientoCancelarBody = z.infer<typeof requerimientoCancelarBody>;

export const requerimientoListaQuery = z.object({
  estado: z.enum(['abierto', 'resuelto', 'vencido', 'cancelado', 'todos']).default('abierto'),
  /** "About to expire": the control tower's countdown column (PRD-02 §12). */
  porVencerHoras: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().positive().max(720).optional(),
  ),
  operacionId: z.string().uuid('operacionId debe ser un UUID.').optional(),
});
export type RequerimientoListaQuery = z.infer<typeof requerimientoListaQuery>;

// ---------------------------------------------------------------------------------------------
// motor de contingencias — replaneación (PRD-02 §8.8, CT-1…CT-7)
//
// Same UUID discipline as the holds router and for the same reason: these routes live on the
// `/api/operaciones` prefix, which `operacionesRouter` also owns with a `GET /:id`.
//
// `motivo` is required on BOTH decisions, not only on the confirmation. Discarding a proposal that
// would have avoided a flete en falso is as consequential as accepting one — the difference is who
// pays — and "se descartó" with no stated reason is the exact shape of the untraceable decision this
// platform exists to eliminate (R20/N2).
// ---------------------------------------------------------------------------------------------

export const replanOperacionParam = z.object({
  id: z.string().uuid('El id de la operación debe ser un UUID.'),
});

export const replanAccionParam = z.object({
  id: z.string().uuid('El id de la operación debe ser un UUID.'),
  accionId: z.string().uuid('El id de la acción debe ser un UUID.'),
});

export const replanGuiaParam = z.object({
  id: z.string().uuid('El id de la operación debe ser un UUID.'),
  guiaId: z.string().uuid('El id de la guía debe ser un UUID.'),
});

export const replanDecisionBody = z.object({
  motivo: motivoRequerido,
  /**
   * Which caso absorbs the freed unit. Optional because a coordinator may confirm the reassignment
   * against a load the system does not know about yet (a client's second guía máster arriving that
   * afternoon); the decision is still recorded, and naming the target when it IS known is what makes
   * the tarifa change auditable end to end.
   */
  nuevaOperacionId: z.string().uuid('nuevaOperacionId debe ser un UUID.').optional(),
});
export type ReplanDecisionBody = z.infer<typeof replanDecisionBody>;

/** CT-2's trigger: somebody in the office learns a guía was never transmitted. */
export const replanGuiaNoTransmitidaBody = z.object({
  motivo: motivoRequerido,
});
export type ReplanGuiaNoTransmitidaBody = z.infer<typeof replanGuiaNoTransmitidaBody>;

// ---------------------------------------------------------------------------------------------
// despacho y catálogos de transporte (PRD-02 R21–R29, R36/D14, R38/D15)
//
// The one rule worth stating up front, because it shapes half the schemas below: decision D7 says
// UNIT TYPE FIRST, CARRIER SECOND. So `tipoUnidad` is required wherever a carrier could be chosen —
// on the options query and on despacho creation — and a carrier can never be supplied without it.
// That is not a UI convenience being re-stated; a request that names a transportista with no unit
// type cannot be answered, because the rate that makes the choice meaningful is indexed by type.
// ---------------------------------------------------------------------------------------------

/** R23 / D8 — the full unit-type glossary, sourced from the shared catalog so it cannot drift. */
export const tipoUnidadEnum = z.enum(
  TIPOS_UNIDAD_IDS as unknown as [string, ...string[]],
  { errorMap: () => ({ message: `tipoUnidad debe ser uno de: ${TIPOS_UNIDAD_IDS.join(', ')}.` }) },
);

const estadoDespachoEnum = z.enum(
  ESTADOS_DESPACHO as unknown as [string, ...string[]],
  { errorMap: () => ({ message: `estado debe ser uno de: ${ESTADOS_DESPACHO.join(', ')}.` }) },
);

/** Trimmed, non-empty free text. */
const textoRequerido = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0, 'Este campo es obligatorio.');

/** YYYY-MM-DD. `fecha_operacion` is a DATE column: the operating day, not an instant. */
const fechaISO = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'La fecha debe tener el formato YYYY-MM-DD.');

const fechaOpcional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  fechaISO.optional(),
);

/** Money. Coerced (forms send strings) and non-negative — a negative tariff is a data-entry slip. */
const montoOpcional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().nonnegative('El monto no puede ser negativo.').optional(),
);

const enteroOpcional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().int().nonnegative('Debe ser un entero no negativo.').optional(),
);

/** Latitude/longitude, range-checked so a transposed pair fails here and not inside the estimator. */
const latOpcional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().min(-90).max(90).optional(),
);
const lngOpcional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  z.coerce.number().min(-180).max(180).optional(),
);

// ── params ───────────────────────────────────────────────────────────────────────────────────
export const despachoParam = z.object({
  id: z.string().uuid('El id del despacho debe ser un UUID.'),
});

export const despachoPartidaParam = z.object({
  id: z.string().uuid('El id del despacho debe ser un UUID.'),
  pid: z.string().uuid('El id de la partida debe ser un UUID.'),
});

export const transportistaParam = z.object({
  id: z.string().uuid('El id del transportista debe ser un UUID.'),
});

export const transportistaUnidadParam = z.object({
  id: z.string().uuid('El id del transportista debe ser un UUID.'),
  uid: z.string().uuid('El id de la unidad debe ser un UUID.'),
});

export const transportistaConvenioParam = z.object({
  id: z.string().uuid('El id del transportista debe ser un UUID.'),
  cid: z.string().uuid('El id del convenio debe ser un UUID.'),
});

export const clientDireccionParam = z.object({
  id: z.string().uuid('El id del cliente debe ser un UUID.'),
  did: z.string().uuid('El id de la dirección debe ser un UUID.'),
});

// ── transportistas y su flota (R24) ──────────────────────────────────────────────────────────
export const transportistaBody = z.object({
  razonSocial: textoRequerido,
  // RFC uppercased on the way in: it carries a UNIQUE constraint, and 'abc010101aaa' and
  // 'ABC010101AAA' are the same fiscal person — accepting both would split one carrier in two.
  rfc: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : undefined),
    z.string().optional(),
  ),
  contactoNombre: textoOpcional,
  contactoTelefono: textoOpcional,
  contactoEmail: textoOpcional,
  estado: z.enum(ESTADOS_TRANSPORTISTA as unknown as [string, ...string[]]).optional(),
  documentosOk: z.boolean().optional(),
});
export type TransportistaBody = z.infer<typeof transportistaBody>;

export const transportistaUpdateBody = transportistaBody.partial();
export type TransportistaUpdateBody = z.infer<typeof transportistaUpdateBody>;

export const unidadBody = z.object({
  // Uppercased and stripped of separators for the same reason as the RFC: 'ABC-12-34' and 'ABC1234'
  // are one vehicle, and the UNIQUE constraint is per carrier.
  placas: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim().toUpperCase().replace(/[\s-]/g, '') : v),
    textoRequerido,
  ),
  tipoUnidad: tipoUnidadEnum,
  numeroEconomico: textoOpcional,
  vigenciaSeguro: fechaOpcional,
  vigenciaVerificacion: fechaOpcional,
  activo: z.boolean().optional(),
});
export type UnidadBody = z.infer<typeof unidadBody>;

export const unidadUpdateBody = unidadBody.partial();
export type UnidadUpdateBody = z.infer<typeof unidadUpdateBody>;

// ── convenios y tarifas (R25 / D9) ───────────────────────────────────────────────────────────
export const convenioBody = z.object({
  vigenciaDesde: fechaOpcional,
  vigenciaHasta: fechaOpcional,
  fileId: z.string().uuid('fileId debe ser un UUID.').optional(),
  // Deliberately NOT accepting 'firmado' here: a convenio becomes signed through /firmar, which is
  // the only path that records who signed it and under what reference (D9). Letting a POST declare
  // itself signed would make the signature a word somebody typed.
  estadoFirma: z.enum(['borrador', 'enviado'] as const).optional(),
});
export type ConvenioBody = z.infer<typeof convenioBody>;

export const convenioFirmaBody = z.object({
  firmaProveedor: textoRequerido,
  firmaReferencia: textoRequerido,
  firmaEvidenciaFileId: z.string().uuid('firmaEvidenciaFileId debe ser un UUID.').optional(),
  firmadoAt: fechaHoraOpcional,
});
export type ConvenioFirmaBody = z.infer<typeof convenioFirmaBody>;

export const tarifaBody = z.object({
  tipoUnidad: tipoUnidadEnum,
  // Absent = general rate for this unit type, any destination (see the migration).
  direccionEntregaId: z.string().uuid('direccionEntregaId debe ser un UUID.').optional(),
  tarifa: z.coerce.number().nonnegative('La tarifa no puede ser negativa.'),
  moneda: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : undefined),
    z.string().length(3, 'La moneda es un código ISO de 3 letras.').optional(),
  ),
  vigenciaDesde: fechaOpcional,
  vigenciaHasta: fechaOpcional,
});
export type TarifaBody = z.infer<typeof tarifaBody>;

// ── direcciones de entrega del cliente (R38 / D15) ───────────────────────────────────────────
export const clientDireccionBody = z.object({
  alias: textoRequerido,
  direccion: textoOpcional,
  ciudad: textoOpcional,
  estado: textoOpcional,
  cp: textoOpcional,
  lat: latOpcional,
  lng: lngOpcional,
  contactoNombre: textoOpcional,
  contactoTelefono: textoOpcional,
  horario: textoOpcional,
  activo: z.boolean().optional(),
});
export type ClientDireccionBody = z.infer<typeof clientDireccionBody>;

export const clientDireccionUpdateBody = clientDireccionBody.partial();
export type ClientDireccionUpdateBody = z.infer<typeof clientDireccionUpdateBody>;

// ── despachos (R21, R22/D7, R28, R29) ────────────────────────────────────────────────────────

/**
 * The D7 gate. `tipoUnidad` is REQUIRED — this is the query that answers "which carriers can I
 * call?", and refusing to answer it without a unit type is the mechanism that stops the phone calls
 * Fernando's argument was about.
 */
export const despachoOpcionesQuery = z.object({
  tipoUnidad: tipoUnidadEnum,
  direccionEntregaId: z.string().uuid('direccionEntregaId debe ser un UUID.').optional(),
  fecha: fechaOpcional,
});
export type DespachoOpcionesQuery = z.infer<typeof despachoOpcionesQuery>;

export const despachoListQuery = z.object({
  fecha: fechaOpcional,
  estado: estadoDespachoEnum.optional(),
  transportistaId: z.string().uuid('transportistaId debe ser un UUID.').optional(),
  /**
   * Trazabilidad, the cargo→carrier direction. Without it the only way to ask "which trips carried
   * this caso?" was to pull every despacho and open each one, which is the N+1 that made the
   * question effectively unanswerable from a phone.
   */
  operacionId: z.string().uuid('operacionId debe ser un UUID.').optional(),
});

/**
 * Trazabilidad, the carrier→cargo direction: every partida a transportista ever carried.
 *
 * The window is a date RANGE over `fecha_operacion` rather than a single day, because the question
 * this answers ("what did we send with them, and did it arrive?") is asked about a period — a
 * fortnight, a month, the life of a convenio — and answering it one day at a time is the same N+1
 * with extra steps.
 */
export const transportistaPaquetesQuery = z.object({
  desde: fechaOpcional,
  hasta: fechaOpcional,
  estado: estadoDespachoEnum.optional(),
});
export type TransportistaPaquetesQuery = z.infer<typeof transportistaPaquetesQuery>;

export const despachoCrearBody = z.object({
  fechaOperacion: fechaISO,
  /** D7: notNull in the table, required here, and it comes FIRST in the shape on purpose. */
  tipoUnidad: tipoUnidadEnum,
  // Optional at creation: a trip is planned before a carrier is engaged. Supplying a unit without a
  // carrier is rejected in the route (and by a table CHECK), because a vehicle belonging to nobody
  // cannot be called.
  transportistaId: z.string().uuid('transportistaId debe ser un UUID.').optional(),
  unidadId: z.string().uuid('unidadId debe ser un UUID.').optional(),
  placas: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase().replace(/[\s-]/g, '') : undefined),
    z.string().optional(),
  ),
  operadorNombre: textoOpcional,
  direccionEntregaId: z.string().uuid('direccionEntregaId debe ser un UUID.').optional(),
  citaAt: fechaHoraOpcional,
  folio: textoOpcional,
  comentarios: textoOpcional,
});
export type DespachoCrearBody = z.infer<typeof despachoCrearBody>;

export const despachoActualizarBody = z.object({
  tipoUnidad: tipoUnidadEnum.optional(),
  // `null` is meaningful and distinct from absent: it UNASSIGNS. A coordinator who has to drop a
  // carrier needs a way to say so that is not "leave the old one and hope".
  transportistaId: z.string().uuid().nullable().optional(),
  unidadId: z.string().uuid().nullable().optional(),
  placas: textoOpcional,
  operadorNombre: textoOpcional,
  direccionEntregaId: z.string().uuid().nullable().optional(),
  citaAt: fechaHoraOpcional,
  comentarios: textoOpcional,
  motivo: textoOpcional,
});
export type DespachoActualizarBody = z.infer<typeof despachoActualizarBody>;

/** R29: one more guía onto this truck. */
export const despachoPartidaBody = z.object({
  operacionId: z.string().uuid('operacionId debe ser un UUID.'),
  operacionGuiaId: z.string().uuid('operacionGuiaId debe ser un UUID.').optional(),
  pedimentoId: z.string().uuid('pedimentoId debe ser un UUID.').optional(),
  cartonesPlaneados: enteroOpcional,
  piezas: enteroOpcional,
  // Absent = append at the end. R14's consecutive is assigned by the server so it cannot have holes.
  ordenCarga: z.preprocess(
    (v) => (v === '' || v === null || v === undefined ? undefined : v),
    z.coerce.number().int().positive('ordenCarga debe ser un entero positivo.').optional(),
  ),
});
export type DespachoPartidaBody = z.infer<typeof despachoPartidaBody>;

export const despachoPartidaCargaBody = z.object({
  cartonesCargados: enteroOpcional,
});

/** R21 — one step of the despacho FSM. */
export const despachoEstadoBody = z.object({
  estado: estadoDespachoEnum,
  /** When it happened, per whoever saw it. Same discipline as campo: distinct from registrado_at. */
  ocurridoAt: fechaHoraOpcional,
  motivo: textoOpcional,
});
export type DespachoEstadoBody = z.infer<typeof despachoEstadoBody>;

/**
 * CT-7 / D10 — reassign the already-contracted unit to other cargo instead of cancelling.
 *
 * `motivo` is REQUIRED and there is no default. This is the one action in the module that touches
 * money without a new negotiation, and §8.8's governance rule is explicit: the engine may propose
 * it, a human confirms it, and the confirmation is logged as an override with a stated reason.
 */
export const despachoReasignarBody = z.object({
  motivo: motivoRequerido,
  fechaOperacion: fechaOpcional,
  direccionEntregaId: z.string().uuid('direccionEntregaId debe ser un UUID.').optional(),
  citaAt: fechaHoraOpcional,
  folio: textoOpcional,
  /** Carry the current load over to the new trip, or start empty (the usual case). */
  copiarPartidas: z.boolean().optional(),
});
export type DespachoReasignarBody = z.infer<typeof despachoReasignarBody>;

/** R36/D14 — recompute the estimate. Never invents an origin; see routes/despachos.ts. */
export const despachoEtaBody = z.object({
  salidaAt: fechaHoraOpcional,
  origenIata: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : undefined),
    z.string().length(3, 'origenIata es un código IATA de 3 letras.').optional(),
  ),
  origenLat: latOpcional,
  origenLng: lngOpcional,
});
export type DespachoEtaBody = z.infer<typeof despachoEtaBody>;

/** R36/D14 — the observed arrival, stored beside the estimate and never over it. */
export const despachoArriboBody = z.object({
  arriboAt: fechaHoraOpcional,
  motivo: textoOpcional,
});
export type DespachoArriboBody = z.infer<typeof despachoArriboBody>;

// ── planeación (R14, R19, P4) ────────────────────────────────────────────────────────────────
export const planFechaQuery = z.object({
  fecha: fechaOpcional,
});

export const planPublicarBody = z.object({
  fechaOperacion: fechaISO,
  /**
   * Required from version 2 onward (checked in the route, where the version number is known): a plan
   * that changed for no stated reason is exactly the Excel problem with better storage.
   */
  motivo: textoOpcional,
  destinatarios: z.array(z.string().min(1)).optional(),
});
export type PlanPublicarBody = z.infer<typeof planPublicarBody>;

export const planPublicacionParam = z.object({
  id: z.string().uuid('El id de la publicación debe ser un UUID.'),
});

// ── POD — prueba de entrega (R28, R39) ───────────────────────────────────────────────────────
//
// Everything here has to survive a phone in a warehouse doorway, same as `campo`: the signed sheet
// arrives as multipart, so numbers and booleans come in as strings and a cleared input arrives as ''.

export const podParam = z.object({
  id: z.string().uuid('El id del POD debe ser un UUID.'),
});

export const podListQuery = z.object({
  estado: z.enum(['generado', 'enviado', 'firmado', 'rechazado'] as const).optional(),
  fecha: fechaOpcional,
  despachoId: z.string().uuid('despachoId debe ser un UUID.').optional(),
});

/** Generate (or regenerate) the delivery sheet from the current assignment. */
export const podGenerarBody = z.object({
  observaciones: textoOpcional,
});
export type PodGenerarBody = z.infer<typeof podGenerarBody>;

export const podEnviadoBody = z.object({
  enviadoAt: fechaHoraOpcional,
  /** Who it went to, in whatever handle the operation used (a WhatsApp, an email, a driver's name). */
  destinatario: textoOpcional,
  observaciones: textoOpcional,
});
export type PodEnviadoBody = z.infer<typeof podEnviadoBody>;

/**
 * The signature coming back.
 *
 * `firmadoPor` is REQUIRED and free text: it is the receiving warehouse's employee, a person this
 * system has no catalog of and must not invent one for. A POD marked signed by nobody is the exact
 * shape of the Excel cell this replaces.
 */
export const podFirmadoBody = z.object({
  firmadoPor: textoRequerido,
  firmadoAt: fechaHoraOpcional,
  observaciones: textoOpcional,
});
export type PodFirmadoBody = z.infer<typeof podFirmadoBody>;

/** The client refused the cargo at the door. A real outcome, and it must state its reason (R40). */
export const podRechazadoBody = z.object({
  motivo: motivoRequerido,
  ocurridoAt: fechaHoraOpcional,
});
export type PodRechazadoBody = z.infer<typeof podRechazadoBody>;

// ── trazabilidad financiera (R43–R48, D17/D18) ───────────────────────────────────────────────

const unidadTarifaEnum = z.enum(UNIDADES_TARIFA as unknown as [string, ...string[]], {
  errorMap: () => ({ message: `unidad debe ser una de: ${UNIDADES_TARIFA.join(', ')}.` }),
});

/** YYYY-MM. The billing month — what the monthly report and the authority ask by. */
const periodoISO = z
  .string()
  .regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'El periodo debe tener el formato YYYY-MM.');

const periodoOpcional = z.preprocess(
  (v) => (v === '' || v === null || v === undefined ? undefined : v),
  periodoISO.optional(),
);

/** Money that must be present. Non-negative for the same reason a negative tariff is a slip. */
const montoRequerido = z.coerce.number().nonnegative('El importe no puede ser negativo.');

export const clientTarifaParam = z.object({
  id: z.string().uuid('El id del cliente debe ser un UUID.'),
  tid: z.string().uuid('El id de la tarifa debe ser un UUID.'),
});

/** R46 — what a client pays, per unit. */
export const clientTarifaBody = z.object({
  concepto: textoRequerido,
  unidad: unidadTarifaEnum,
  precio: montoRequerido,
  moneda: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : undefined),
    z.string().length(3, 'La moneda es un código ISO de 3 letras.').optional(),
  ),
  vigenciaDesde: fechaOpcional,
  vigenciaHasta: fechaOpcional,
  contratoFileId: z.string().uuid('contratoFileId debe ser un UUID.').optional(),
  activo: z.boolean().optional(),
});
export type ClientTarifaBody = z.infer<typeof clientTarifaBody>;

export const clientTarifaUpdateBody = clientTarifaBody.partial();
export type ClientTarifaUpdateBody = z.infer<typeof clientTarifaUpdateBody>;

/** R43/R44/R46 — what a client owes for a month, before anybody commits to an invoice. */
export const preliquidacionQuery = z.object({
  clientId: z.string().uuid('clientId debe ser un UUID.'),
  periodo: periodoISO,
  /** Which document type the "already billed" check runs against; see routes/facturacion.ts. */
  tipo: z.enum(['proforma', 'cfdi'] as const).optional(),
});
export type PreliquidacionQuery = z.infer<typeof preliquidacionQuery>;

/**
 * One invoice line, when the caller writes it explicitly rather than taking the preliquidación.
 *
 * `precioContratado` is accepted so a deliberate departure from the tariff can be recorded AS a
 * departure (R45) instead of quietly redefining the contract. Omitted, the route fills it from the
 * client's rate — the comparison is the control, so it is never simply skipped.
 */
export const facturaPartidaBody = z.object({
  operacionId: z.string().uuid('operacionId debe ser un UUID.').optional(),
  operacionGuiaId: z.string().uuid('operacionGuiaId debe ser un UUID.').optional(),
  despachoId: z.string().uuid('despachoId debe ser un UUID.').optional(),
  concepto: textoRequerido,
  unidad: unidadTarifaEnum,
  cantidad: montoRequerido,
  piezas: enteroOpcional,
  precioUnitario: montoRequerido,
  precioContratado: montoOpcional,
  clientTarifaId: z.string().uuid('clientTarifaId debe ser un UUID.').optional(),
});
export type FacturaPartidaBody = z.infer<typeof facturaPartidaBody>;

/** R43/R44 — create the proforma or the CFDI shell with its lines. */
export const facturaCrearBody = z.object({
  clientId: z.string().uuid('clientId debe ser un UUID.'),
  tipo: z.enum(['proforma', 'cfdi'] as const),
  periodo: periodoISO,
  folio: textoOpcional,
  moneda: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim().toUpperCase() : undefined),
    z.string().length(3, 'La moneda es un código ISO de 3 letras.').optional(),
  ),
  /** Absent = build the lines from the preliquidación, which is the normal month-end path. */
  partidas: z.array(facturaPartidaBody).optional(),
  receptorRfc: textoOpcional,
  receptorRazonSocial: textoOpcional,
  receptorCorreo: textoOpcional,
  observaciones: textoOpcional,
});
export type FacturaCrearBody = z.infer<typeof facturaCrearBody>;

export const facturaParam = z.object({
  id: z.string().uuid('El id de la factura debe ser un UUID.'),
});

export const facturaListQuery = z.object({
  clientId: z.string().uuid('clientId debe ser un UUID.').optional(),
  periodo: periodoOpcional,
  estado: z.enum(['borrador', 'emitida', 'timbrada', 'cancelada', 'pagada'] as const).optional(),
  tipo: z.enum(['proforma', 'cfdi'] as const).optional(),
});

/**
 * R48 — attach the stamp. `timbradoPrueba` defaults to TRUE in the route, not here: the T1-specific
 * stamping is not enabled yet, so a caller who says nothing is producing a test stamp and the record
 * must say so. Claiming a fiscal stamp requires saying it out loud.
 */
export const facturaTimbradoBody = z.object({
  uuidCfdi: textoRequerido,
  folio: textoOpcional,
  timbradoAt: fechaHoraOpcional,
  timbradoPrueba: z.boolean().optional(),
});
export type FacturaTimbradoBody = z.infer<typeof facturaTimbradoBody>;

/**
 * The two states nothing else reaches: `emitida` (the document went to the client) and `pagada`.
 * `timbrada` and `cancelada` are deliberately NOT accepted here — each has its own endpoint that
 * records what makes the claim true (a SAT uuid, a stated reason). A state a caller can simply
 * declare is a state that means nothing.
 */
export const facturaEstadoBody = z.object({
  estado: z.enum(['emitida', 'pagada'] as const),
  motivo: textoOpcional,
});
export type FacturaEstadoBody = z.infer<typeof facturaEstadoBody>;

export const facturaCancelarBody = z.object({
  motivo: motivoRequerido,
});
export type FacturaCancelarBody = z.infer<typeof facturaCancelarBody>;

/** R43 — the monthly report the authority asks for, per client. */
export const reporteMensualQuery = z.object({
  clientId: z.string().uuid('clientId debe ser un UUID.').optional(),
  periodo: periodoISO,
});
export type ReporteMensualQuery = z.infer<typeof reporteMensualQuery>;

/** R44 — guía → piezas → factura, asked with the number written on a piece of paper. */
export const trazabilidadQuery = z.object({
  guia: textoOpcional,
  mawb: textoOpcional,
});

// ── reportes operativos (punto 6 y 7 del requerimiento; Fase C) ──────────────────────────────
export const reporteOperativoQuery = z.object({
  desde: fechaOpcional,
  hasta: fechaOpcional,
  clientId: z.string().uuid('clientId debe ser un UUID.').optional(),
});
export type ReporteOperativoQuery = z.infer<typeof reporteOperativoQuery>;
