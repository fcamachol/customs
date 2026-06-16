/**
 * RGCE — Reglas Generales de Comercio Exterior
 * T1 Pedimento Compliance Rules (Rules 3.7.3, 3.7.5, 3.7.35)
 *
 * These are the actual operational rules governing Courier and Parcel
 * Companies (Empresas de Mensajería y Paquetería) in Mexico.
 */

import { T1ComplianceRule } from '../types/t1';

/**
 * Base rule definitions. Status is always 'PENDING' at initialization.
 * The compliance engine evaluates these against actual shipment data.
 */
export function createInitialComplianceRules(): T1ComplianceRule[] {
  return [
    // ========================================================================
    // RGCE Rule 3.7.3 — Registration and Operational Prerequisites
    // ========================================================================
    {
      id: 'RGCE-3.7.3-A',
      rgceReference: '3.7.3',
      title: 'Registro ANAM de Empresa de Mensajería',
      description:
        'La empresa debe estar inscrita en el Registro de Empresas de Mensajería y Paquetería ante la ANAM (Trámite 78/LA).',
      severity: 'BLOCKING',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.3-B',
      rgceReference: '3.7.3',
      title: 'Descripción Genérica Prohibida',
      description:
        'Queda prohibida la importación de mercancías cuya descripción sea genérica: "artículos diversos", "regalo", "cortesía", "muestra", etc.',
      severity: 'BLOCKING',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.3-C',
      rgceReference: '3.7.3',
      title: 'Valor Declarado Cero Prohibido',
      description:
        'Queda prohibida la importación de mercancías cuyo valor aduanero se declare como cero.',
      severity: 'BLOCKING',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.3-D',
      rgceReference: '3.7.3',
      title: 'Identificación del Consignatario',
      description:
        'El nombre y RFC del consignatario final deben declararse en el campo de observaciones a nivel partida.',
      severity: 'BLOCKING',
      status: 'PENDING',
    },

    // ========================================================================
    // RGCE Rule 3.7.5 — T1 Dispatch Mechanics and Restrictions
    // ========================================================================
    {
      id: 'RGCE-3.7.5-A',
      rgceReference: '3.7.5',
      title: 'Límite de Valor: $2,500 USD por Consignatario',
      description:
        'El valor en aduana de la mercancía importada no debe exceder de $2,500 USD (o equivalente) por consignatario. Si excede, debe despacharse vía Pedimento A1 con Agente Aduanal.',
      severity: 'BLOCKING',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.5-B',
      rgceReference: '3.7.5',
      title: 'Códigos Genéricos de Fracción Arancelaria',
      description:
        'El T1 debe utilizar códigos genéricos: 9901.00.01 (piezas), 9901.00.02 (kilogramos), 9901.00.05 (litros). No se admiten fracciones LIGIE de 10 dígitos.',
      severity: 'BLOCKING',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.5-C',
      rgceReference: '3.7.5',
      title: 'Prohibición de Envíos Fraccionados',
      description:
        'Queda prohibida la fracción de envíos comerciales de alto valor en múltiples paquetes de ≤$2,500 USD para evadir el Pedimento A1.',
      severity: 'BLOCKING',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.5-D',
      rgceReference: '3.7.5',
      title: 'Modalidad de Transporte: Aéreo o Terrestre',
      description:
        'La operación debe realizarse exclusivamente vía aérea o terrestre. Desde 2025, el T1 no aplica para carga marítima consolidada.',
      severity: 'BLOCKING',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.5-E',
      rgceReference: '3.7.5',
      title: 'Prohibición de Mercancías Sujetas a RRNA',
      description:
        'Está absolutamente prohibido despachar vía T1 mercancías sujetas a Regulaciones y Restricciones No Arancelarias (sanitarias, ambientales, de defensa, etc.).',
      severity: 'BLOCKING',
      status: 'PENDING',
    },

    // ========================================================================
    // RGCE Rule 3.7.35 — Tax Rates (Tasa Global)
    // ========================================================================
    {
      id: 'RGCE-3.7.35-A',
      rgceReference: '3.7.35',
      title: 'Tasa Global Estándar: 33.5%',
      description:
        'Para mercancías de origen no-TLCAN (Resto del Mundo), la tasa global aplicable es del 33.5% (IGI + IVA + DTA).',
      severity: 'INFO',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.35-B',
      rgceReference: '3.7.35',
      title: 'Tasa Preferencial USMCA: 19%',
      description:
        'Para envíos originados en EE.UU. o Canadá con valor >$117 USD y ≤$2,500 USD, aplica tasa preferencial del 19%.',
      severity: 'INFO',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.35-C',
      rgceReference: '3.7.35',
      title: 'Exención De Minimis ≤$50 USD',
      description:
        'Envíos con valor ≤$50 USD pueden estar exentos de impuestos según tratados internacionales aplicables.',
      severity: 'INFO',
      status: 'PENDING',
    },

    // ========================================================================
    // RGCE Rule 3.7.34 — Cancellation Grounds (Audit / ANAM Perspective)
    // ========================================================================
    {
      id: 'RGCE-3.7.34-A',
      rgceReference: '3.7.34',
      title: 'Documentación Falsa o Alterada',
      description:
        'La presentación de documentación alterada o falsa durante el trámite 78/LA es causal de cancelación del registro.',
      severity: 'WARNING',
      status: 'PENDING',
    },
    {
      id: 'RGCE-3.7.34-B',
      rgceReference: '3.7.34',
      title: 'Incumplimiento de Estándares de Seguridad',
      description:
        'El incumplimiento en la instalación de CCTV y controles de acceso según lineamientos SAT/ANAM es causal de cancelación.',
      severity: 'WARNING',
      status: 'PENDING',
    },
  ];
}

