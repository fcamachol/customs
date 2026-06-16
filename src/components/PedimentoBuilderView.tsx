/**
 * PedimentoBuilderView — T1 Pedimento Generator & Digital File
 *
 * Features:
 *   - Build T1 Pedimento Global with proper structure
 *   - Prevalidation results display
 *   - SAAI M3 Layout export (Records 500/501/505/551/800)
 *   - Digital file repository with audit trail
 */

import { useState } from 'react';
import {
  FileText,
  Download,
  ShieldCheck,
  CheckCircle,
  AlertTriangle,
  Archive,
  FileSignature,
  X,
  Printer,
  Sparkles,
  Copy,
  ChevronRight,
} from 'lucide-react';
import { useT1 } from '../context/T1Context';
import { formatDateMX, formatPedimento } from '../utils/formatters';

interface Props {
  onToast: (msg: string) => void;
}

export default function PedimentoBuilderView({ onToast }: Props) {
  const { state } = useT1();
  const { pedimento, manifest, tax } = state;
  const ped = pedimento.pedimento;
  const preval = pedimento.prevalidation;

  const [showLayout, setShowLayout] = useState(false);
  const [showPdfPreview, setShowPdfPreview] = useState(false);

  // -------------------------------------------------------------------------
  // SAAI M3 Layout Export
  // -------------------------------------------------------------------------

  const generateM3Layout = (): string => {
    if (!ped) return '';
    const p = ped;
    const patent = p.agenteAduanal.split('-')[0].trim() || '3920';
    const pedNumClean = p.numeroPedimento.replace(/\s/g, '');
    const fecha = p.fecha;

    let content = `* =========================================================================\n`;
    content += `* SGA T1 PRO — GENERADOR DE LAYOUT PEDIMENTO SAAI M3\n`;
    content += `* PATENTE: ${patent} | PEDIMENTO: ${pedNumClean} | FECHA: ${fecha}\n`;
    content += `* CLAVE: T1 | EM: ${p.emIdentifier} | RFC_GEN: ${p.genericRfc}\n`;
    content += `* =========================================================================\n\n`;

    // Record 500: General header
    content += `500|${patent}|${pedNumClean}|T1|9|IMD|${p.genericRfc}|${fecha}|MEX|${p.record500.paisOrigen}|${p.record500.transporte}|\n`;

    // Record 501: Partidas
    p.partidas.forEach((part) => {
      const cleanHs = part.genericHsCode.replace(/\./g, '');
      const seq = String(part.secuencia).padStart(3, '0');
      content += `501|${cleanHs}|${seq}|${part.consigneeRfc}|${part.valueUsd.toFixed(2)}|USD|${p.record500.paisOrigen}|MEX|${part.observation}|\n`;
    });

    // Record 505: Invoice association
    p.partidas.forEach((part) => {
      const seq = String(part.secuencia).padStart(3, '0');
      content += `505|${seq}|1|${part.valueUsd.toFixed(2)}|USD|\n`;
    });

    // Record 551: Tax lines
    const validShipments = manifest.shipments.filter((s) => s.status === 'VALID');
    validShipments.forEach((s, idx) => {
      if (!s.taxBreakdown || s.taxBreakdown.applicableRate === 0) return;
      const seq = String(idx + 1).padStart(3, '0');
      content += `551|01|IGI|21|${s.taxBreakdown.igi.toFixed(2)}|${seq}|\n`;
      content += `551|05|IVA|21|${s.taxBreakdown.iva.toFixed(2)}|${seq}|\n`;
      content += `551|03|DTA|21|${s.taxBreakdown.dta.toFixed(2)}|${seq}|\n`;
    });

    // Record 800: Digital signature placeholder
    content += `800|FirmaElectronicaSGASha256|e.firma:45fa88b901a1c97bd823901a97ce902b33cbde7baf88da72ef91001a4e21a4f0|${patent}|${pedNumClean}|\n`;

    return content;
  };

  const downloadM3Layout = () => {
    if (!ped) return;
    const content = generateM3Layout();
    const patent = ped.agenteAduanal.split('-')[0].trim() || '3920';
    const pedNumClean = ped.numeroPedimento.replace(/\s/g, '');
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `M3_LAYOUT_T1_${patent}_${pedNumClean}.txt`;
    link.click();
    URL.revokeObjectURL(url);
    onToast('📥 Layout SAAI M3 descargado');
  };

  const copyLayoutToClipboard = () => {
    const content = generateM3Layout();
    navigator.clipboard.writeText(content);
    onToast('📋 Layout copiado al portapapeles');
  };

  // -------------------------------------------------------------------------
  // PDF Report export
  // -------------------------------------------------------------------------

  const downloadPDFReport = () => {
    setShowPdfPreview(true);
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (!ped) {
    return (
      <div className="space-y-6">
        <div className="bg-white border border-outline-variant p-6 rounded-xl shadow-sm">
          <div className="flex items-center gap-4">
            <div className="p-3 bg-primary text-white rounded-lg">
              <FileText className="w-6 h-6" />
            </div>
            <div>
              <h2 className="text-lg font-bold">Generador de Pedimento T1</h2>
              <p className="text-xs text-on-surface-variant">
                No hay un pedimento T1 generado. Vaya a "Cargar Manifiesto T1" para analizar guías y generar un pedimento.
              </p>
            </div>
          </div>
        </div>

        <div className="bg-white border border-outline-variant rounded-xl p-8 text-center shadow-sm">
          <Archive className="w-16 h-16 text-outline-variant mx-auto mb-4" />
          <h3 className="text-lg font-bold text-primary mb-2">Sin Pedimento Activo</h3>
          <p className="text-sm text-on-surface-variant max-w-md mx-auto">
            El flujo de trabajo T1 comienza con la carga de un manifiesto de mensajería.
            Una vez analizado y aprobado, podrá generar el Pedimento Global T1 con estructura SAAI M3.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-outline-variant p-6 rounded-xl shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-primary text-white rounded-lg">
            <FileText className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Pedimento Global T1 Generado</h2>
            <p className="text-xs text-on-surface-variant">
              {preval?.status === 'APPROVED'
                ? `✅ Prevalidado — Visto Bueno: ${preval.vistoBueno?.slice(0, 20)}...`
                : '⏳ Prevalidación pendiente o con errores'}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setShowLayout(true)}
            className="bg-white border border-outline hover:bg-surface-container text-primary px-4 py-2.5 rounded-lg font-bold text-xs flex items-center gap-2 transition-all active:scale-95"
          >
            <Archive className="w-4 h-4" />
            <span>Ver Layout M3</span>
          </button>
          <button
            onClick={downloadPDFReport}
            className="bg-primary text-on-primary hover:opacity-90 px-4 py-2.5 rounded-lg font-bold text-xs flex items-center gap-2 transition-all active:scale-95"
          >
            <FileSignature className="w-4 h-4" />
            <span>Reporte Oficial</span>
          </button>
        </div>
      </div>

      {/* Prevalidation banner */}
      {preval && (
        <div className={`p-5 rounded-xl border shadow-sm ${
          preval.status === 'APPROVED'
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-red-50 border-red-200'
        }`}>
          <div className="flex items-start gap-3">
            {preval.status === 'APPROVED' ? (
              <ShieldCheck className="w-6 h-6 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-6 h-6 text-red-600 shrink-0" />
            )}
            <div className="flex-1">
              <h4 className={`font-bold text-sm ${preval.status === 'APPROVED' ? 'text-emerald-800' : 'text-red-800'}`}>
                {preval.status === 'APPROVED'
                  ? 'Prevalidación SAAI M3: APROBADA'
                  : 'Prevalidación SAAI M3: RECHAZADA'}
              </h4>
              {preval.errors.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-[11px] font-bold text-red-700">Errores:</p>
                  <ul className="text-[11px] text-red-700 space-y-0.5">
                    {preval.errors.map((e, i) => (
                      <li key={i} className="font-mono">• {e}</li>
                    ))}
                  </ul>
                </div>
              )}
              {preval.warnings.length > 0 && (
                <div className="mt-2 space-y-1">
                  <p className="text-[11px] font-bold text-amber-700">Advertencias:</p>
                  <ul className="text-[11px] text-amber-700 space-y-0.5">
                    {preval.warnings.map((w, i) => (
                      <li key={i} className="font-mono">• {w}</li>
                    ))}
                  </ul>
                </div>
              )}
              {preval.vistoBueno && (
                <p className="text-[11px] font-mono text-emerald-700 mt-2 bg-emerald-100/50 p-2 rounded">
                  <span className="font-bold">Visto Bueno:</span> {preval.vistoBueno}
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Pedimento summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <SummaryCard
          title="Clave de Pedimento"
          value={ped.clave}
          sub={`EM: ${ped.emIdentifier}`}
          color="primary"
        />
        <SummaryCard
          title="Número de Pedimento"
          value={formatPedimento(ped.numeroPedimento)}
          sub={`Patente: ${ped.agenteAduanal.split('-')[0].trim()}`}
          color="primary"
        />
        <SummaryCard
          title="RFC Genérico"
          value={ped.genericRfc}
          sub={ped.mjComplement ? 'Complemento MJ activo' : 'Sin complemento MJ'}
          color={ped.mjComplement ? 'emerald' : 'slate'}
        />
      </div>

      {/* Tax summary */}
      <div className="bg-white border border-outline-variant rounded-xl p-6 shadow-sm">
        <h4 className="text-xs font-bold text-on-surface-variant uppercase tracking-wider mb-4 flex items-center gap-1.5">
          <Sparkles className="w-4 h-4 text-primary" />
          Resumen de Liquidación (Tasa Global)
        </h4>
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <TaxBox label="Base USD" value={`$${tax.globalTotals.totalBaseUsd.toFixed(2)}`} />
          <TaxBox label="Base MXN" value={`$${tax.globalTotals.totalBaseMxn.toFixed(2)}`} />
          <TaxBox label="IGI" value={`$${tax.globalTotals.totalIgi.toFixed(2)}`} color="text-red-600" />
          <TaxBox label="IVA" value={`$${tax.globalTotals.totalIva.toFixed(2)}`} color="text-red-600" />
          <TaxBox label="DTA" value={`$${tax.globalTotals.totalDta.toFixed(2)}`} color="text-red-600" />
        </div>
        <div className="mt-4 pt-4 border-t border-outline-variant/30 flex justify-between items-center">
          <span className="text-sm font-bold text-primary">TOTAL LIQUIDACIÓN</span>
          <span className="text-xl font-black text-primary">
            ${tax.globalTotals.totalLiquidacion.toLocaleString('es-MX', { minimumFractionDigits: 2 })}
          </span>
        </div>
      </div>

      {/* Partidas table */}
      <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        <div className="p-4 border-b border-outline-variant bg-surface-container-low/40 flex justify-between items-center">
          <h3 className="font-bold text-primary text-sm">Partidas del Pedimento T1</h3>
          <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-primary/10 text-primary">
            {ped.partidas.length} partidas
          </span>
        </div>
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-left border-collapse min-w-[900px]">
            <thead className="bg-surface-container-high text-on-surface-variant border-b border-outline-variant">
              <tr>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase">Sec</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase">Código Genérico</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase">Descripción</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase text-center">Cant</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase">UOM</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase text-right">Valor USD</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase">Consignatario</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase">RFC</th>
                <th className="px-4 py-3 text-[11px] font-semibold uppercase">Observación</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant text-[11px] font-sans">
              {ped.partidas.map((part) => (
                <tr key={part.secuencia} className="hover:bg-surface-container-low transition-colors">
                  <td className="px-4 py-3 font-mono font-bold text-primary">{String(part.secuencia).padStart(3, '0')}</td>
                  <td className="px-4 py-3 font-mono text-secondary">{part.genericHsCode}</td>
                  <td className="px-4 py-3 max-w-[180px] truncate">{part.description}</td>
                  <td className="px-4 py-3 text-center font-bold">{part.quantity}</td>
                  <td className="px-4 py-3">{part.unit}</td>
                  <td className="px-4 py-3 text-right font-mono font-bold">${part.valueUsd.toFixed(2)}</td>
                  <td className="px-4 py-3 max-w-[120px] truncate">{part.consigneeName}</td>
                  <td className="px-4 py-3 font-mono text-[10px] text-secondary">{part.consigneeRfc}</td>
                  <td className="px-4 py-3 font-mono text-[10px] text-on-surface-variant max-w-[200px] truncate">{part.observation}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* =====================================================================
          Layout M3 Modal
          ===================================================================== */}
      {showLayout && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-3xl rounded-xl border border-outline-variant shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200 flex flex-col max-h-[90vh]">
            <div className="p-4 border-b border-outline-variant bg-surface-container-low flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                <Archive className="w-5 h-5 text-primary" />
                <span className="text-xs font-bold font-sans text-primary">Layout SAAI M3 — Pedimento T1</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={copyLayoutToClipboard}
                  className="bg-white border border-outline hover:bg-surface-container text-primary px-3 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 transition-all"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copiar</span>
                </button>
                <button
                  onClick={downloadM3Layout}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-1.5 rounded text-xs font-bold flex items-center gap-1.5 transition-all"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Descargar .txt</span>
                </button>
                <button
                  onClick={() => setShowLayout(false)}
                  className="text-outline hover:text-primary p-1.5 hover:bg-surface-container rounded-full transition-colors"
                  aria-label="Cerrar"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4 bg-slate-900">
              <pre className="font-mono text-[11px] text-emerald-400 whitespace-pre">
                {generateM3Layout()}
              </pre>
            </div>
          </div>
        </div>
      )}

      {/* =====================================================================
          PDF Preview Modal
          ===================================================================== */}
      {showPdfPreview && (
        <div className="fixed inset-0 z-[110] bg-black/60 flex items-center justify-center p-4">
          <style>{`
            @media print {
              body * { visibility: hidden !important; }
              #t1-printable-area, #t1-printable-area * { visibility: visible !important; }
              #t1-printable-area {
                position: absolute !important; left: 0 !important; top: 0 !important;
                width: 100% !important; max-width: 100% !important; margin: 0 !important;
                padding: 15mm !important; box-shadow: none !important;
                background: white !important; color: #000 !important;
              }
              .no-print { display: none !important; }
            }
          `}</style>
          <div className="bg-white w-full max-w-4xl rounded-2xl border border-outline-variant shadow-2xl flex flex-col overflow-hidden h-[90vh]">
            <div className="no-print p-4 border-b border-outline-variant bg-surface-container-low flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs font-bold font-sans text-primary">Reporte Oficial T1 — ANAM/SAT</span>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => window.print()}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Imprimir / Guardar PDF</span>
                </button>
                <button
                  onClick={() => setShowPdfPreview(false)}
                  className="text-outline hover:text-primary p-1.5 hover:bg-surface-container rounded-full"
                  aria-label="Cerrar"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-8 bg-surface-container-low flex justify-center">
              <div id="t1-printable-area" className="bg-white border border-outline-variant/60 w-full max-w-[210mm] min-h-[297mm] p-12 text-slate-800 shadow-lg flex flex-col justify-between font-sans relative">
                <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-[#0C2314] via-[#A88C52] to-[#0C2314]" />
                <div>
                  <div className="flex justify-between items-start pb-6 border-b-2 border-[#0C2314] mb-8">
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block w-4 h-4 rounded-sm bg-gradient-to-br from-[#0C2314] to-[#A88C52]" />
                        <h2 className="text-md font-black tracking-widest text-[#0C2314] uppercase">ANAM — SAT</h2>
                      </div>
                      <h1 className="text-lg font-black font-serif text-[#0C2314]">Pedimento Global T1</h1>
                      <span className="text-[9px] font-bold text-[#A88C52] uppercase tracking-wider block font-sans">
                        Empresas de Mensajería y Paquetería — RGCE 3.7.5
                      </span>
                    </div>
                    <div className="text-right font-mono text-[10px] leading-relaxed text-slate-600">
                      <div><strong>PEDIMENTO:</strong> {formatPedimento(ped.numeroPedimento)}</div>
                      <div><strong>FECHA:</strong> {formatDateMX(new Date())}</div>
                      <div><strong>EM:</strong> {ped.emIdentifier}</div>
                      <div><strong>RFC GEN:</strong> {ped.genericRfc}</div>
                    </div>
                  </div>

                  <div className="text-center mb-8 bg-slate-50 border border-slate-100 p-4 rounded-xl">
                    <h3 className="text-md font-black text-slate-900 uppercase tracking-wide">
                      DECLARACIÓN SIMPLIFICADA DE IMPORTACIÓN T1
                    </h3>
                    <p className="text-[11px] text-slate-500 font-medium mt-1">
                      Pedimento consolidado para empresa de mensajería y paquetería autorizada.
                    </p>
                  </div>

                  <div className="grid grid-cols-4 gap-4 mb-8">
                    <div className="border border-slate-200 rounded-lg p-3 text-center bg-slate-50">
                      <span className="text-[9px] font-bold text-slate-500 uppercase block tracking-wider">Total Partidas</span>
                      <p className="text-xl font-black text-slate-800 mt-1">{ped.partidas.length}</p>
                    </div>
                    <div className="border border-emerald-200 rounded-lg p-3 text-center bg-emerald-50/30">
                      <span className="text-[9px] font-bold text-emerald-700 uppercase block tracking-wider">Base USD</span>
                      <p className="text-xl font-black text-emerald-600 mt-1">${tax.globalTotals.totalBaseUsd.toFixed(2)}</p>
                    </div>
                    <div className="border border-amber-200 rounded-lg p-3 text-center bg-amber-50/30">
                      <span className="text-[9px] font-bold text-amber-700 uppercase block tracking-wider">Tasa Global</span>
                      <p className="text-xl font-black text-amber-600 mt-1">33.5% / 19%</p>
                    </div>
                    <div className="border border-primary-200 rounded-lg p-3 text-center bg-primary/5">
                      <span className="text-[9px] font-bold text-primary-700 uppercase block tracking-wider">Liquidación MXN</span>
                      <p className="text-xl font-black text-primary mt-1">${tax.globalTotals.totalLiquidacion.toFixed(2)}</p>
                    </div>
                  </div>

                  <div className="border border-slate-200 rounded-lg overflow-hidden mb-8">
                    <table className="w-full text-left text-xs border-collapse font-sans">
                      <thead>
                        <tr className="bg-slate-100 font-bold border-b border-slate-200 text-slate-700">
                          <th className="p-3 text-[10px] uppercase">Sec</th>
                          <th className="p-3 text-[10px] uppercase">Código</th>
                          <th className="p-3 text-[10px] uppercase">Descripción</th>
                          <th className="p-3 text-[10px] uppercase text-center">Cant</th>
                          <th className="p-3 text-[10px] uppercase text-right">Valor USD</th>
                          <th className="p-3 text-[10px] uppercase">RFC Consignatario</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono text-[10px] text-slate-600">
                        {ped.partidas.map((part) => (
                          <tr key={part.secuencia} className="hover:bg-slate-50/50">
                            <td className="p-2.5 font-bold text-[#0C2314]">{String(part.secuencia).padStart(3, '0')}</td>
                            <td className="p-2.5 font-bold text-slate-700">{part.genericHsCode}</td>
                            <td className="p-2.5 font-sans truncate max-w-[150px]">{part.description}</td>
                            <td className="p-2.5 text-center">{part.quantity} {part.unit}</td>
                            <td className="p-2.5 text-right font-bold text-slate-900">${part.valueUsd.toFixed(2)}</td>
                            <td className="p-2.5 font-sans">{part.consigneeRfc}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="mt-12 space-y-4 pt-6 border-t border-slate-200">
                  <div className="grid grid-cols-3 gap-6 text-[9px] font-mono leading-relaxed text-slate-500">
                    <div className="col-span-2 space-y-1">
                      <div><strong>CADENA ORIGINAL:</strong></div>
                      <div className="bg-slate-50 p-2 border border-slate-100 rounded break-all select-all">
                        ||SGA_T1_PRO|{ped.emIdentifier}|{ped.numeroPedimento.replace(/\s/g, '')}|{ped.partidas.length}|{preval?.vistoBueno || 'PENDING'}||
                      </div>
                    </div>
                    <div className="col-span-1 space-y-1 text-center flex flex-col justify-end">
                      <div className="font-bold text-slate-700 uppercase text-[9px]">Sello Digital</div>
                      <div className="border border-slate-200 rounded p-1 mx-auto w-24 h-24 bg-white flex flex-col gap-0.5 justify-center items-center">
                        <div className="flex gap-0.5">
                          <span className="w-2 h-2 bg-slate-900" /><span className="w-5 h-2 bg-slate-300" /><span className="w-2 h-2 bg-slate-900" />
                        </div>
                        <div className="flex gap-0.5">
                          <span className="w-1 h-4 bg-slate-500" /><span className="w-6 h-4 bg-slate-900" /><span className="w-1 h-4 bg-slate-400" />
                        </div>
                        <div className="flex gap-0.5">
                          <span className="w-3 h-3 bg-slate-900" /><span className="w-2 h-3 bg-slate-200" /><span className="w-3 h-3 bg-slate-900" />
                        </div>
                        <div className="text-[7px] text-slate-400 font-mono select-none mt-1">SGA T1 PRO</div>
                      </div>
                    </div>
                  </div>
                  <div className="flex justify-between items-center text-[8px] text-slate-400 border-t border-slate-100 pt-2 font-mono">
                    <span>ANAM — EMPRESAS DE MENSAJERÍA Y PAQUETERÍA</span>
                    <span>Documento Oficial • Página 1 de 1</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SummaryCard({
  title,
  value,
  sub,
  color,
}: {
  title: string;
  value: string;
  sub: string;
  color: string;
}) {
  const colorMap: Record<string, { border: string; text: string }> = {
    primary: { border: 'border-l-primary', text: 'text-primary' },
    emerald: { border: 'border-l-emerald-500', text: 'text-emerald-600' },
    slate: { border: 'border-l-slate-400', text: 'text-slate-600' },
  };
  const c = colorMap[color] || colorMap.primary;

  return (
    <div className={`bg-white border border-outline-variant p-5 rounded-xl border-l-4 ${c.border} shadow-sm`}>
      <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">{title}</p>
      <p className={`text-lg font-black mt-1 ${c.text}`}>{value}</p>
      <p className="text-[10px] text-on-surface-variant mt-1">{sub}</p>
    </div>
  );
}

function TaxBox({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-surface-container-low p-3 rounded-lg border border-outline-variant/20 text-center">
      <span className="text-[9px] font-bold text-on-surface-variant uppercase block">{label}</span>
      <span className={`text-sm font-black mt-1 block ${color || 'text-primary'}`}>{value}</span>
    </div>
  );
}
