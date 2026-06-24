import { z } from 'zod';

// Shared role enum
const roleEnum = z.enum(['capturista', 'admin', 'autoridad']);

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
});

// catalogs — config
const ALLOWED_CONFIG_KEYS = ['prohibited', 'piracy_brands', 'branding', 'validation_params', 'denied_parties', 'tasa_vigencias', 'pedimento_scan_policy'] as const;
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
const importerSchema = z.object({
  rfc: z.string().min(1),
  name: z.string().min(1),
  fiscalAddress: z.string().min(1),
}).passthrough();

const agentSchema = z.object({
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