/**
 * Lookup table for rule details by ID.
 */
export const RGCE_RULE_DETAILS: Record<string, { action: string; mitigation: string }> = {
  'RGCE-3.7.3-A': {
    action: 'Verificar inscripción en Registro ANAM (Trámite 78/LA).',
    mitigation: 'Solicitar registro ante ACNCE/DGIA con documentación completa.',
  },
  'RGCE-3.7.3-B': {
    action: 'Rechazar envío o solicitar descripción específica al remitente.',
    mitigation: 'Actualizar descripción con producto específico, marca y modelo.',
  },
  'RGCE-3.7.3-C': {
    action: 'Rechazar envío con valor cero.',
    mitigation: 'Solicitar factura comercial con valor real al remitente.',
  },
  'RGCE-3.7.3-D': {
    action: 'Capturar RFC del consignatario en observaciones de partida.',
    mitigation: 'Solicitar RFC válido de 12 o 13 caracteres al destinatario.',
  },
  'RGCE-3.7.5-A': {
    action: 'Extraer del manifiesto T1 y despachar vía Pedimento A1.',
    mitigation: 'El consignatario debe contratar Agente Aduanal y estar en Padrón de Importadores.',
  },
  'RGCE-3.7.5-B': {
    action: 'Reemplazar fracción LIGIE por código genérico según unidad de medida.',
    mitigation: 'Asignar 9901.00.01 (PCE), 9901.00.02 (KGM), o 9901.00.05 (LTR).',
  },
  'RGCE-3.7.5-C': {
    action: 'Marcar consignatario para revisión de fraccionamiento.',
    mitigation: 'Consolidar envíos y despachar vía Pedimento A1 comercial.',
  },
  'RGCE-3.7.5-D': {
    action: 'Rechazar manifiesto marítimo para T1.',
    mitigation: 'Despachar carga marítima consolidada vía A1 con Agente Aduanal.',
  },
  'RGCE-3.7.5-E': {
    action: 'Separar mercancía RRNA del manifiesto T1.',
    mitigation: 'Despachar vía A1 con permisos federales correspondientes.',
  },
  'RGCE-3.7.35-A': {
    action: 'Aplicar tasa global del 33.5% sobre valor en aduana.',
    mitigation: 'No aplica — es la tasa legal vigente para origen no-TLCAN.',
  },
  'RGCE-3.7.35-B': {
    action: 'Verificar guía aérea o BL que acredite origen EE.UU./Canadá.',
    mitigation: 'Aplicar tasa preferencial del 19% con documentación de origen.',
  },
  'RGCE-3.7.35-C': {
    action: 'Verificar tratado aplicable para exención de minimis.',
    mitigation: 'Documentar tratado que ampara la exención.',
  },
};
