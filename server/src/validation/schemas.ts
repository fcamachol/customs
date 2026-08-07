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
