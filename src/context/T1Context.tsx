/**
 * T1Context — Central State Management for T1 Pedimento Operations
 *
 * Replaces prop drilling with React Context + useReducer.
 * Manages manifest data, compliance state, pedimento generation,
 * tax calculations, and user roles.
 */

import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import {
  T1AppState,
  T1Action,
  T1Shipment,
  T1PedimentoGlobal,
  SAAIRecord500,
  T1Partida,
  PrevalidationResult,
} from '../types/t1';
import { evaluateT1Compliance } from '../engine/t1Compliance';
import { calculateBatchTax } from '../engine/taxCalculator';
import { prevalidatePedimento } from '../engine/prevalidador';
import { assignGenericHsCode } from '../constants/genericHscodes';
import { detectRRNABatch } from '../engine/rrnaDetector';
import { formatPedimento } from '../utils/formatters';

// ============================================================================
// Initial State
// ============================================================================

const initialState: T1AppState = {
  manifest: {
    shipments: [],
    mawbReference: '',
    transportMode: 'AIR',
    fileName: undefined,
    uploadDate: undefined,
  },
  pedimento: {
    pedimento: undefined,
    prevalidation: undefined,
    isGenerating: false,
  },
  compliance: null,
  tax: {
    exchangeRate: 17.85,
    globalTotals: {
      totalBaseUsd: 0,
      totalBaseMxn: 0,
      totalIgi: 0,
      totalIva: 0,
      totalDta: 0,
      totalLiquidacion: 0,
    },
  },
  userRole: 'admin',
  rrnaMode: 'NORMAL',
  satOnline: true,
  satLatency: 124,
};

// ============================================================================
// Reducer
// ============================================================================

