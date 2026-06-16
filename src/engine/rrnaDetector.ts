/**
 * RRNA Detector — Pattern-matching classifier for prohibited goods
 * RGCE Rule 3.7.5-E: RRNA goods are strictly forbidden in T1 pedimentos
 */

import { T1Shipment, RRNACategory } from '../types/t1';
import { RRNA_PATTERNS } from '../constants/rrnaCategories';

/**
 * Detect RRNA categories in a shipment based on description keywords.
 * Also checks for zero value and generic descriptions.
 */
export function detectRRNA(shipment: T1Shipment): RRNACategory[] {
  const flags: RRNACategory[] = [];
  const desc = shipment.description.toLowerCase();

  // 1. Keyword-based pattern matching
  for (const [category, patterns] of Object.entries(RRNA_PATTERNS)) {
    if (patterns.length === 0) continue; // ZERO_VALUE and GENERIC_DESCRIPTION handled separately
    if (patterns.some((p) => desc.includes(p))) {
      flags.push(category as RRNACategory);
    }
  }

  // 2. Special hard rule: powders / liquids / pills ALWAYS flagged
  // regardless of other descriptions (fentanyl precursor risk)
  const difficultForms = ['polvo', 'powder', 'líquido', 'liquido', 'liquid', 'pastilla', 'pill', 'tableta', 'tablet', 'cápsula', 'capsula', 'capsule', 'gránulo', 'granulo', 'granule'];
  if (difficultForms.some((f) => desc.includes(f))) {
    if (!flags.includes('DIFFICULT_IDENTIFICATION')) {
      flags.push('DIFFICULT_IDENTIFICATION');
    }
  }

  // 3. Zero value check (Rule 3.7.3-C)
  if (shipment.declaredValueUsd <= 0) {
    flags.push('ZERO_VALUE');
  }

  // 4. Generic description check (Rule 3.7.3-B)
  const genericPatterns = [
    'artículos diversos', 'articulos diversos', 'various items',
    'regalo', 'gift', 'cortesía', 'cortesia', 'courtesy',
    'muestra gratis', 'free sample', 'sample free',
    'promotional', 'promocional', 'misc ', 'miscellaneous',
    'sundries', 'surtido', 'assorted', 'mixed items',
    'personal belongings', 'pertenencias personales',
    'household goods', 'efectos personales', 'personal effects',
    'varios', 'miscelaneos', 'misceláneos',
    'general merchandise', 'mercancia general', 'mercancía general',
    'unknown', 'desconocido', 'not specified', 'no especificado',
  ];
  if (genericPatterns.some((p) => desc.includes(p))) {
    flags.push('GENERIC_DESCRIPTION');
  }

  return flags;
}

/**
 * Batch process multiple shipments for RRNA detection.
 * Also mutates each shipment's rrnaFlags and status in place.
 */
export function detectRRNABatch(shipments: T1Shipment[]): T1Shipment[] {
  return shipments.map((shipment) => {
    const flags = detectRRNA(shipment);
    shipment.rrnaFlags = flags;

    if (flags.length > 0) {
      shipment.status = 'RRNA_BLOCKED';
    }

    return shipment;
  });
}

/**
 * Get a human-readable summary of RRNA flags for a shipment.
 */
export function getRRNASummary(flags: RRNACategory[]): string {
  if (flags.length === 0) return 'Sin restricciones RRNA';
  return flags
    .map((f) => {
      switch (f) {
        case 'COFEPRIS_FOOD': return 'COFEPRIS: Alimento/Suplemento';
        case 'COFEPRIS_COSMETICS': return 'COFEPRIS: Cosmético';
        case 'COFEPRIS_MEDICAL': return 'COFEPRIS: Dispositivo Médico';
        case 'SENASICA_AGRICULTURAL': return 'SENASICA: Producto Agrícola';
        case 'SEMARNAT_ENVIRONMENTAL': return 'SEMARNAT: Material Ambiental';
        case 'CITES_WILDLIFE': return 'CITES: Especie Protegida';
        case 'SEDENA_WEAPONS': return 'SEDENA: Arma/Material Bélico';
        case 'DIFFICULT_IDENTIFICATION': return 'Identificación Difícil (polvo/líquido/pastilla)';
        case 'ZERO_VALUE': return 'Valor Cero Prohibido';
        case 'GENERIC_DESCRIPTION': return 'Descripción Genérica Prohibida';
        default: return f;
      }
    })
    .join('; ');
}
