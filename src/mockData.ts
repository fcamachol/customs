/**
 * T1 Mock Data — Realistic scenarios for Empresas de Mensajería y Paquetería
 *
 * Covers all RGCE compliance scenarios:
 *   - Valid T1 shipments (de minimis, USMCA, standard)
 *   - Value threshold violations (>$2,500)
 *   - RRNA prohibitions (food, cosmetics, powders, weapons)
 *   - Generic description violations
 *   - Zero value violations
 *   - Fractional shipment patterns
 */

import { T1Shipment } from './types/t1';
import { assignGenericHsCode } from './constants/genericHscodes';
import { detectRRNA } from './engine/rrnaDetector';
import { generateShipmentId } from './utils/formatters';

function createShipment(partial: Omit<T1Shipment, 'id' | 'genericHsCode' | 'rrnaFlags' | 'status'>): T1Shipment {
  const s: T1Shipment = {
    id: generateShipmentId(),
    genericHsCode: assignGenericHsCode(partial.unit),
    rrnaFlags: [],
    status: 'PENDING',
    ...partial,
  };
  s.rrnaFlags = detectRRNA(s);
  if (s.rrnaFlags.length > 0) s.status = 'RRNA_BLOCKED';
  if (s.declaredValueUsd > 2500) s.status = 'EXCEEDS_THRESHOLD';
  return s;
}