function t1Reducer(state: T1AppState, action: T1Action): T1AppState {
  switch (action.type) {
    case 'UPLOAD_MANIFEST': {
      const shipments = detectRRNABatch(action.payload.shipments);
      // Auto-assign generic HS codes
      shipments.forEach((s) => {
        if (!s.genericHsCode) {
          s.genericHsCode = assignGenericHsCode(s.unit);
        }
      });

      const taxTotals = calculateBatchTax(shipments, state.tax.exchangeRate);

      return {
        ...state,
        manifest: {
          shipments,
          mawbReference: action.payload.mawbReference,
          transportMode: 'AIR',
          fileName: action.payload.fileName,
          uploadDate: new Date().toISOString(),
        },
        compliance: null,
        pedimento: {
          pedimento: undefined,
          prevalidation: undefined,
          isGenerating: false,
        },
        tax: {
          ...state.tax,
          globalTotals: {
            totalBaseUsd: taxTotals.totalBaseUsd,
            totalBaseMxn: taxTotals.totalBaseMxn,
            totalIgi: taxTotals.totalIgi,
            totalIva: taxTotals.totalIva,
            totalDta: taxTotals.totalDta,
            totalLiquidacion: taxTotals.totalLiquidacion,
          },
        },
      };
    }

    case 'CLEAR_MANIFEST':
      return {
        ...state,
        manifest: {
          shipments: [],
          mawbReference: '',
          transportMode: 'AIR',
          fileName: undefined,
          uploadDate: undefined,
        },
        compliance: null,
        pedimento: {
          pedimento: undefined,
          prevalidation: undefined,
          isGenerating: false,
        },
        tax: {
          ...state.tax,
          globalTotals: {
            totalBaseUsd: 0,
            totalBaseMxn: 0,
            totalIgi: 0,
            totalIva: 0,
            totalDta: 0,
            totalLiquidacion: 0,
          },
        },
      };

    case 'RUN_COMPLIANCE': {
      const compliance = evaluateT1Compliance(state.manifest.shipments);
      return { ...state, compliance };
    }

    case 'GENERATE_PEDIMENTO': {
      const { emIdentifier, agenteAduanal, numeroPedimento, aduanaSeccion } = action.payload;
      const validShipments = state.manifest.shipments.filter(
        (s) => s.status === 'VALID'
      );

      const partidas: T1Partida[] = validShipments.map((s, index) => ({
        secuencia: index + 1,
        genericHsCode: s.genericHsCode || assignGenericHsCode(s.unit),
        description: s.description,
        quantity: s.quantity,
        unit: s.unit,
        valueUsd: s.declaredValueUsd,
        consigneeName: s.consigneeName,
        consigneeRfc: s.consigneeRfc,
        observation: `EM1|${s.consigneeName}|RFC:${s.consigneeRfc}`,
      }));

      const now = new Date();
      const fecha = now.toISOString().slice(0, 10).replace(/-/g, '');

      const record500: SAAIRecord500 = {
        patent: agenteAduanal.split('-')[0].trim() || '3920',
        pedimento: numeroPedimento.replace(/\s/g, ''),
        clave: 'T1',
        aduanaSeccion: aduanaSeccion || '47-0',
        regimen: 'IMD',
        destino: '9',
        genericRfc: 'EDM930614781',
        fecha,
        paisOrigen: validShipments[0]?.originCountry || '',
        transporte: state.manifest.transportMode === 'AIR' ? '1' : '2',
      };

      // Determine MJ complement: true ONLY if ALL partidas are ≤$50
      const allDeMinimis = partidas.every((p) => p.valueUsd <= 50);

      const pedimento: T1PedimentoGlobal = {
        clave: 'T1',
        emIdentifier,
        mjComplement: allDeMinimis,
        genericRfc: 'EDM930614781',
        agenteAduanal,
        numeroPedimento: formatPedimento(numeroPedimento),
        aduanaSeccion: aduanaSeccion || '47-0',
        fecha,
        record500,
        partidas,
      };

      return {
        ...state,
        pedimento: {
          pedimento,
          prevalidation: undefined,
          isGenerating: false,
        },
      };
    }

    case 'PREVALIDATE_PEDIMENTO': {
      if (!state.pedimento.pedimento) return state;
      const prevalidation = prevalidatePedimento(state.pedimento.pedimento);
      return {
        ...state,
        pedimento: {
          ...state.pedimento,
          prevalidation,
        },
      };
    }

    case 'SET_EXCHANGE_RATE':
      return {
        ...state,
        tax: {
          ...state.tax,
          exchangeRate: action.payload,
        },
      };

    case 'SET_USER_ROLE':
      return { ...state, userRole: action.payload };

    case 'TOGGLE_SAT_ONLINE':
      return { ...state, satOnline: !state.satOnline };

    case 'SET_SAT_LATENCY':
      return { ...state, satLatency: action.payload };

    case 'UPDATE_SHIPMENT_STATUS': {
      const shipments = state.manifest.shipments.map((s) =>
        s.id === action.payload.id ? { ...s, status: action.payload.status } : s
      );
      return {
        ...state,
        manifest: { ...state.manifest, shipments },
      };
    }

    case 'REMOVE_SHIPMENT': {
      const shipments = state.manifest.shipments.filter(
        (s) => s.id !== action.payload
      );
      const taxTotals = calculateBatchTax(shipments, state.tax.exchangeRate);
      return {
        ...state,
        manifest: { ...state.manifest, shipments },
        tax: {
          ...state.tax,
          globalTotals: {
            totalBaseUsd: taxTotals.totalBaseUsd,
            totalBaseMxn: taxTotals.totalBaseMxn,
            totalIgi: taxTotals.totalIgi,
            totalIva: taxTotals.totalIva,
            totalDta: taxTotals.totalDta,
            totalLiquidacion: taxTotals.totalLiquidacion,
          },
        },
      };
    }

    default:
      return state;
  }
}

// ============================================================================
// Context & Hook
// ============================================================================

interface T1ContextValue {
  state: T1AppState;
  dispatch: React.Dispatch<T1Action>;
}

const T1Context = createContext<T1ContextValue | null>(null);

export function T1Provider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(t1Reducer, initialState);
  return (
    <T1Context.Provider value={{ state, dispatch }}>
      {children}
    </T1Context.Provider>
  );
}

export function useT1(): T1ContextValue {
  const context = useContext(T1Context);
  if (!context) {
    throw new Error('useT1 must be used within a T1Provider');
  }
  return context;
}

// ============================================================================
// Convenience Selectors
// ============================================================================

export function useManifest() {
  const { state } = useT1();
  return state.manifest;
}

export function useCompliance() {
  const { state } = useT1();
  return state.compliance;
}

export function usePedimento() {
  const { state } = useT1();
  return state.pedimento;
}

export function useTax() {
  const { state } = useT1();
  return state.tax;
}

export function useUserRole() {
  const { state } = useT1();
  return state.userRole;
}
