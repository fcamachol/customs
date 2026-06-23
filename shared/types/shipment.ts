// LayOut_sistema.xlsx — 34-column flat register, grouped by section.

export interface ConsigneeData {        // cols 17–25
  name: string;
  rfc: string;
  curp?: string;                         // 18-char
  foreignTaxId?: string;                 // ID fiscal país de residencia
  socialSecurity?: string;
  passport?: string;
  address?: string;
  phone?: string;
  email?: string;
  city?: string;
  postalCode?: string;
  countryCode?: string;
  countryName?: string;
}

export interface SenderData {            // cols 26–30 (NEW)
  name: string;
  taxId?: string;
  address?: string;
  phone?: string;
  email?: string;
  city?: string;
  cityCode?: string;
  countryCode?: string;
  countryName?: string;
}

export interface PlatformData {          // cols 31–34 (NEW)
  commercialName: string;
  countryOfOrigin?: string;
  legalName?: string;
  email?: string;
  url?: string;
}

export interface ShipmentCore {          // cols 1–16
  t1RegistryId?: string;
  patente?: string;
  pedimentoNumber?: string;
  description: string;
  hsCode: string;
  quantity: number;
  unit: string;
  customsValueUsd: number;
  currency: string;
  originCountry: string;       // país de origen (manufactured) — NOT derivable from shipper
  procedenceCountry?: string;  // país de procedencia (shipped-from) — from sender country
  arrivalDate?: string;
  guideId: string;
  appliedRate?: number;
  rrnaNote?: string;
  customsEntryCode?: string;
  customsClearanceCode?: string;
  mawb?: string;
  weight?: number;
  weightUnit?: string;
  weightKg?: number;
  unitPrice?: number;
  bulto?: string;
  clientOrderId?: string;
}

export interface Shipment extends ShipmentCore {
  id: string;
  mawbReference: string;
  consignee: ConsigneeData;
  sender: SenderData;
  platform: PlatformData;
}