export const demoShipments: T1Shipment[] = [
  // ✅ VALID — De minimis (US origin, ≤$50)
  createShipment({
    guideId: 'MX-001234',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Juan Pérez García',
    consigneeRfc: 'PEGJ800101ABC',
    description: 'Smartphone protective case',
    declaredValueUsd: 45.0,
    quantity: 1,
    unit: 'PCE',
    weightKg: 0.3,
    originCountry: 'US',
    transportMode: 'AIR',
  }),
  createShipment({
    guideId: 'MX-001235',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'María López Ruiz',
    consigneeRfc: 'LORM750202DEF',
    description: "Women's cotton t-shirt, size M",
    declaredValueUsd: 28.0,
    quantity: 2,
    unit: 'PCE',
    weightKg: 0.5,
    originCountry: 'US',
    transportMode: 'AIR',
  }),
  createShipment({
    guideId: 'MX-001238',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Roberto Silva',
    consigneeRfc: 'SILR700505MNO',
    description: 'Plastic toy car, model RC-100',
    declaredValueUsd: 35.0,
    quantity: 3,
    unit: 'PCE',
    weightKg: 0.9,
    originCountry: 'US',
    transportMode: 'AIR',
  }),

  // ✅ VALID — USMCA preferential (>$117, ≤$2500)
  createShipment({
    guideId: 'MX-001240',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Empresa Norte SA',
    consigneeRfc: 'ENS010101XYZ',
    description: 'Industrial grade nylon fasteners, 500 pack',
    declaredValueUsd: 189.0,
    quantity: 1,
    unit: 'PCE',
    weightKg: 2.5,
    originCountry: 'CA',
    transportMode: 'AIR',
  }),

  // ⚠️ STANDARD GLOBAL RATE — Rest of World (>50, non-USMCA)
  createShipment({
    guideId: 'MX-001236',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Carlos Hernández',
    consigneeRfc: 'HECC900303GHI',
    description: 'Laptop accessories — USB hub and cables',
    declaredValueUsd: 180.0,
    quantity: 1,
    unit: 'PCE',
    weightKg: 1.2,
    originCountry: 'CN',
    transportMode: 'AIR',
  }),
  createShipment({
    guideId: 'MX-001242',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Importaciones Asia SA',
    consigneeRfc: 'IAS020202ABC',
    description: 'Bluetooth wireless earbuds, model BT-500',
    declaredValueUsd: 89.0,
    quantity: 2,
    unit: 'PCE',
    weightKg: 0.4,
    originCountry: 'CN',
    transportMode: 'AIR',
  }),

  // 🔴 RRNA BLOCKED — COFEPRIS + DIFFICULT_IDENTIFICATION (powder)
  createShipment({
    guideId: 'MX-001237',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Ana Martínez',
    consigneeRfc: 'MARA850404JKL',
    description: 'Organic whey protein powder, chocolate flavor',
    declaredValueUsd: 89.0,
    quantity: 1,
    unit: 'KGM',
    weightKg: 1.0,
    originCountry: 'CA',
    transportMode: 'AIR',
  }),

  // 🔴 RRNA BLOCKED — COFEPRIS COSMETICS
  createShipment({
    guideId: 'MX-001243',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Belleza Natural MX',
    consigneeRfc: 'BNM030303DEF',
    description: 'Anti-aging facial cream with retinol',
    declaredValueUsd: 65.0,
    quantity: 1,
    unit: 'PCE',
    weightKg: 0.2,
    originCountry: 'KR',
    transportMode: 'AIR',
  }),

  // 🔴 RRNA BLOCKED — DIFFICULT_IDENTIFICATION (liquid)
  createShipment({
    guideId: 'MX-001244',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Química Industrial SA',
    consigneeRfc: 'QIS040404GHI',
    description: 'Industrial solvent liquid, 500ml bottle',
    declaredValueUsd: 42.0,
    quantity: 1,
    unit: 'LTR',
    weightKg: 0.6,
    originCountry: 'DE',
    transportMode: 'AIR',
  }),

  // 🔴 RRNA BLOCKED — SEDENA WEAPONS
  createShipment({
    guideId: 'MX-001245',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Seguridad Privada del Norte',
    consigneeRfc: 'SPN050505JKL',
    description: 'Tactical flashlight with strobe, 1000 lumens',
    declaredValueUsd: 75.0,
    quantity: 5,
    unit: 'PCE',
    weightKg: 1.5,
    originCountry: 'US',
    transportMode: 'AIR',
  }),

  // 🔴 BLOCKING — Generic description (Rule 3.7.3-B)
  createShipment({
    guideId: 'MX-001239',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Empresa ABC SA de CV',
    consigneeRfc: 'EAB101010PQR',
    description: 'Artículos diversos',
    declaredValueUsd: 120.0,
    quantity: 5,
    unit: 'PCE',
    weightKg: 2.0,
    originCountry: 'CN',
    transportMode: 'AIR',
  }),

  // 🔴 BLOCKING — Zero value (Rule 3.7.3-C)
  createShipment({
    guideId: 'MX-001246',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Muestras Gratis MX',
    consigneeRfc: 'MGM060606MNO',
    description: 'Promotional sample pens with company logo',
    declaredValueUsd: 0,
    quantity: 50,
    unit: 'PCE',
    weightKg: 0.8,
    originCountry: 'CN',
    transportMode: 'AIR',
  }),

  // 🔴 BLOCKING — Exceeds $2,500 (Rule 3.7.5-A)
  createShipment({
    guideId: 'MX-001247',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Tecnología Avanzada SA',
    consigneeRfc: 'TAS070707PQR',
    description: 'Professional drone with 4K camera and GPS',
    declaredValueUsd: 3200.0,
    quantity: 1,
    unit: 'PCE',
    weightKg: 3.5,
    originCountry: 'US',
    transportMode: 'AIR',
  }),

  // 🔴 FRACTIONAL — Same consignee, multiple packages near limit
  createShipment({
    guideId: 'MX-001248',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Comprador Frecuente',
    consigneeRfc: 'CFR080808STU',
    description: 'Mechanical keyboard, RGB backlit',
    declaredValueUsd: 890.0,
    quantity: 1,
    unit: 'PCE',
    weightKg: 1.8,
    originCountry: 'CN',
    transportMode: 'AIR',
  }),
  createShipment({
    guideId: 'MX-001249',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Comprador Frecuente',
    consigneeRfc: 'CFR080808STU',
    description: 'Gaming mouse, wireless, 16000 DPI',
    declaredValueUsd: 950.0,
    quantity: 1,
    unit: 'PCE',
    weightKg: 0.3,
    originCountry: 'CN',
    transportMode: 'AIR',
  }),
  createShipment({
    guideId: 'MX-001250',
    mawbReference: 'MAWB-7729104-MX',
    consigneeName: 'Comprador Frecuente',
    consigneeRfc: 'CFR080808STU',
    description: 'USB-C docking station, 12-in-1',
    declaredValueUsd: 780.0,
    quantity: 1,
    unit: 'PCE',
    weightKg: 0.6,
    originCountry: 'CN',
    transportMode: 'AIR',
  }),
];

// Pre-compute statuses for demo data
demoShipments.forEach((s) => {
  if (s.status === 'PENDING' && s.rrnaFlags.length === 0 && s.declaredValueUsd <= 2500) {
    s.status = 'VALID';
  }
});
