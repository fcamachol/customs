/**
 * ManifestUploadView — T1 Manifest Upload & Compliance Flow
 *
 * 3-step workflow:
 *   1. Upload & Parse (drag-and-drop with field mapping preview)
 *   2. T1 Compliance Analysis (RGCE rules evaluation)
 *   3. Generate T1 Pedimento Global
 */

import { useState, useRef, useCallback } from 'react';
import type { ReactNode, DragEvent, ChangeEvent } from 'react';
import {
  CloudUpload,
  CheckCircle,
  AlertTriangle,
  Play,
  Loader2,
  RefreshCw,
  FileCheck,
  ArrowRight,
  ArrowLeft,
  Lock,
  ShieldCheck,
  X,
  FileText,
  Sparkles,
  Plane,
  Truck,
  Ban,
  Info,
} from 'lucide-react';
import { useT1 } from '../context/T1Context';
import { parseManifestFile } from '../utils/fileParser';
import { getRecommendedAction } from '../engine/t1Compliance';
import { getCountryName } from '../utils/formatters';
import { RRNA_LABELS } from '../constants/rrnaCategories';

interface Props {
  onToast: (msg: string) => void;
}

export default function ManifestUploadView({ onToast }: Props) {
  const { state, dispatch } = useT1();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [isUploading, setIsUploading] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [selectedFileName, setSelectedFileName] = useState('');
  const [showPedimentoForm, setShowPedimentoForm] = useState(false);
  const [emIdentifier, setEmIdentifier] = useState('EM123456');
  const [agenteAduanal, setAgenteAduanal] = useState('3920 - Mario Sanchez');
  const [numeroPedimento, setNumeroPedimento] = useState('24 12 3004 0001854');
  const [aduanaSeccion, setAduanaSeccion] = useState('47-0');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const { manifest, compliance, userRole } = state;
  const shipments = manifest.shipments;

  // -------------------------------------------------------------------------
  // Upload handlers
  // -------------------------------------------------------------------------

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    setSelectedFileName(file.name);
    try {
      const { shipments: parsed, mawbReference } = await parseManifestFile(file);
      dispatch({
        type: 'UPLOAD_MANIFEST',
        payload: { shipments: parsed, fileName: file.name, mawbReference },
      });
      setIsUploading(false);
      setStep(2);
      onToast(`📦 ${parsed.length} guías parseadas del manifiesto ${file.name}`);
    } catch (err) {
      onToast(`❌ Error: ${err instanceof Error ? err.message : 'Error al procesar archivo'}`);
      setIsUploading(false);
    }
  };

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (userRole === 'autoridad') {
        onToast('🚫 Rol de Autoridad: solo lectura');
        return;
      }
      if (e.dataTransfer.files?.[0]) handleUpload(e.dataTransfer.files[0]);
    },
    [userRole]
  );

  const handleSelectFile = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) handleUpload(e.target.files[0]);
  };

  // -------------------------------------------------------------------------
  // Compliance analysis
  // -------------------------------------------------------------------------

  const runCompliance = () => {
    setIsAnalyzing(true);
    setTimeout(() => {
      dispatch({ type: 'RUN_COMPLIANCE' });
      setIsAnalyzing(false);
      setStep(3);
      onToast('✅ Análisis de cumplimiento RGCE completado');
    }, 800);
  };

  // -------------------------------------------------------------------------
  // Pedimento generation
  // -------------------------------------------------------------------------

  const generatePedimento = () => {
    dispatch({
      type: 'GENERATE_PEDIMENTO',
      payload: { emIdentifier, agenteAduanal, numeroPedimento, aduanaSeccion },
    });
    dispatch({ type: 'PREVALIDATE_PEDIMENTO' });
    setShowPedimentoForm(false);
    onToast('📜 Pedimento T1 generado y prevalidado');
  };

  const resetAll = () => {
    dispatch({ type: 'CLEAR_MANIFEST' });
    setStep(1);
    setSelectedFileName('');
    setShowPedimentoForm(false);
    onToast('🔄 Manifiesto limpiado');
  };

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  const validCount = shipments.filter((s) => s.status === 'VALID').length;
  const blockingCount = shipments.filter((s) =>
    ['EXCEEDS_THRESHOLD', 'RRNA_BLOCKED', 'FRACTIONAL_FLAG', 'ZERO_VALUE_BLOCKED', 'GENERIC_DESC_BLOCKED'].includes(s.status)
  ).length;
  const warningCount = shipments.filter((s) => s.status === 'PENDING').length;

  const blockingRules = compliance?.rules.filter((r) => r.severity === 'BLOCKING' && r.status === 'FAILED') || [];
  const infoRules = compliance?.rules.filter((r) => r.severity === 'INFO') || [];

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Progress bar */}
      <div className="bg-white border border-outline-variant p-4 flex items-center justify-between shadow-sm rounded-lg shrink-0">
        <div className="flex items-center gap-6 w-full">
          {[1, 2, 3].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => step >= s && setStep(s as 1 | 2 | 3)}
              className="flex items-center gap-2 group text-left outline-none flex-1"
            >
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center font-bold text-sm transition-all shrink-0 ${
                  step >= s ? 'bg-primary text-white' : 'border border-outline text-outline'
                }`}
              >
                {s < step ? <CheckCircle className="w-4 h-4" /> : s}
              </div>
              <span className={`font-bold transition-all text-sm ${step >= s ? 'text-primary' : 'text-outline'}`}>
                {s === 1 ? 'Subir Manifiesto' : s === 2 ? 'Análisis T1' : 'Generar Pedimento'}
              </span>
              {s < 3 && (
                <div className={`h-[2px] flex-1 transition-all ${step > s ? 'bg-primary' : 'bg-outline-variant'}`} />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* =====================================================================
          STEP 1: Upload & Parse
          ===================================================================== */}
      {step === 1 && (
        <div className="space-y-6">
          {userRole === 'autoridad' && (
            <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 flex gap-3 text-xs select-none">
              <Lock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="font-extrabold text-amber-800">Acceso de Solo Lectura</p>
                <p className="text-amber-700 font-medium mt-1">
                  Como autoridad fiscalizadora, no puede cargar manifiestos. Seleccione rol Capturista o Admin.
                </p>
              </div>
            </div>
          )}

          {/* Drop zone */}
          <div
            role="button"
            tabIndex={0}
            aria-label="Zona de carga de archivos"
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
            onClick={() => userRole !== 'autoridad' && fileInputRef.current?.click()}
            onKeyDown={(e) => {
              if ((e.key === 'Enter' || e.key === ' ') && userRole !== 'autoridad') {
                fileInputRef.current?.click();
              }
            }}
            className={`border-2 border-dashed rounded-xl p-8 flex flex-col items-center justify-center transition-all select-none shrink-0 ${
              userRole === 'autoridad'
                ? 'bg-slate-50 border-slate-200 text-slate-400 cursor-not-allowed opacity-80'
                : isUploading
                ? 'bg-primary-container/10 border-primary cursor-pointer'
                : 'bg-white border-outline-variant hover:border-primary hover:bg-surface-container-low cursor-pointer'
            }`}
          >
            <input
              type="file"
              ref={fileInputRef}
              onChange={handleSelectFile}
              className="hidden"
              accept=".xlsx,.xls,.json,.csv"
              disabled={userRole === 'autoridad'}
            />
            {isUploading ? (
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="w-12 h-12 text-primary animate-spin" />
                <p className="font-bold text-md text-primary">Procesando manifiesto T1...</p>
                <p className="text-xs text-on-surface-variant">Detectando campos RGCE requeridos...</p>
              </div>
            ) : (
              <div className="flex flex-col items-center text-center">
                <CloudUpload className={`w-14 h-14 mb-2 transition-colors ${userRole === 'autoridad' ? 'text-slate-300' : 'text-outline/80 hover:text-primary'}`} />
                <h4 className="font-bold text-lg text-primary mb-1">Arrastre y suelte el manifiesto T1 aquí</h4>
                <p className="text-xs text-on-surface-variant">
                  Formatos: Excel (.xlsx), CSV, JSON. Columnas esperadas: guía, valor, origen, destinatario, RFC, UOM
                </p>
                <span className={`mt-4 px-4 py-2 border font-bold text-xs rounded transition-all ${
                  userRole === 'autoridad'
                    ? 'border-slate-200 text-slate-400 bg-slate-100 cursor-not-allowed'
                    : 'border-primary text-primary hover:bg-primary hover:text-on-primary cursor-pointer'
                }`}>
                  Seleccionar Archivos
                </span>
              </div>
            )}
          </div>

          {/* Quick guide */}
          <div className="bg-white border border-outline-variant rounded-xl p-5 shadow-sm">
            <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Info className="w-4 h-4 text-primary" />
              Formato Esperado de Manifiesto T1
            </h4>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-[11px]">
              {[
                { label: 'guide_id / guia', desc: 'Número de guía aérea' },
                { label: 'declared_value_usd', desc: 'Valor en USD (máx $2,500)' },
                { label: 'origin_country', desc: 'País origen (US, CA, CN...)' },
                { label: 'consignee_rfc', desc: 'RFC del destinatario' },
                { label: 'description', desc: 'Descripción específica' },
                { label: 'quantity', desc: 'Cantidad' },
                { label: 'unit', desc: 'UOM: PCE, KGM, LTR' },
                { label: 'weight_kg', desc: 'Peso en kilogramos' },
              ].map((col) => (
                <div key={col.label} className="bg-surface-container-low p-2.5 rounded border border-outline-variant/30">
                  <span className="font-bold text-primary">{col.label}</span>
                  <p className="text-on-surface-variant mt-0.5">{col.desc}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          STEP 2: T1 Compliance Analysis
          ===================================================================== */}
      {step === 2 && shipments.length > 0 && (
        <div className="space-y-6">
          {/* Summary header */}
          <div className="bg-[#0b2c1b] text-white p-6 rounded-xl border border-emerald-500/20 shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
            <div className="space-y-1">
              <span className="text-[10px] font-mono font-black text-emerald-300 uppercase tracking-wider block">
                Análisis RGCE — Empresas de Mensajería y Paquetería
              </span>
              <h2 className="text-xl font-black tracking-tight font-sans text-white">
                Resultados del Análisis de Cumplimiento T1
              </h2>
              <p className="text-xs text-white/75 max-w-xl">
                Manifiesto: <span className="font-bold underline">{selectedFileName || manifest.fileName}</span> |
                MAWB: <span className="font-bold">{manifest.mawbReference}</span> |
                Guías: <span className="font-bold">{shipments.length}</span>
              </p>
            </div>
            <div className="flex bg-white/10 px-4 py-3 rounded-xl border border-white/10 shrink-0 text-center items-center justify-around gap-6">
              <div>
                <span className="text-[9px] font-bold text-emerald-300 block uppercase">Válidas T1</span>
                <span className="text-md font-black text-emerald-400">{validCount}</span>
              </div>
              <div className="w-[1px] bg-white/20 h-10" />
              <div>
                <span className="text-[9px] font-bold text-red-300 block uppercase">Bloqueadas</span>
                <span className="text-md font-black text-red-400">{blockingCount}</span>
              </div>
              <div className="w-[1px] bg-white/20 h-10" />
              <div>
                <span className="text-[9px] font-bold text-amber-300 block uppercase">Pendientes</span>
                <span className="text-md font-black text-amber-400">{warningCount}</span>
              </div>
            </div>
          </div>

          {/* Shipment table */}
          <div className="bg-white border border-outline-variant rounded-xl flex flex-col overflow-hidden shadow-sm">
            <div className="p-4 border-b border-outline-variant flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 bg-surface-container-low/40">
              <div>
                <h3 className="font-bold text-primary text-md">Vista Previa de Guías T1</h3>
                <p className="text-xs text-on-surface-variant">Guías detectadas con campos RGCE mapeados</p>
              </div>
              <div className="flex gap-2">
                <span className="inline-flex items-center px-2.5 py-1 rounded bg-surface-container border border-outline-variant text-[11px] font-semibold text-primary">
                  <FileText className="w-3 h-3 text-secondary mr-1" />
                  {selectedFileName || manifest.fileName}
                </span>
                <button
                  onClick={runCompliance}
                  disabled={isAnalyzing}
                  className="bg-primary text-on-primary hover:opacity-90 disabled:opacity-50 px-4 py-2 text-xs font-bold flex items-center gap-1.5 rounded transition-all active:scale-95 whitespace-nowrap cursor-pointer"
                >
                  {isAnalyzing ? (
                    <>
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      <span>Analizando...</span>
                    </>
                  ) : (
                    <>
                      <Play className="w-3.5 h-3.5 fill-current" />
                      <span>Ejecutar Análisis RGCE</span>
                    </>
                  )}
                </button>
              </div>
            </div>

            <div className="overflow-auto custom-scrollbar max-h-[500px] min-h-[300px]">
              <table className="w-full text-left border-collapse">
                <thead className="sticky top-0 bg-surface-container-high z-10 border-b border-outline-variant">
                  <tr>
                    <th className="p-3 text-[11px] font-semibold uppercase text-on-surface-variant">Guía</th>
                    <th className="p-3 text-[11px] font-semibold uppercase text-on-surface-variant">Consignatario / RFC</th>
                    <th className="p-3 text-[11px] font-semibold uppercase text-on-surface-variant">Descripción</th>
                    <th className="p-3 text-[11px] font-semibold uppercase text-on-surface-variant text-right">Valor USD</th>
                    <th className="p-3 text-[11px] font-semibold uppercase text-on-surface-variant">UOM</th>
                    <th className="p-3 text-[11px] font-semibold uppercase text-on-surface-variant">Cód. Genérico</th>
                    <th className="p-3 text-[11px] font-semibold uppercase text-on-surface-variant text-center">Estado T1</th>
                  </tr>
                </thead>
                <tbody className="font-mono text-xs divide-y divide-outline-variant">
                  {shipments.map((s) => {
                    const isBlocked = s.status !== 'VALID' && s.status !== 'PENDING';
                    return (
                      <tr key={s.id} className={`hover:bg-surface-container-low transition-colors ${isBlocked ? 'bg-red-50/30' : ''}`}>
                        <td className="p-3 font-semibold text-primary">{s.guideId}</td>
                        <td className="p-3">
                          <div className="font-sans">
                            <div className="font-bold text-primary text-[11px]">{s.consigneeName}</div>
                            <div className="text-[10px] text-on-surface-variant font-mono">{s.consigneeRfc}</div>
                          </div>
                        </td>
                        <td className="p-3 font-sans text-on-surface-variant max-w-xs truncate">{s.description}</td>
                        <td className="p-3 text-right">${s.declaredValueUsd.toFixed(2)}</td>
                        <td className="p-3">{s.unit}</td>
                        <td className="p-3 text-secondary">{s.genericHsCode}</td>
                        <td className="p-3 text-center">
                          <StatusBadge status={s.status} rrnaFlags={s.rrnaFlags} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="p-3 border-t border-outline-variant bg-surface-container-low/20 flex justify-between shrink-0">
              <button
                onClick={resetAll}
                className="text-[11px] text-on-surface-variant hover:text-primary flex items-center gap-1 bg-transparent border-0 cursor-pointer"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Limpiar Manifiesto</span>
              </button>
              <span className="text-[10px] text-on-surface-variant font-medium">Motor T1 RGCE v2.0</span>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          STEP 3: Generate Pedimento T1
          ===================================================================== */}
      {step === 3 && compliance && (
        <div className="space-y-6">
          {/* Compliance results header */}
          <div className={`p-6 rounded-xl border shadow-lg flex flex-col md:flex-row justify-between items-start md:items-center gap-4 ${
            compliance.canProceed
              ? 'bg-[#0b2c1b] border-emerald-500/20 text-white'
              : 'bg-red-950 border-red-500/30 text-white'
          }`}>
            <div className="space-y-1">
              <span className={`text-[10px] font-mono font-black uppercase tracking-wider block ${
                compliance.canProceed ? 'text-emerald-300' : 'text-red-300'
              }`}>
                {compliance.canProceed ? '✅ CUMPLIMIENTO T1 VERIFICADO' : '❌ BLOQUEANTES DETECTADOS'}
              </span>
              <h2 className="text-xl font-black tracking-tight font-sans text-white">
                {compliance.canProceed
                  ? 'Listo para Generar Pedimento Global T1'
                  : 'Corrija los bloqueantes antes de continuar'}
              </h2>
              <p className="text-xs text-white/75">
                {compliance.summary.passed} de {compliance.summary.total} reglas RGCE aprobadas |
                {compliance.summary.blocking > 0 && ` ${compliance.summary.blocking} bloqueante(s)`}
                {compliance.summary.warning > 0 && ` ${compliance.summary.warning} advertencia(s)`}
              </p>
            </div>
            <div className="flex items-center gap-3">
              {compliance.canProceed && (
                <button
                  onClick={() => setShowPedimentoForm(true)}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-5 py-2.5 rounded-lg font-bold text-xs flex items-center gap-2 transition-all active:scale-95 shadow-sm shadow-emerald-600/20"
                >
                  <FileCheck className="w-4 h-4" />
                  <span>Generar Pedimento T1</span>
                </button>
              )}
              <button
                onClick={() => setStep(2)}
                className="bg-white/10 hover:bg-white/20 text-white px-4 py-2.5 rounded-lg font-bold text-xs flex items-center gap-2 transition-all"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                <span>Regresar</span>
              </button>
            </div>
          </div>

          {/* RGCE Rules breakdown */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Blocking rules */}
            <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
              <div className="p-4 border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
                <span className="text-xs font-bold text-primary uppercase">Reglas Bloqueantes RGCE</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-800">
                  {blockingRules.length} Fallas
                </span>
              </div>
              <div className="p-4 divide-y divide-outline-variant-low max-h-[400px] overflow-y-auto custom-scrollbar">
                {compliance.rules
                  .filter((r) => r.severity === 'BLOCKING')
                  .map((rule) => (
                    <div key={rule.id} className="py-3 first:pt-0 last:pb-0">
                      <div className="flex justify-between items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <p className={`font-bold text-xs ${rule.status === 'FAILED' ? 'text-error' : 'text-emerald-700'}`}>
                            {rule.id}: {rule.title}
                          </p>
                          <p className="text-[10px] text-on-surface-variant mt-0.5">{rule.description}</p>
                        </div>
                        {rule.status === 'FAILED' ? (
                          <Ban className="w-4 h-4 text-error shrink-0 mt-0.5" />
                        ) : (
                          <ShieldCheck className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
                        )}
                      </div>
                      {rule.detail && (
                        <p className={`text-[10px] px-2 py-1 rounded mt-1.5 font-mono ${
                          rule.status === 'FAILED' ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-800'
                        }`}>
                          {rule.detail}
                        </p>
                      )}
                    </div>
                  ))}
              </div>
            </div>

            {/* Info rules (tax rates) */}
            <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
              <div className="p-4 border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
                <span className="text-xs font-bold text-primary uppercase">Tasas Globales (Info)</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-blue-100 text-blue-800">
                  {infoRules.length} Reglas
                </span>
              </div>
              <div className="p-4 divide-y divide-outline-variant-low max-h-[400px] overflow-y-auto custom-scrollbar">
                {infoRules.map((rule) => (
                  <div key={rule.id} className="py-3 first:pt-0 last:pb-0">
                    <p className="font-bold text-xs text-primary">{rule.id}: {rule.title}</p>
                    <p className="text-[10px] text-on-surface-variant mt-0.5">{rule.description}</p>
                    {rule.detail && (
                      <p className="text-[10px] px-2 py-1 rounded mt-1.5 bg-blue-50 text-blue-800 font-mono">
                        {rule.detail}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Shipments needing action */}
          {blockingCount > 0 && (
            <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
              <div className="p-4 border-b border-outline-variant bg-red-50 flex justify-between items-center">
                <span className="text-xs font-bold text-error uppercase">Guías Requieren Acción</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-red-100 text-red-800">
                  {blockingCount} guía(s)
                </span>
              </div>
              <div className="divide-y divide-outline-variant max-h-[350px] overflow-y-auto custom-scrollbar">
                {shipments
                  .filter((s) => s.status !== 'VALID' && s.status !== 'PENDING')
                  .map((s) => (
                    <div key={s.id} className="p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-3 hover:bg-red-50/20">
                      <div className="space-y-1 flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-mono text-xs font-bold text-primary">{s.guideId}</span>
                          <span className="font-mono text-xs font-semibold px-2 py-0.5 bg-surface-container border border-outline-variant rounded text-secondary">
                            {s.genericHsCode}
                          </span>
                          {s.rrnaFlags.map((flag) => (
                            <span key={flag} className="text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-red-100 text-red-700">
                              {RRNA_LABELS[flag]?.label || flag}
                            </span>
                          ))}
                        </div>
                        <p className="text-xs font-bold text-primary truncate">{s.description}</p>
                        <p className="text-[10px] text-on-surface-variant">
                          {getRecommendedAction(s.status)}
                        </p>
                      </div>
                      <div className="text-xs font-bold text-secondary font-mono whitespace-nowrap">
                        ${s.declaredValueUsd.toFixed(2)} | {s.quantity} {s.unit}
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* =====================================================================
          Pedimento Form Modal
          ===================================================================== */}
      {showPedimentoForm && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-xl border border-outline-variant shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-5 border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
              <div>
                <h3 className="font-bold text-primary text-md">Generar Pedimento Global T1</h3>
                <p className="text-xs text-on-surface-variant font-medium mt-1">
                  Complete los datos obligatorios del pedimento consolidado.
                </p>
              </div>
              <button
                onClick={() => setShowPedimentoForm(false)}
                className="text-outline hover:text-primary transition-colors p-1.5 hover:bg-surface-container rounded-full"
                aria-label="Cerrar"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-[#0c4d32] uppercase">Clave</label>
                  <input value="T1" disabled className="w-full p-2 bg-slate-100 border border-outline rounded text-xs font-bold text-slate-500" />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-[#0c4d32] uppercase">Identificador EM</label>
                  <input
                    type="text"
                    value={emIdentifier}
                    onChange={(e) => setEmIdentifier(e.target.value)}
                    className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-bold text-primary"
                    placeholder="e.g. EM123456"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-[#0c4d32] uppercase">Agente Aduanal / Patente</label>
                  <input
                    type="text"
                    value={agenteAduanal}
                    onChange={(e) => setAgenteAduanal(e.target.value)}
                    className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-bold text-primary"
                    placeholder="e.g. 3920 - Mario Sanchez"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-[#0c4d32] uppercase">Número Pedimento (15 dígitos)</label>
                  <input
                    type="text"
                    value={numeroPedimento}
                    onChange={(e) => setNumeroPedimento(e.target.value)}
                    className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-mono font-bold text-primary"
                    placeholder="e.g. 24 12 3004 0001854"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-[#0c4d32] uppercase">Aduana-Sección</label>
                  <input
                    type="text"
                    value={aduanaSeccion}
                    onChange={(e) => setAduanaSeccion(e.target.value)}
                    className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-bold text-primary"
                    placeholder="e.g. 47-0"
                  />
                </div>
                <div className="space-y-1">
                  <label className="text-[9px] font-bold text-[#0c4d32] uppercase">RFC Genérico</label>
                  <input value="EDM930614781" disabled className="w-full p-2 bg-slate-100 border border-outline rounded text-xs font-mono font-bold text-slate-500" />
                </div>
              </div>

              <div className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/50 text-[11px] space-y-1">
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">Guías válidas para T1:</span>
                  <span className="font-bold text-primary">{validCount}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">Total valor USD:</span>
                  <span className="font-bold text-primary">
                    ${shipments.filter((s) => s.status === 'VALID').reduce((sum, s) => sum + s.declaredValueUsd, 0).toFixed(2)}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-on-surface-variant">Liquidación estimada MXN:</span>
                  <span className="font-bold text-primary">
                    ${state.tax.globalTotals.totalLiquidacion.toLocaleString('es-MX', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            </div>

            <div className="p-4 bg-surface-container-low flex flex-col sm:flex-row gap-3">
              <button
                onClick={() => setShowPedimentoForm(false)}
                className="flex-1 bg-white border border-outline text-secondary font-bold py-2 text-xs rounded hover:bg-surface-container transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={generatePedimento}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2 text-xs rounded transition-all flex items-center justify-center gap-1.5 shadow-sm shadow-emerald-600/20"
              >
                <Sparkles className="w-3.5 h-3.5 text-emerald-300" />
                <span>Generar y Prevalidar</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status Badge Component
// ---------------------------------------------------------------------------

function StatusBadge({ status, rrnaFlags }: { status: string; rrnaFlags: string[] }) {
  const config: Record<string, { bg: string; text: string; label: string; icon: ReactNode }> = {
    VALID: { bg: 'bg-emerald-100', text: 'text-emerald-800', label: 'Válida T1', icon: <CheckCircle className="w-3 h-3" /> },
    PENDING: { bg: 'bg-slate-100', text: 'text-slate-700', label: 'Pendiente', icon: <Info className="w-3 h-3" /> },
    EXCEEDS_THRESHOLD: { bg: 'bg-red-100', text: 'text-red-800', label: '>$2,500', icon: <Ban className="w-3 h-3" /> },
    RRNA_BLOCKED: { bg: 'bg-red-100', text: 'text-red-800', label: 'RRNA', icon: <Ban className="w-3 h-3" /> },
    FRACTIONAL_FLAG: { bg: 'bg-amber-100', text: 'text-amber-800', label: 'Fraccionado', icon: <AlertTriangle className="w-3 h-3" /> },
    ZERO_VALUE_BLOCKED: { bg: 'bg-red-100', text: 'text-red-800', label: 'Valor Cero', icon: <Ban className="w-3 h-3" /> },
    GENERIC_DESC_BLOCKED: { bg: 'bg-red-100', text: 'text-red-800', label: 'Desc. Genérica', icon: <Ban className="w-3 h-3" /> },
  };

  const c = config[status] || config.PENDING;

  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[9px] font-extrabold ${c.bg} ${c.text}`}>
      {c.icon}
      {c.label}
    </span>
  );
}
