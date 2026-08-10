import { z } from 'zod';

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
