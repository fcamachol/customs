/**
 * ConfigurationView — T1 Simulator & Registry Configuration
 *
 * Features:
 *   - 78/LA Registry Simulator (ANAM authorization requirements)
 *   - Tax rate configuration (33.5% / 19% / historical)
 *   - SAT exchange rate
 *   - De minimis thresholds
 *   - RRNA sensitivity modes
 *   - Manual shipment injection
 */

import { useState } from 'react';
import {
  Settings,
  Plus,
  RefreshCw,
  Database,
  AlertOctagon,
  Check,
  Lock,
  ShieldCheck,
  DollarSign,
  Globe,
  Sliders,
  Info,
  TrendingUp,
} from 'lucide-react';
import { useT1 } from '../context/T1Context';
import { T1Shipment } from '../types/t1';
import { assignGenericHsCode } from '../constants/genericHscodes';
import { detectRRNA } from '../engine/rrnaDetector';
import { generateShipmentId } from '../utils/formatters';

interface Props {
  onToast: (msg: string) => void;
}

export default function ConfigurationView({ onToast }: Props) {
  const { state, dispatch } = useT1();
  const { userRole, tax } = state;

  const [exchangeRate, setExchangeRate] = useState(tax.exchangeRate.toString());
  const [rrnaMode, setRrnaMode] = useState<'STRICT' | 'NORMAL' | 'RELAXED'>('NORMAL');

  // Manual injection form
  const [guideId, setGuideId] = useState('MX-T1-001');
  const [consignee, setConsignee] = useState('Juan Pérez');
  const [rfc, setRfc] = useState('PEGJ800101ABC');
  const [desc, setDesc] = useState('Smartphone case');
  const [value, setValue] = useState('45');
  const [origin, setOrigin] = useState('US');
  const [qty, setQty] = useState('1');
  const [unit, setUnit] = useState('PCE');

  const isAdmin = userRole === 'admin';

  const handleInject = () => {
    if (!isAdmin) {
      onToast('🔒 Solo administrador puede inyectar guías');
      return;
    }

    const shipment: T1Shipment = {
      id: generateShipmentId(),
      guideId: guideId.trim(),
      mawbReference: 'MANUAL-INJECT',
      consigneeName: consignee.trim(),
      consigneeRfc: rfc.trim().toUpperCase(),
      description: desc.trim(),
      declaredValueUsd: parseFloat(value) || 0,
      quantity: parseInt(qty) || 1,
      unit: unit.toUpperCase(),
      weightKg: 0.5,
      originCountry: origin.toUpperCase(),
      transportMode: 'AIR',
      status: 'PENDING',
      genericHsCode: assignGenericHsCode(unit),
      rrnaFlags: [],
    };

    shipment.rrnaFlags = detectRRNA(shipment);
    if (shipment.rrnaFlags.length > 0) shipment.status = 'RRNA_BLOCKED';
    if (shipment.declaredValueUsd > 2500) shipment.status = 'EXCEEDS_THRESHOLD';

    dispatch({
      type: 'UPLOAD_MANIFEST',
      payload: {
        shipments: [...state.manifest.shipments, shipment],
        fileName: 'MANUAL_INJECT',
        mawbReference: state.manifest.mawbReference || 'MANUAL',
      },
    });

    onToast(`🎉 Guía ${guideId} inyectada`);

    // Auto increment
    const parts = guideId.split('-');
    if (parts.length >= 2) {
      const last = parts[parts.length - 1];
      const num = parseInt(last, 10);
      if (!isNaN(num)) {
        parts[parts.length - 1] = String(num + 1).padStart(last.length, '0');
        setGuideId(parts.join('-'));
      }
    }
  };

  const handleSetExchangeRate = () => {
    const rate = parseFloat(exchangeRate);
    if (rate > 0) {
      dispatch({ type: 'SET_EXCHANGE_RATE', payload: rate });
      onToast(`💱 Tipo de cambio actualizado: $${rate.toFixed(2)} MXN/USD`);
    }
  };

  const handleReset = () => {
    dispatch({ type: 'CLEAR_MANIFEST' });
    onToast('🔄 Todos los datos reiniciados');
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-outline-variant p-6 rounded-xl flex items-center gap-4 shadow-sm">
        <div className="p-3 bg-primary text-white rounded-lg">
          <Settings className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-lg font-bold">Configuración T1 & Simulador</h2>
          <p className="text-xs text-on-surface-variant">
            Parámetros del motor RGCE, tasas globales, y simulador de registro 78/LA.
          </p>
        </div>
      </div>

      {!isAdmin && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 flex gap-3 text-xs">
          <Lock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-extrabold">Configuración restringida</p>
            <p className="mt-1">Cambie a rol Admin para modificar parámetros fiscales e inyectar guías.</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Left: Tax & Exchange Rate */}
        <section className="lg:col-span-5 space-y-6">
          {/* Exchange rate */}
          <div className="bg-white border border-outline-variant rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
              <DollarSign className="w-4 h-4" />
              Tipo de Cambio SAT
            </h3>
            <div className="space-y-3">
              <div>
                <label className="text-[10px] font-bold text-on-surface-variant uppercase block mb-1">
                  Tipo de cambio (MXN/USD)
                </label>
                <div className="flex gap-2">
                  <input
                    type="number"
                    step="0.01"
                    value={exchangeRate}
                    onChange={(e) => setExchangeRate(e.target.value)}
                    disabled={!isAdmin}
                    className="flex-1 p-2 border border-outline rounded text-xs outline-none focus:border-primary font-mono font-bold disabled:bg-slate-100"
                  />
                  <button
                    onClick={handleSetExchangeRate}
                    disabled={!isAdmin}
                    className="bg-primary text-on-primary px-4 py-2 text-xs font-bold rounded hover:opacity-90 disabled:opacity-50 transition-all"
                  >
                    Actualizar
                  </button>
                </div>
              </div>
              <p className="text-[10px] text-on-surface-variant">
                Valor actual: <span className="font-bold">${tax.exchangeRate.toFixed(2)} MXN/USD</span>
              </p>
            </div>
          </div>

          {/* Tax rates info */}
          <div className="bg-white border border-outline-variant rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
              <TrendingUp className="w-4 h-4" />
              Tasas Globales Vigentes (RGCE 3.7.35)
            </h3>
            <div className="space-y-3">
              <RateRow label="Estándar (Resto del Mundo)" rate="33.5%" color="red" desc="Aplica a origen no-USMCA con valor >$50 USD" />
              <RateRow label="USMCA Preferencial" rate="19.0%" color="blue" desc="EE.UU./Canadá, valor >$117 y ≤$2,500" />
              <RateRow label="De Minimis Exento" rate="0%" color="emerald" desc="≤$50 USD bajo tratados internacionales" />
            </div>
          </div>

          {/* RRNA sensitivity */}
          <div className="bg-white border border-outline-variant rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
              <Sliders className="w-4 h-4" />
              Sensibilidad RRNA
            </h3>
            <div className="grid grid-cols-3 gap-2">
              {(['STRICT', 'NORMAL', 'RELAXED'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => isAdmin && setRrnaMode(mode)}
                  disabled={!isAdmin}
                  className={`px-3 py-2 rounded text-[10px] font-bold transition-all ${
                    rrnaMode === mode
                      ? 'bg-primary text-white shadow-sm'
                      : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container'
                  } disabled:opacity-50`}
                >
                  {mode === 'STRICT' ? 'Estricto' : mode === 'NORMAL' ? 'Normal' : 'Relajado'}
                </button>
              ))}
            </div>
            <p className="text-[10px] text-on-surface-variant mt-2">
              {rrnaMode === 'STRICT'
                ? 'Detecta más falsos positivos pero máxima seguridad.'
                : rrnaMode === 'NORMAL'
                ? 'Balance entre precisión y recall.'
                : 'Menos detecciones, más permisivo.'}
            </p>
          </div>
        </section>

        {/* Right: Manual injection + 78/LA simulator */}
        <section className="lg:col-span-7 space-y-6">
          {/* 78/LA Registry Simulator */}
          <div className="bg-white border border-outline-variant rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
              <ShieldCheck className="w-4 h-4" />
              Simulador de Registro 78/LA (ANAM)
            </h3>
            <p className="text-[11px] text-on-surface-variant mb-4">
              Requisitos para que una empresa de mensajería obtenga el registro ante ANAM para operar T1:
            </p>
            <div className="space-y-2">
              <RequirementRow met label="RFC activo y domicilio fiscal en México" />
              <RequirementRow met label="e.firma vigente de representantes legales" />
              <RequirementRow met label="Opinión de cumplimiento positiva (SAT)" />
              <RequirementRow met label="No estar en lista de EFOS (Art. 69-B CFF)" />
              <RequirementRow label="Inversión en activos fijos ≥ $1,000,000 USD" />
              <RequirementRow label="Fianza fiscal ≥ $15,000,000 MXN" />
              <RequirementRow label="Concesión Art. 14 / 14-A de la Ley Aduanera" />
              <RequirementRow label="CCTV y controles de acceso aprobados por SAT" />
              <RequirementRow label="Sistema de candados electrónicos con GPS" />
              <RequirementRow label="Acceso en línea para ANAM al sistema de riesgos" />
            </div>
          </div>

          {/* Manual injection form */}
          <div className="bg-white border border-outline-variant rounded-xl p-5 shadow-sm">
            <h3 className="text-xs font-bold text-primary uppercase tracking-wider mb-4 flex items-center gap-2">
              <Database className="w-4 h-4" />
              Inyección Manual de Guía T1
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase block mb-1">Guía ID</label>
                <input
                  value={guideId}
                  onChange={(e) => setGuideId(e.target.value)}
                  disabled={!isAdmin}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase block mb-1">Consignatario</label>
                <input
                  value={consignee}
                  onChange={(e) => setConsignee(e.target.value)}
                  disabled={!isAdmin}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase block mb-1">RFC</label>
                <input
                  value={rfc}
                  onChange={(e) => setRfc(e.target.value.toUpperCase())}
                  disabled={!isAdmin}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase block mb-1">Valor USD</label>
                <input
                  type="number"
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  disabled={!isAdmin}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase block mb-1">Descripción</label>
                <input
                  value={desc}
                  onChange={(e) => setDesc(e.target.value)}
                  disabled={!isAdmin}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase block mb-1">Origen (ISO)</label>
                <input
                  value={origin}
                  onChange={(e) => setOrigin(e.target.value.toUpperCase())}
                  disabled={!isAdmin}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary font-mono disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase block mb-1">Cantidad</label>
                <input
                  type="number"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  disabled={!isAdmin}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary disabled:bg-slate-100"
                />
              </div>
              <div>
                <label className="text-[9px] font-bold text-on-surface-variant uppercase block mb-1">UOM</label>
                <select
                  value={unit}
                  onChange={(e) => setUnit(e.target.value)}
                  disabled={!isAdmin}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary disabled:bg-slate-100"
                >
                  <option value="PCE">Piezas (PCE)</option>
                  <option value="KGM">Kilogramos (KGM)</option>
                  <option value="LTR">Litros (LTR)</option>
                </select>
              </div>
            </div>
            <div className="flex gap-2 mt-4">
              <button
                onClick={handleInject}
                disabled={!isAdmin}
                className="flex-1 bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 px-4 py-2 text-xs font-bold rounded transition-all flex items-center justify-center gap-1.5"
              >
                <Plus className="w-3.5 h-3.5" />
                Inyectar Guía T1
              </button>
              <button
                onClick={handleReset}
                disabled={!isAdmin}
                className="bg-white border border-outline text-secondary hover:bg-surface-container disabled:opacity-50 px-4 py-2 text-xs font-bold rounded transition-all flex items-center gap-1.5"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                Reiniciar Todo
              </button>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

function RateRow({ label, rate, color, desc }: { label: string; rate: string; color: string; desc: string }) {
  const colorMap: Record<string, { badge: string; text: string }> = {
    red: { badge: 'bg-red-100 text-red-800', text: 'text-red-600' },
    blue: { badge: 'bg-blue-100 text-blue-800', text: 'text-blue-600' },
    emerald: { badge: 'bg-emerald-100 text-emerald-800', text: 'text-emerald-600' },
  };
  const c = colorMap[color] || colorMap.red;

  return (
    <div className="flex items-center justify-between p-3 bg-surface-container-low rounded-lg border border-outline-variant/20">
      <div>
        <span className="text-xs font-bold text-primary">{label}</span>
        <p className="text-[10px] text-on-surface-variant mt-0.5">{desc}</p>
      </div>
      <span className={`px-2.5 py-1 rounded text-xs font-black ${c.badge}`}>{rate}</span>
    </div>
  );
}

function RequirementRow({ met, label }: { met?: boolean; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {met ? (
        <Check className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
      ) : (
        <AlertOctagon className="w-3.5 h-3.5 text-amber-500 shrink-0" />
      )}
      <span className={met ? 'text-emerald-700 font-medium' : 'text-on-surface-variant'}>{label}</span>
    </div>
  );
}
