/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { 
  FileText, 
  Calendar, 
  Database, 
  Download, 
  ShieldCheck, 
  AlertTriangle, 
  HelpCircle, 
  CheckCircle,
  Search,
  Filter,
  RefreshCw,
  TrendingDown,
  ExternalLink,
  ChevronLeft,
  ChevronRight,
  GanttChartSquare,
  FileCheck2,
  Lock,
  LockOpen,
  Sparkles,
  Printer,
  X
} from 'lucide-react';
import { GuideRecord, RiskLevel } from '../types';

interface RiskAnalysisViewProps {
  initialRecords: GuideRecord[];
  onCertifyPedimento: () => void;
  onGeneratePedimento: (manifestId: string, customBroker?: string, customPedNum?: string) => void;
  agenteAduanal: string;
  onChangeAgenteAduanal: (val: string) => void;
  numeroPedimento: string;
  onChangeNumeroPedimento: (val: string) => void;
}

export default function RiskAnalysisView({ 
  initialRecords,
  onCertifyPedimento,
  onGeneratePedimento,
  agenteAduanal,
  onChangeAgenteAduanal,
  numeroPedimento,
  onChangeNumeroPedimento
}: RiskAnalysisViewProps) {
  const [records, setRecords] = useState<GuideRecord[]>(initialRecords);
  const [filterLevel, setFilterLevel] = useState<RiskLevel | 'ALL'>('ALL');
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedRecordId, setSelectedRecordId] = useState<string | null>(null);
  const [showPDFModal, setShowPDFModal] = useState(false);

  useEffect(() => {
    setRecords(initialRecords);
  }, [initialRecords]);

  const handleExportCSV = () => {
    // Column Headers
    const headers = [
      "ID Guía (Guide ID)", 
      "Importador (Importer Name)", 
      "Fracción HTS (HTS Code)", 
      "Descripción (Description)", 
      "Valor Declarado USD (Declared Value USD)", 
      "Nivel de Riesgo (Risk Level)"
    ];
    
    // Rows
    const rows = records.map(record => [
      `"${record.guideId}"`,
      `"${record.importerName.replace(/"/g, '""')}"`,
      `"${record.htsCode}"`,
      `"${record.description.replace(/"/g, '""')}"`,
      record.declaredValue.toString(),
      `"${record.riskLevel}"`
    ]);

    const csvContent = [
      headers.join(","),
      ...rows.map(e => e.join(","))
    ].join("\n");

    // Add BOM for Excel UTF-8 support
    const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `Reporte_Analisis_Riesgo_MAWB_7729104.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleExportPDF = () => {
    setShowPDFModal(true);
  };
  
  // Interactive stats
  const totalRecords = records.length;
  const approvedCount = records.filter(r => r.riskLevel === 'CLEARED').length;
  const warningsCount = records.filter(r => r.riskLevel === 'WARNING').length;
  const criticalCount = records.filter(r => r.riskLevel === 'CRITICAL' || r.riskLevel === 'PROHIBITED').length;

  const handleFilterClick = (level: RiskLevel | 'ALL') => {
    setFilterLevel(level);
  };

  const filteredRecords = records.filter(record => {
    const matchesSearch = 
      record.guideId.toLowerCase().includes(searchTerm.toLowerCase()) ||
      record.importerName.toLowerCase().includes(searchTerm.toLowerCase()) ||
      record.description.toLowerCase().includes(searchTerm.toLowerCase()) ||
      record.htsCode.toLowerCase().includes(searchTerm.toLowerCase());

    if (filterLevel === 'ALL') return matchesSearch;
    return matchesSearch && record.riskLevel === filterLevel;
  });

  return (
    <div className="space-y-6">
      
      {/* Summary Header block */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        
        {/* Manifest ID banner */}
        <div className="lg:col-span-2 bg-white border border-outline-variant p-6 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center shadow-sm hover:shadow-md transition-shadow gap-4">
          <div className="space-y-2">
            <span className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block">
              ID MANIFIESTO (MAWB)
            </span>
            <h3 className="text-2xl font-black text-primary tracking-tight">MAWB-7729104-MX</h3>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-primary bg-surface-container/60 border border-outline-variant/30 px-2.5 py-1 rounded">
                <Calendar className="w-3.5 h-3.5 text-secondary" />
                <span>24 OCT 2023</span>
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-primary bg-surface-container/60 border border-outline-variant/30 px-2.5 py-1 rounded">
                <Database className="w-3.5 h-3.5 text-secondary" />
                <span>3,200 Registros</span>
              </span>
            </div>
          </div>

          <div className="shrink-0 flex flex-col sm:flex-row gap-2">
            <button 
              type="button"
              onClick={handleExportPDF}
              className="bg-primary text-on-primary hover:opacity-90 px-4 py-3 rounded-lg font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer whitespace-nowrap"
            >
              <FileCheck2 className="w-4 h-4" />
              <span>Exportar PDF para ANAM</span>
            </button>
            <button 
              type="button"
              onClick={handleExportCSV}
              className="bg-white border border-outline hover:bg-surface-container text-primary px-4 py-3 rounded-lg font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer whitespace-nowrap justify-center"
            >
              <Download className="w-4 h-4 text-emerald-600" />
              <span>Descargar CSV</span>
            </button>
          </div>
        </div>

        {/* Global Confidence Audit Card */}
        <div className="bg-white border border-outline-variant p-6 rounded-xl relative overflow-hidden flex flex-col justify-center shadow-sm">
          <div className="absolute -right-4 -bottom-4 opacity-5 pointer-events-none">
            <ShieldCheck className="w-32 h-32 text-primary" />
          </div>
          <span className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1">
            ESTADO GENERAL
          </span>
          <div className="flex items-baseline gap-1.5 pt-1">
            <h4 className="text-[34px] font-black leading-none text-error">94.2%</h4>
            <p className="text-xs font-bold text-on-surface-variant">Cumplimiento Auditoría</p>
          </div>
          <div className="w-full bg-surface-container-high h-2 rounded-full mt-4">
            <div className="bg-error h-full rounded-full w-[94.2%]" />
          </div>
        </div>
      </div>

      {/* Metric filter buttons tabs */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Card Checked */}
        <button
          type="button"
          onClick={() => handleFilterClick(filterLevel === 'CLEARED' ? 'ALL' : 'CLEARED')}
          className={`text-left bg-white border p-5 rounded-xl border-l-4 border-l-emerald-500 hover:shadow-md transition-all relative cursor-pointer outline-none ${
            filterLevel === 'CLEARED' ? 'ring-2 ring-emerald-500 shadow-sm' : 'border-outline-variant'
          }`}
        >
          <div className="flex justify-between items-start mb-3">
            <div>
              <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">APROBADOS</p>
              <h4 className="text-3xl font-black text-emerald-600 mt-1">{approvedCount}</h4>
            </div>
            <div className="p-2 bg-emerald-50 text-emerald-600 rounded-full">
              <CheckCircle className="w-5 h-5 fill-current" />
            </div>
          </div>
          <p className="text-xs text-on-surface-variant leading-relaxed">
            Sin discrepancias detectadas en HTS o domicilios.
          </p>
        </button>

        {/* Card Warning */}
        <button
          type="button"
          onClick={() => handleFilterClick(filterLevel === 'WARNING' ? 'ALL' : 'WARNING')}
          className={`text-left bg-white border p-5 rounded-xl border-l-4 border-l-amber-400 hover:shadow-md transition-all relative cursor-pointer outline-none ${
            filterLevel === 'WARNING' ? 'ring-2 ring-amber-400 shadow-sm' : 'border-outline-variant'
          }`}
        >
          <div className="flex justify-between items-start mb-3">
            <div>
              <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider font-semibold animate-pulse">NO IDENTIFICADOS</p>
              <h4 className="text-3xl font-black text-amber-500 mt-1">{warningsCount}</h4>
            </div>
            <div className="p-2 bg-amber-50 text-amber-500 rounded-full">
              <HelpCircle className="w-5 h-5 fill-current" />
            </div>
          </div>
          <p className="text-xs text-on-surface-variant leading-relaxed">
            Descripciones genéricas o SKUs fuera de catálogo común.
          </p>
        </button>

        {/* Card Critical */}
        <button
          type="button"
          onClick={() => handleFilterClick(filterLevel === 'CRITICAL' ? 'ALL' : 'CRITICAL')}
          className={`text-left bg-white border p-5 rounded-xl border-l-4 border-l-error hover:shadow-md transition-all relative cursor-pointer outline-none ${
            filterLevel === 'CRITICAL' ? 'ring-2 ring-error shadow-sm' : 'border-outline-variant'
          }`}
        >
          <div className="flex justify-between items-start mb-3">
            <div>
              <p className="text-[10px] font-bold text-error uppercase tracking-wider">VALIDAR EN PREVIO</p>
              <h4 className="text-3xl font-black text-error mt-1">{criticalCount}</h4>
            </div>
            <div className="p-2 bg-red-50 text-error rounded-full">
              <AlertTriangle className="w-5 h-5 fill-current" />
            </div>
          </div>
          <p className="text-xs text-on-surface-variant leading-relaxed">
            Riesgo crítico: Artículos prohibidos o direcciones duplicadas.
          </p>
        </button>
      </div>

      {/* Main interactive Table section */}
      <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        
        {/* Table filters strip info */}
        <div className="p-4 border-b border-outline-variant flex flex-wrap gap-4 items-center justify-between bg-surface-container-low/40">
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center bg-primary text-white text-[11px] font-bold px-2.5 py-1 rounded">
              <Filter className="w-3 h-3 mr-1" />
              <span>Todos los Registros</span>
            </span>

            {filterLevel !== 'ALL' && (
              <button 
                onClick={() => setFilterLevel('ALL')}
                className="bg-white border border-outline-variant hover:border-primary text-xs px-2.5 py-1 rounded flex items-center gap-1.5 transition-colors font-semibold"
              >
                <span>Riesgo: {filterLevel}</span>
                <span className="text-red-500 font-bold">×</span>
              </button>
            )}

            <div className="relative max-w-xs ml-2">
              <Search className="w-3.5 h-3.5 text-outline absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input 
                type="text"
                placeholder="Buscar por ID, importador..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="pl-8 pr-3 py-1 bg-white border border-outline-variant rounded text-xs outline-none focus:border-primary w-52"
              />
            </div>
          </div>

          <div className="flex items-center gap-4 text-xs font-semibold text-on-surface-variant">
            <span>Mostrando {filteredRecords.length} de {totalRecords} Registros</span>
            <div className="flex items-center gap-1 bg-white border border-outline-variant rounded p-1">
              <ChevronLeft className="w-4 h-4 cursor-pointer hover:text-primary transition-colors" />
              <ChevronRight className="w-4 h-4 cursor-pointer hover:text-primary transition-colors" />
            </div>
          </div>
        </div>

        {/* Dynamic Table scrollable data list */}
        <div className="overflow-x-auto custom-scrollbar">
          <table className="w-full text-left border-collapse min-w-[900px]">
            <thead>
              <tr className="bg-surface-container-high/80 font-table-header text-table-header text-on-surface-variant border-b border-outline-variant outline-none">
                <th className="px-6 py-3 uppercase text-xs font-semibold">ID Guía</th>
                <th className="px-6 py-3 uppercase text-xs font-semibold">Nombre del Importador</th>
                <th className="px-6 py-3 uppercase text-xs font-semibold text-center">Fracción HTS</th>
                <th className="px-6 py-3 uppercase text-xs font-semibold">Descripción</th>
                <th className="px-6 py-3 uppercase text-xs font-semibold text-right">Valor Declarado (USD)</th>
                <th className="px-6 py-3 uppercase text-xs font-semibold text-center">Nivel de Riesgo</th>
                <th className="px-6 py-3 uppercase text-xs font-semibold text-center">Auditoría</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant text-[13px] font-medium font-sans">
              {filteredRecords.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-6 py-8 text-center text-on-surface-variant">
                    No se encontraron registros de dockets de guías correspondientes a los criterios del filtro.
                  </td>
                </tr>
              ) : (
                filteredRecords.map((record) => {
                  const isSelected = selectedRecordId === record.id;
                  return (
                    <tr 
                      key={record.id} 
                      onClick={() => setSelectedRecordId(isSelected ? null : record.id)}
                      className={`cursor-pointer transition-colors ${
                        record.riskLevel === 'CRITICAL' || record.riskLevel === 'PROHIBITED' 
                          ? 'bg-red-50/10 hover:bg-red-50/40' 
                          : record.riskLevel === 'WARNING' 
                          ? 'bg-amber-50/10 hover:bg-amber-50/30' 
                          : 'hover:bg-surface-container-low'
                      } ${isSelected ? 'bg-primary-container/10 border-l-4 border-l-primary' : ''}`}
                    >
                      <td className="px-6 py-4 font-mono font-bold text-primary">{record.guideId}</td>
                      <td className="px-6 py-4">{record.importerName}</td>
                      <td className="px-6 py-4 text-center font-mono text-xs text-secondary">{record.htsCode}</td>
                      <td className="px-6 py-4 max-w-xs truncate text-on-surface-variant">{record.description}</td>
                      <td className="px-6 py-4 font-mono text-right">${record.declaredValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                      <td className="px-6 py-4 text-center">
                        <span className={`px-2.5 py-0.5 rounded-full text-[9px] font-extrabold uppercase tracking-widest ${
                          record.riskLevel === 'CRITICAL' 
                            ? 'bg-error text-white' 
                            : record.riskLevel === 'PROHIBITED' 
                            ? 'bg-error text-white ring-1 ring-error-container' 
                            : record.riskLevel === 'WARNING' 
                            ? 'bg-amber-100 text-amber-800' 
                            : 'bg-emerald-100 text-emerald-800'
                        }`}>
                          {record.riskLevel}
                        </span>
                      </td>
                      <td className="px-6 py-4 text-center">
                        <div className="flex items-center justify-center gap-1.5 text-xs font-semibold">
                          {isSelected ? (
                            <span className="text-primary font-bold hover:underline flex items-center gap-0.5">
                              <LockOpen className="w-3.5 h-3.5" />
                              <span>Auditado</span>
                            </span>
                          ) : (
                            <span className="text-secondary hover:text-primary flex items-center gap-0.5">
                              <Lock className="w-3.5 h-3.5" />
                              <span>Inspeccionar</span>
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Selected Row audit details drawer block */}
      {selectedRecordId && (
        <div className="bg-primary-container text-white p-5 rounded-xl border border-outline-variant animate-in slide-in-from-bottom duration-200">
          {(() => {
            const item = records.find(r => r.id === selectedRecordId);
            if (!item) return null;
            return (
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="space-y-1">
                  <span className="text-[10px] uppercase font-bold text-on-primary-container tracking-wider">
                    Inspeccionar Guía: {item.guideId}
                  </span>
                  <h4 className="text-md font-bold text-white">{item.importerName}</h4>
                  <p className="text-xs text-on-primary-container max-w-xl">
                    <span className="font-bold">Fracción HTS:</span> {item.htsCode} | <span className="font-bold">Descripción Real:</span> {item.description}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono font-bold">
                    Decl: ${item.declaredValue.toLocaleString()} USD
                  </span>
                  <button 
                    onClick={() => {
                      alert(`Certificando guía ${item.guideId}. Registrando firma inalterable en cadena de custodia.`);
                      setSelectedRecordId(null);
                    }}
                    className="bg-white hover:bg-emerald-50 text-primary hover:text-emerald-800 px-4 py-2 font-bold text-xs rounded transition-all"
                  >
                    Marcar como Validado
                  </button>
                </div>
              </div>
            );
          })()}
        </div>
      )}

      {/* Calculations & Summary interactive widget panel */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        
        {/* Projections block */}
        <div className="lg:col-span-4 bg-white border border-outline-variant p-6 rounded-xl shadow-sm">
          <h5 className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest mb-4">
            PROYECCIÓN DE CONTRIBUCIONES
          </h5>
          <div className="space-y-4">
            <div className="flex justify-between items-center pb-2 border-b border-outline-variant/60">
              <span className="text-xs font-semibold text-primary">Tasa Global 33.5%</span>
              <span className="font-mono text-error font-bold text-xs">$1,240,432.50 MXN</span>
            </div>
            
            <div className="flex justify-between items-center pb-2 border-b border-outline-variant/60">
              <span className="text-xs font-semibold text-primary">Beneficio T-MEC</span>
              <span className="font-mono text-emerald-600 font-bold text-xs">$842,100.00 MXN</span>
            </div>

            <div className="flex justify-between items-center bg-surface-container-low p-4 rounded mt-4 border border-outline-variant/20">
              <span className="text-xs font-bold text-primary">Ahorro Total</span>
              <span className="text-md font-black text-emerald-600">-$398,332.50 MXN</span>
            </div>
          </div>
        </div>

        {/* Preview of SAT Pedimentos draft */}
        <div className="lg:col-span-8 bg-white border border-outline-variant p-6 rounded-xl flex flex-col md:flex-row items-center justify-between gap-6 relative overflow-hidden shadow-sm">
          <div className="z-10 w-full md:w-3/5 space-y-4">
            <h5 className="text-lg font-bold text-primary">Vista Previa de Cumplimiento de Auditoría</h5>
            <p className="text-xs text-on-surface-variant leading-relaxed font-sans">
              Verifique estos registros antes de generar el pedimento final del SAT. Los artículos de alto riesgo requieren inspección física (Previo) para evitar sanciones de la ANAM en las aduanas mexicanas.
            </p>
            
            <div className="flex flex-wrap gap-3 pt-2">
              <button 
                onClick={onCertifyPedimento}
                className="bg-[#0c2f1f]/10 text-primary border border-primary/20 hover:bg-[#0c2f1f]/20 px-4 py-2.5 rounded font-bold text-xs flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer font-sans"
              >
                <FileText className="w-4 h-4" />
                <span>Ver Borrador de Pedimento</span>
              </button>

              <button 
                onClick={() => onGeneratePedimento('MAWB-7729104-MX', agenteAduanal, numeroPedimento)}
                className="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2.5 rounded font-bold text-xs flex items-center gap-1.5 transition-all active:scale-95 cursor-pointer shadow-sm shadow-emerald-600/20 font-sans"
              >
                <Sparkles className="w-4 h-4 text-emerald-300" />
                <span>Generar Pedimento T1</span>
              </button>
              
              <button 
                onClick={() => {
                  alert('Consultando base de datos aduaneras de la autoridad (SAT) para refresh del dintel...');
                }}
                className="bg-white hover:bg-surface-container border border-outline-variant px-4 py-2.5 rounded font-bold text-xs flex items-center gap-1.5 transition-all text-primary font-sans"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Reanalizar Datos</span>
              </button>
            </div>
          </div>

          {/* Dynamic input capture card inside RiskAnalysisView */}
          <div className="w-full md:w-2/5 bg-slate-50 border border-outline-variant/60 p-4 rounded-lg space-y-3 shrink-0 font-sans z-10 shadow-3xs">
            <span className="text-[10px] uppercase font-mono font-black text-emerald-700 tracking-wider flex items-center gap-1 select-none">
              <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full animate-ping" />
              <span>Captura de Despacho SAT/ANAM</span>
            </span>
            <div className="space-y-2">
              <div className="space-y-0.5">
                <label className="text-[9px] font-bold text-on-surface-variant block uppercase">Agente Aduanal / Patente</label>
                <input 
                  type="text" 
                  value={agenteAduanal}
                  onChange={e => onChangeAgenteAduanal(e.target.value)}
                  className="w-full p-1.5 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-bold text-primary"
                  placeholder="e.g. 3920 - Mario Sanchez"
                />
              </div>
              <div className="space-y-0.5">
                <label className="text-[9px] font-bold text-on-surface-variant block uppercase">Número de Pedimento</label>
                <input 
                  type="text" 
                  value={numeroPedimento}
                  onChange={e => onChangeNumeroPedimento(e.target.value)}
                  className="w-full p-1.5 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-mono font-bold text-primary"
                  placeholder="e.g. 24 12 3004 0001854"
                />
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* PDF / Report de Análisis de Riesgo Modal */}
      {showPDFModal && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <style>{`
            @media print {
              body * {
                visibility: hidden !important;
              }
              #printable-pdf-area, #printable-pdf-area * {
                visibility: visible !important;
              }
              #printable-pdf-area {
                position: absolute !important;
                left: 0 !important;
                top: 0 !important;
                width: 100% !important;
                max-width: 100% !important;
                margin: 0 !important;
                padding: 15mm !important;
                box-shadow: none !important;
                background: white !important;
                color: #000 !important;
              }
              .no-print {
                display: none !important;
              }
            }
          `}</style>
          
          <div className="bg-slate-900/30 w-full max-w-4xl rounded-2xl border border-outline-variant shadow-2xl flex flex-col overflow-hidden h-[90vh] bg-surface-container-lowest animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Controls Header Bar */}
            <div className="no-print p-4 border-b border-outline-variant bg-surface-container-low flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                <div className="w-2.5 h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                <span className="text-xs font-bold font-sans text-primary">Previsualizador de Reporte Oficial (PDF)</span>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  type="button"
                  onClick={() => window.print()}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-3.5 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 active:scale-95 transition-all cursor-pointer font-sans"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Imprimir / Guardar PDF</span>
                </button>
                <button 
                  type="button"
                  onClick={() => setShowPDFModal(false)}
                  className="text-outline hover:text-primary p-1.5 hover:bg-surface-container rounded-full transition-colors cursor-pointer"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>
            </div>

            {/* Simulated Paper Area */}
            <div className="flex-1 overflow-y-auto p-8 justify-center bg-surface-container-low flex custom-scrollbar">
              <div 
                id="printable-pdf-area"
                className="bg-white border border-outline-variant/60 w-full max-w-[210mm] min-h-[297mm] p-12 text-slate-800 shadow-lg flex flex-col justify-between font-sans relative"
              >
                {/* Government Aesthetic Banner Top */}
                <div className="absolute top-0 left-0 right-0 h-2 bg-gradient-to-r from-[#0C2314] via-[#A88C52] to-[#0C2314]" />

                <div>
                  {/* Executive Header Section */}
                  <div className="flex justify-between items-start pb-6 border-b-2 border-[#0C2314] mb-8">
                    <div className="space-y-1">
                      <div className="flex items-center gap-1.5">
                        <span className="inline-block w-4 h-4 rounded-sm bg-gradient-to-br from-[#0C2314] to-[#A88C52]" />
                        <h2 className="text-md font-black tracking-widest text-[#0C2314] uppercase">ANAM - SAT</h2>
                      </div>
                      <h1 className="text-lg font-black font-serif text-[#0C2314]">SGA Customs Compliance</h1>
                      <span className="text-[9px] font-bold text-[#A88C52] uppercase tracking-wider block font-sans">
                        Sistema de Gestión Aduanera • Diagnóstico Técnico Técnico
                      </span>
                    </div>

                    <div className="text-right font-mono text-[10px] leading-relaxed text-slate-600">
                      <div><strong className="text-slate-800">DOCUMENTO:</strong> CERT-ANAM-2024-819</div>
                      <div><strong className="text-slate-800">FECHA EMISIÓN:</strong> {new Date().toLocaleDateString('es-MX', { year: 'numeric', month: '2-digit', day: '2-digit' })}</div>
                      <div><strong className="text-slate-800">HORA SERVIDOR:</strong> {new Date().toLocaleTimeString('es-MX')} CST</div>
                      <div><strong className="text-slate-800">AUDITOR:</strong> fer@humansoftware.mx</div>
                    </div>
                  </div>

                  {/* Document Subject Title block */}
                  <div className="text-center mb-8 bg-slate-50 border border-slate-100 p-4 rounded-xl">
                    <h3 className="text-md font-black text-slate-900 uppercase tracking-wide">
                      REPORTE DE RESULTADOS DE ANÁLISIS DE RIESGO ADUANERO
                    </h3>
                    <p className="text-[11px] text-slate-500 font-medium mt-1 leading-normal max-w-xl mx-auto">
                      Dictamen técnico de compliance sobre el manifiesto consolidado con fines de pre-vuelo y verificación arancelaria obligatoria del Servicio de Administración Tributaria.
                    </p>
                  </div>

                  {/* Summary Core Block */}
                  <div className="grid grid-cols-4 gap-4 mb-8">
                    <div className="border border-slate-200 rounded-lg p-3 text-center bg-slate-50">
                      <span className="text-[9px] font-bold text-slate-500 uppercase block tracking-wider">Total Guías</span>
                      <p className="text-xl font-black text-slate-800 mt-1">{records.length}</p>
                    </div>
                    <div className="border border-emerald-200 rounded-lg p-3 text-center bg-emerald-50/30">
                      <span className="text-[9px] font-bold text-emerald-700 uppercase block tracking-wider">Aprobados</span>
                      <p className="text-xl font-black text-emerald-600 mt-1">
                        {records.filter(r => r.riskLevel === 'CLEARED').length}
                      </p>
                    </div>
                    <div className="border border-amber-200 rounded-lg p-3 text-center bg-amber-50/30">
                      <span className="text-[9px] font-bold text-amber-700 uppercase block tracking-wider">Alertas</span>
                      <p className="text-xl font-black text-amber-600 mt-1">
                        {records.filter(r => r.riskLevel === 'WARNING').length}
                      </p>
                    </div>
                    <div className="border border-red-200 rounded-lg p-3 text-center bg-red-50/30">
                      <span className="text-[9px] font-bold text-red-700 uppercase block tracking-wider">Previo Físico</span>
                      <p className="text-xl font-black text-red-600 mt-1">
                        {records.filter(r => r.riskLevel === 'CRITICAL' || r.riskLevel === 'PROHIBITED').length}
                      </p>
                    </div>
                  </div>

                  {/* Dispatcher Stamp Section */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8 text-[11px] font-mono p-4 border border-slate-100 rounded-lg bg-slate-50/50">
                    <div>
                      <strong className="text-slate-800 font-sans block text-[10px] uppercase font-bold text-slate-500 mb-1">DATOS DE DECLARACIÓN</strong>
                      <div><span className="font-bold">AGENTE ADUANAL:</span> {agenteAduanal || "3920 - Mario Sanchez"}</div>
                      <div><span className="font-bold">PATENTE REGISTRO:</span> {agenteAduanal.split('-')[0].trim() || '3920'}</div>
                      <div><span className="font-bold">NÚMERO PEDIMENTO:</span> {numeroPedimento || "24 12 3004 0001854"}</div>
                    </div>
                    <div>
                      <strong className="text-slate-800 font-sans block text-[10px] uppercase font-bold text-slate-500 mb-1">REFERENCIA ADUANERA</strong>
                      <div><span className="font-bold">MANIFIESTO MAWB:</span> MAWB-7729104-MX</div>
                      <div><span className="font-bold">RÉGIMEN ASOCIADO:</span> IMD (IMPORTACION DEFINITIVA)</div>
                      <div><span className="font-bold">ADUANA SECCIÓN:</span> MEX (47-0) AICM</div>
                    </div>
                  </div>

                  {/* Detail Table */}
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <table className="w-full text-left text-xs border-collapse font-sans">
                      <thead>
                        <tr className="bg-slate-100 font-bold border-b border-slate-200 text-slate-700">
                          <th className="p-3 text-[10px] uppercase">ID Guía</th>
                          <th className="p-3 text-[10px] uppercase">Importador</th>
                          <th className="p-3 text-[10px] uppercase text-center">Código HTS</th>
                          <th className="p-3 text-[10px] uppercase">Descripción</th>
                          <th className="p-3 text-[10px] uppercase text-right">Valor USD</th>
                          <th className="p-3 text-[10px] uppercase text-center">Riesgo</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 font-mono text-[10px] text-slate-600">
                        {records.map((item) => {
                          return (
                            <tr key={item.id} className="hover:bg-slate-50/50">
                              <td className="p-2.5 font-bold text-[#0C2314]">{item.guideId}</td>
                              <td className="p-2.5 font-sans truncate max-w-[120px]">{item.importerName}</td>
                              <td className="p-2.5 text-center font-bold text-slate-700">{item.htsCode}</td>
                              <td className="p-2.5 font-sans truncate max-w-[150px]">{item.description}</td>
                              <td className="p-2.5 text-right font-bold text-slate-900">${item.declaredValue.toLocaleString('en-US', { minimumFractionDigits: 2 })}</td>
                              <td className="p-2.5 text-center">
                                <span className={`px-2 py-0.5 rounded text-[8px] font-black uppercase ${
                                  item.riskLevel === 'CRITICAL' || item.riskLevel === 'PROHIBITED'
                                    ? 'bg-red-100 text-red-800'
                                    : item.riskLevel === 'WARNING'
                                    ? 'bg-amber-100 text-amber-800'
                                    : 'bg-emerald-100 text-emerald-800'
                                }`}>
                                  {item.riskLevel}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* Digital Stamps bottom footer signature areas */}
                <div className="mt-12 space-y-4 pt-6 border-t border-slate-200">
                  <div className="grid grid-cols-3 gap-6 text-[9px] font-mono leading-relaxed text-slate-500">
                    <div className="col-span-2 space-y-1">
                      <div><strong>CADENA ORIGINAL GLOBAL S.G.A. CUMPLIMIENTO:</strong></div>
                      <div className="bg-slate-50 p-2 border border-slate-100 rounded break-all select-all">
                        ||SGA_ANAM_VERIFIER_ENGINE|MAWB-7729104-MX|2024-05|{numeroPedimento}||MARIO_SANCHEZ_3920|RFC_LOG880124MX1|{records.length}_RECORDS|MD5_HASH:6ea02e86fa3a9101ae8fc8ee2e8f01b10a2f||
                      </div>
                    </div>
                    <div className="col-span-1 space-y-1 text-center flex flex-col justify-end">
                      <div className="font-bold text-slate-700 uppercase text-[9px]">Sello de Certificación Digital</div>
                      <div className="border border-slate-200 rounded p-1 mx-auto w-24 h-24 bg-white flex flex-col gap-0.5 justify-center items-center">
                        <div className="flex gap-0.5">
                          <span className="w-2 h-2 bg-slate-900" /><span className="w-5 h-2 bg-slate-300" /><span className="w-2 h-2 bg-slate-900" />
                        </div>
                        <div className="flex gap-0.5">
                          <span className="w-1 h-4 bg-slate-500" /><span className="w-6.5 h-4 bg-slate-900" /><span className="w-1 h-4 bg-slate-400" />
                        </div>
                        <div className="flex gap-0.5">
                          <span className="w-3 h-3 bg-slate-900" /><span className="w-2 h-3 bg-slate-200" /><span className="w-3 h-3 bg-slate-900" />
                        </div>
                        <div className="text-[7px] text-slate-400 font-mono select-none mt-1">SGA COMPLIANCE</div>
                      </div>
                    </div>
                  </div>

                  <div className="flex justify-between items-center text-[8px] text-slate-400 border-t border-slate-100 pt-2 font-mono">
                    <span>AGENCIA NACIONAL DE ADUANAS DE MÉXICO - DECLARACIÓN PREVENTIVA DE CUMPLIMIENTO</span>
                    <span>Documento Oficial Certificado • Página 1 de 1</span>
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
