/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useEffect } from 'react';
import { 
  FileText, 
  Download, 
  ShieldCheck, 
  CheckCircle, 
  CheckCircle2,
  Clock, 
  HelpCircle, 
  ChevronRight, 
  FilePlus, 
  Archive, 
  Award,
  BookOpen, 
  FileSignature, 
  Activity, 
  User, 
  Computer, 
  Eye, 
  Search,
  Bell,
  X,
  Plus,
  Printer
} from 'lucide-react';
import { DocumentItem, AuditTrailEvent, GuideRecord } from '../types';

interface ExpedientesViewProps {
  initialDocs: DocumentItem[];
  initialEvents: AuditTrailEvent[];
  agenteAduanal: string;
  numeroPedimento: string;
  initialRecords?: GuideRecord[];
}

export default function ExpedientesView({ 
  initialDocs, 
  initialEvents,
  agenteAduanal,
  numeroPedimento,
  initialRecords = []
}: ExpedientesViewProps) {
  const [docs, setDocs] = useState<DocumentItem[]>(initialDocs);
  const [events, setEvents] = useState<AuditTrailEvent[]>(initialEvents);
  const [records, setRecords] = useState<GuideRecord[]>(initialRecords);

  useEffect(() => {
    setDocs(initialDocs);
  }, [initialDocs]);

  useEffect(() => {
    setEvents(initialEvents);
  }, [initialEvents]);

  useEffect(() => {
    setRecords(initialRecords);
  }, [initialRecords]);
  
  const [isSigning, setIsSigning] = useState(false);
  const [signingSuccess, setSigningSuccess] = useState(false);
  const [pedimentoStatus, setPedimentoStatus] = useState<'DESADUANADO' | 'CERTIFICADO'>('DESADUANADO');
  
  // Document inspector state
  const [selectedDoc, setSelectedDoc] = useState<DocumentItem | null>(null);
  const [showPDFViewer, setShowPDFViewer] = useState(false);

  // Download logic for official Mexican Customs layouts (SAAI M3)
  const handleDownloadLayoutM3 = () => {
    const patent = agenteAduanal.split('-')[0].trim() || '3920';
    const pedNumClean = numeroPedimento.replace(/\s/g, '');
    const clientRFC = "LOG880124MX1";
    const dateFormatted = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    
    let content = `* =========================================================================\n`;
    content += `* SISTEMA GLOBAL DE ADUANAS (SGA) - GENERADOR DE LAYOUT PEDIMENTO SAAI M3\n`;
    content += `* PATENTE: ${patent} | PEDIMENTO: ${pedNumClean} | FECHA: ${new Date().toLocaleDateString()}\n`;
    content += `* REGIMEN: IMD (IMPORTACION DEBITO/DEFINITIVO)\n`;
    content += `* =========================================================================\n\n`;
    
    // Reg 500: General Pedimento data
    content += `500|${patent}|${pedNumClean}|IM|9|IMD|${clientRFC}|${dateFormatted}|MX|USA|1|\n`;
    
    // Reg 501: Pedimento Entries mapped directly from guide records
    records.forEach((record, index) => {
      const idxStr = String(index + 1).padStart(3, '0');
      const cleanHts = record.htsCode.replace(/\./g, '');
      const declaredVal = record.declaredValue;
      content += `501|${cleanHts}|${idxStr}|${clientRFC}|${declaredVal}|USD|USA|MX|${record.guideId}|\n`;
    });
    
    // Reg 551: Customs Taxes & Duty rates
    content += `551|01|IVA|21|16581|1|\n`;
    content += `551|08|DTA|21|847|1|\n`;
    content += `551|09|PRV|21|240|1|\n`;
    
    // Reg 800: Cryptographic advanced signatures
    content += `800|FirmaElectronicaSGASha256|e.firma:45fa88b901a1c97bd823901a97ce902b33cbde7baf88da72ef91001a4e21a4f0|${patent}|${pedNumClean}|\n`;
    
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `M3_LAYOUT_${patent}_${pedNumClean}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    // Dynamic audit entry
    const newEvent: AuditTrailEvent = {
      id: `at_${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      title: 'Layout Pedimento M3 Descargado',
      actor: 'USER',
      description: `Se exportó el layout SAAI M3 del pedimento ${numeroPedimento} para validación ante el SAT. Descarga exitosa.`,
      ip: '201.144.112.5',
      file: `M3_LAYOUT_${patent}_${pedNumClean}.txt`
    };
    setEvents(prev => [newEvent, ...prev]);
  };

  // Download logic for the complete guide records registry layout
  const handleDownloadRegistroCompleto = () => {
    const pedNumClean = numeroPedimento.replace(/\s/g, '');
    
    let csvContent = `PORTAL DE ADUANAS SGA - REPORTE DE REGISTRO COMPLETO DE EXPEDIENTE\n`;
    csvContent += `PATENTE COBRADOR,${agenteAduanal}\n`;
    csvContent += `NUMERO PEDIMENTO FISCAL,${numeroPedimento}\n`;
    csvContent += `REGIMEN COMPLIANCE,DEFINITIVO DE IMPORTACION (IMD)\n`;
    csvContent += `FECHA DE REPORTE,${new Date().toISOString()}\n`;
    csvContent += `ESTADO ADUANAL,${pedimentoStatus}\n\n`;
    
    // Table Headers
    const headers = [
      "ID Guia (Guide ID)", 
      "Importador (Exporter Name)", 
      "Fraccion Arancelaria (HTS Code)", 
      "Descripcion Mercancia (Description)", 
      "Valor Declarado USD (Declared Value USD)", 
      "Nivel de Riesgo (Risk Level)", 
      "Estatus de Auditoria (Compliance Status)"
    ];
    
    csvContent += headers.join(",") + "\n";
    
    // Table Rows list
    records.forEach(record => {
      const row = [
        `"${record.guideId}"`,
        `"${record.importerName.replace(/"/g, '""')}"`,
        `"${record.htsCode}"`,
        `"${record.description.replace(/"/g, '""')}"`,
        record.declaredValue.toString(),
        `"${record.riskLevel}"`,
        `"VERIFICADO CORRECTO"`
      ];
      csvContent += row.join(",") + "\n";
    });
    
    const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `REGISTRO_COMPLETO_PED_${pedNumClean}.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    // Dynamic audit logs update
    const newEvent: AuditTrailEvent = {
      id: `at_${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      title: 'Registro Completo Exportado',
      actor: 'USER',
      description: `Se exportó el registro completo de dockets y guias consolidadas bajo el pedimento ${numeroPedimento} en formato de cálculo CSV.`,
      ip: '201.144.112.5',
      file: `REGISTRO_COMPLETO_PED_${pedNumClean}.csv`
    };
    setEvents(prev => [newEvent, ...prev]);
  };

  // Real File Downloads implementation
  const handleDownloadDoc = (doc: DocumentItem) => {
    // Intercept layouts and general reports to serve the authentic structured plain text layouts
    if (doc.type === 'REPORT' || doc.name.toLowerCase().includes('reporte general') || doc.name.toLowerCase().includes('layout')) {
      handleDownloadLayoutM3();
      return;
    }

    const fileContent = `DOCUMENTO FISCAL COMPLIANCE S.A. DE C.V.\n=========================================\n\nSGA Customs Portal Document Seal & Certificate\n\nNombre: ${doc.name}\nCódigo de Registro: ${doc.uuidOrMeta}\nTipo: ${doc.type}\nFecha: ${doc.generatedDate || '2024-10-24'}\n\nEste archivo representa un documento fiscal digital certificado ante la autoridad tributaria mexicana (ANAM / SAT) bajo firma SHA256 inalterable.\n\nCódigo de Verificación: ${Math.floor(1000000 + Math.random() * 9000000)}`;
    const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${doc.name.replace(/[^a-z0-9]/gi, '_').toLowerCase()}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownloadZip = () => {
    const fileContent = `SGA PORTAL DE ADUANAS - EXPEDIENTE DIGITAL BUNDLE\n======================================================\n\nPaquete Consolidado del Pedimento: ${numeroPedimento}\nAgente Aduanal Proponente: ${agenteAduanal}\nFecha de Empaque: ${new Date().toLocaleDateString()}\nStatus: ${pedimentoStatus}\n\nArchivos Incluidos:\n` + docs.map((doc, idx) => `${idx + 1}. ${doc.name} (${doc.uuidOrMeta})`).join('\n') + `\n\n======================================================\nFin del paquete. SGA Sello Digital Certificado.`;
    const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Expediente_Completo_T1_2024_MX_84722.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleDownloadAuditLogCSV = () => {
    const headers = ["Timestamp", "Incidente / Accion", "Actor", "Detalle de Evento", "Direccion IP", "Sesion / Referencia"];
    const rows = events.map(ev => [
      `"${ev.timestamp}"`,
      `"${ev.title.replace(/"/g, '""')}"`,
      `"${ev.actor}"`,
      `"${ev.description.replace(/"/g, '""')}"`,
      `"${ev.ip}"`,
      `"${(ev.session || ev.file || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
    const blob = new Blob(["\ufeff" + csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `Trazabilidad_AuditTrail_RNF09.csv`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  // Trigger simulated cryptographic certification
  const runCertificationProcess = () => {
    setIsSigning(true);
    setTimeout(() => {
      setIsSigning(false);
      setSigningSuccess(true);
      setPedimentoStatus('CERTIFICADO');
      
      // Append a new event to the audit timeline trail!
      const newEvent: AuditTrailEvent = {
        id: `at_${Date.now()}`,
        timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
        title: 'Expediente Sign: CERTIFICADO',
        actor: 'AUDITOR',
        description: 'SGA Cryptographic sha256 stamp validated against SAT signature server.',
        ip: '192.168.10.45',
        session: 'STAMP_A72B_MX'
      };
      
      setEvents(prev => [newEvent, ...prev]);

      // Hide celebrating success feedback auto-timer
      setTimeout(() => {
        setSigningSuccess(false);
      }, 4000);

    }, 1800);
  };

  // Simulated addition of a new document upload (e.g. TMEC certificate)
  const simulateAddDocument = () => {
    const docId = docs.length + 1;
    const newDoc: DocumentItem = {
      id: docId,
      name: `${docId}. Certificado de Origen T-MEC`,
      uuidOrMeta: 'Compliance Score: 100% Fully Compliant',
      type: 'REPORT',
      generatedDate: new Date().toISOString().split('T')[0]
    };

    setDocs(prev => [...prev, newDoc]);

    const auditEvent: AuditTrailEvent = {
      id: `at_${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      title: 'Document Upload: Certificado T-MEC',
      actor: 'USER',
      description: 'Uploaded by A. Martinez. Automatic rule cross-verification passed against treaty standards.',
      ip: '201.144.112.5',
      file: 'TMEC_CERT_SIGNED.pdf'
    };

    setEvents(prev => [auditEvent, ...prev]);
  };

  return (
    <div className="space-y-6">
      
      {/* Title block with actions */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <nav className="flex items-center gap-1.5 text-[10px] text-on-surface-variant font-bold uppercase tracking-widest mb-1.5">
            <span>EXPEDIENTES</span>
            <ChevronRight className="w-3 h-3 text-outline" />
            <span className="text-primary font-bold">T1-2024-MX-84722</span>
          </nav>
          <h1 className="text-3xl font-black text-primary tracking-tight">Expediente T1</h1>
          <p className="text-xs text-on-surface-variant flex items-center gap-2 mt-1 font-medium font-sans">
            Pedimento: <span className="font-mono bg-surface-container-high px-2 py-0.5 rounded text-[11px] border border-outline-variant">{numeroPedimento}</span>
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <div className="flex items-center gap-1.5 bg-emerald-50 text-emerald-800 px-4 py-2 rounded-lg border border-emerald-100 shadow-sm font-semibold text-xs">
            <CheckCircle className="w-4 h-4 fill-emerald-100 text-emerald-600" />
            <span>{pedimentoStatus}</span>
          </div>

          <button 
            onClick={handleDownloadZip}
            className="flex items-center gap-1.5 bg-white border border-outline hover:border-primary px-4 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 text-primary"
          >
            <Download className="w-4 h-4" />
            <span>Expediente Completo (ZIP)</span>
          </button>

          <button 
            disabled={isSigning}
            onClick={runCertificationProcess}
            className="flex items-center gap-1.5 bg-primary text-on-primary hover:opacity-95 disabled:opacity-50 px-4 py-2 rounded-lg text-xs font-bold transition-all active:scale-95 cursor-pointer"
          >
            {isSigning ? (
              <>
                <LoaderIcon className="w-4 h-4 animate-spin" />
                <span>Firmando SHA256...</span>
              </>
            ) : (
              <>
                <FileSignature className="w-4 h-4" />
                <span>Certificar Documentos</span>
              </>
            )}
          </button>
        </div>
      </div>

      {/* Signing Successful alert banner popup */}
      {signingSuccess && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 text-emerald-900 rounded-xl flex items-center gap-3 animate-in fade-in duration-300">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <div className="text-xs">
            <p className="font-bold">Sello de Seguridad Adherido</p>
            <p className="opacity-90">El sello de firma criptográfica ha sido certificado exitosamente en la blockchain del SAT. El estatus del pedimento ha sido actualizado a alta seguridad.</p>
          </div>
        </div>
      )}

      {/* Main Grid: Left Documents Layout vs Right Timeline */}
      <div className="grid grid-cols-12 gap-6">
        
        {/* Left section: Doc list & Auditor stats */}
        <div className="col-span-12 lg:col-span-7 space-y-6">

          {/* Official Layout Reports and Logs Section */}
          <section className="bg-gradient-to-br from-[#06281a] to-[#0d3f2a] border border-emerald-900 p-5 rounded-xl shadow-lg space-y-4 text-white">
            <div className="flex flex-col sm:flex-row sm:items-start justify-between border-b border-emerald-800/60 pb-3 gap-2">
              <div>
                <h2 className="text-sm font-extrabold flex items-center gap-2 text-emerald-400 font-sans tracking-tight">
                  <ShieldCheck className="w-5 h-5 text-emerald-400" />
                  <span>Reportes de Despacho y Layout SAAI M3 (Oficial)</span>
                </h2>
                <p className="text-[11px] text-white/80 mt-1 font-sans">
                  Genere y exporte los dockets y formatos requeridos para validación aduanera del SAT mexicano.
                </p>
              </div>
              <span className="bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 font-mono text-[9px] font-bold tracking-widest px-2 py-0.5 rounded uppercase self-start sm:self-auto select-none">
                Autorizado SAT
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {/* Report Button A */}
              <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3.5 flex flex-col justify-between gap-3 hover:bg-white/[0.06] hover:border-emerald-700/60 transition-all duration-300">
                <div className="space-y-1">
                  <span className="text-[9px] uppercase font-bold text-emerald-400 block tracking-wider">LAYOUT EN TEXTO PLANO</span>
                  <h3 className="text-xs font-extrabold text-white leading-snug">Reporte General de Layout M3</h3>
                  <p className="text-[10px] text-white/70 leading-normal">
                    Archivo de texto de tuberías (|) del validador de aduanas que mapea el Pedimento {numeroPedimento} con sus partidas de dockets correspondientes.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadLayoutM3}
                  className="w-full py-2 bg-emerald-500 hover:bg-emerald-400 active:scale-98 text-bg-primary-container text-xs font-black rounded-lg transition-all flex items-center justify-center gap-1.5 shadow-sm text-[#0c2f1f]"
                >
                  <Download className="w-3.5 h-3.5 font-bold" />
                  <span>Descargar Layout M3</span>
                </button>
              </div>

              {/* Report Button B */}
              <div className="bg-white/[0.03] border border-white/10 rounded-lg p-3.5 flex flex-col justify-between gap-3 hover:bg-white/[0.06] hover:border-emerald-700/60 transition-all duration-300">
                <div className="space-y-1">
                  <span className="text-[9px] uppercase font-bold text-emerald-400 block tracking-wider">LOG COMPLETO DE MANIFIESTO</span>
                  <h3 className="text-xs font-extrabold text-white leading-snug">Registro Completo de Operación</h3>
                  <p className="text-[10px] text-white/70 leading-normal">
                    Reporte CSV estructurado con la totalidad de registros calificados v.s. estatus de riesgo, valores, pesos y fracciones HTS aprobadas.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleDownloadRegistroCompleto}
                  className="w-full py-2 bg-white text-emerald-950 hover:bg-white/90 active:scale-98 text-xs font-extrabold rounded-lg transition-all flex items-center justify-center gap-1.5 shadow-sm"
                >
                  <Download className="w-3.5 h-3.5" />
                  <span>Descargar Registro Completo</span>
                </button>
              </div>
            </div>
          </section>
          
          {/* Doc Repository block */}
          <section className="bg-white border border-outline-variant p-5 rounded-xl shadow-sm">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-lg font-bold text-primary flex items-center gap-2">
                <Archive className="w-5 h-5 text-primary" />
                <span>Repositorio Documental</span>
              </h2>
              
              <button 
                onClick={simulateAddDocument}
                className="text-[11px] font-bold text-primary hover:underline flex items-center gap-1 px-2.5 py-1.5 rounded bg-surface-container hover:bg-surface-container-high transition-colors text-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Agregar Documento</span>
              </button>
            </div>

            {/* Document list cards */}
            <div className="space-y-2">
              {docs.map((doc) => {
                // Assign icon and custom styles depending on type
                const styleMap = {
                  MANIFESTO: { bg: 'bg-surface-container-low', text: 'text-secondary', badgeBg: 'bg-tertiary-fixed text-on-tertiary-fixed' },
                  RISK_RPT: { bg: 'bg-error-container/10 border-l-4 border-l-error px-2.5', text: 'text-error', badgeBg: 'bg-secondary-fixed text-on-secondary-fixed' },
                  PEDIMENTO: { bg: 'bg-primary-container/5', text: 'text-primary', badgeBg: 'bg-surface-container-highest text-on-secondary-container' },
                  REPORT: { bg: 'bg-surface-container-low', text: 'text-secondary', badgeBg: 'bg-outline-variant/30 text-on-surface-variant' }
                };
                const config = styleMap[doc.type] || styleMap.REPORT;

                return (
                  <div 
                    key={doc.id}
                    onClick={() => setSelectedDoc(doc)}
                    className="flex items-center justify-between p-3 border border-outline-variant rounded-lg hover:border-primary transition-all bg-white cursor-pointer group shadow-2xs"
                  >
                    <div className="flex items-center gap-4">
                      <div className={`w-10 h-10 flex items-center justify-center rounded ${config.bg}`}>
                        <FileText className={`w-5 h-5 ${config.text}`} />
                      </div>
                      <div>
                        <p className="font-bold text-primary text-sm">{doc.name}</p>
                        <p className="text-xs text-on-surface-variant font-mono">{doc.uuidOrMeta}</p>
                      </div>
                    </div>

                    <div className="flex items-center gap-3 shrink-0">
                      <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                        <button 
                          onClick={(e) => { e.stopPropagation(); setSelectedDoc(doc); }}
                          title="View" 
                          className="p-1 hover:bg-surface-container rounded"
                        >
                          <Eye className="w-3.5 h-3.5 text-secondary" />
                        </button>
                        <button 
                          onClick={(e) => { e.stopPropagation(); handleDownloadDoc(doc); }}
                          title="Download" 
                          className="p-1 hover:bg-surface-container rounded"
                        >
                          <Download className="w-3.5 h-3.5 text-secondary" />
                        </button>
                      </div>
                      <span className={`px-2 py-1 text-[10px] font-bold rounded ${config.badgeBg} uppercase tracking-wider`}>
                        {doc.type}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* Quick Authority and Auditor Statuses widgets */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            
            {/* Box A */}
            <div className="bg-surface-container-low border border-outline-variant p-5 rounded-xl shadow-2xs">
              <h3 className="text-xs font-bold text-on-surface-variant mb-2.5 flex items-center gap-1.5">
                <Eye className="w-4 h-4 text-outline" />
                <span>AUTORIDAD VIEW</span>
              </h3>
              <p className="text-xs font-bold mb-1.5">Visibilidad Habilitada</p>
              <p className="text-[11px] text-on-surface-variant mb-4 leading-relaxed">
                El canal dinámico de comunicación digital con la autoridad (ANAM) está activo en tiempo real para este expediente.
              </p>
              <button 
                onClick={() => alert('Consultando el histórico de notificaciones de interconexión con ANAM...')}
                className="w-full py-2 bg-white border border-outline hover:border-primary text-xs font-bold rounded transition-colors"
                type="button"
              >
                Ver Notificaciones
              </button>
            </div>

            {/* Box B */}
            <div className="bg-surface-container-low border border-outline-variant p-5 rounded-xl shadow-2xs">
              <h3 className="text-xs font-bold text-on-surface-variant mb-2.5 flex items-center gap-1.5">
                <Award className="w-4 h-4 text-outline" />
                <span>AUDITOR STATUS</span>
              </h3>
              <p className="text-xs font-bold mb-1.5">Internal Compliance: OK</p>
              <p className="text-[11px] text-on-surface-variant mb-4 leading-relaxed">
                Revisión e integración automática completada de manera conforme sin discrepancias en fracciones HTS o pesos brutos.
              </p>
              <button 
                onClick={() => alert('Generando informe de auditoría preventiva interna para cumplimiento COFEPRIS/ANAM...')}
                className="w-full py-2 bg-white border border-outline hover:border-primary text-xs font-bold rounded transition-colors"
                type="button"
              >
                Reporte de Auditoría
              </button>
            </div>

          </div>

        </div>

        {/* Right Section: Audit Trail Timeline (5 cols) */}
        <div className="col-span-12 lg:col-span-5">
          <section className="bg-white border border-outline-variant rounded-xl overflow-hidden flex flex-col h-full shadow-sm">
            
            {/* Card header */}
            <div className="p-4 border-b border-outline-variant bg-surface-container-low/50 flex justify-between items-center shrink-0">
              <h2 className="text-md font-bold text-primary flex items-center gap-2">
                <Activity className="w-4.5 h-4.5 text-primary" />
                <span>Registro de Auditoría (RNF-09)</span>
              </h2>
              <span className="text-secondary hover:text-primary transition-colors text-xs font-medium cursor-pointer">
                Trazabilidad
              </span>
            </div>

            {/* Timeline event items list wrap */}
            <div className="flex-1 overflow-y-auto p-5 space-y-6 custom-scrollbar max-h-[500px]">
              {events.map((ev, index) => (
                <div key={ev.id} className="relative pl-6 border-l border-outline pb-1 last:pb-0">
                  
                  {/* Bullet indicator */}
                  <div className={`absolute -left-[6px] top-1 w-3.5 h-3.5 rounded-full border-2 border-white shadow-sm ${
                    ev.actor === 'SYSTEM' 
                      ? 'bg-emerald-500 animate-pulse' 
                      : ev.actor === 'AUDITOR' 
                      ? 'bg-primary' 
                      : 'bg-primary-fixed-dim'
                  }`} />

                  {/* Stamp */}
                  <span className="text-[10px] font-mono text-on-surface-variant font-medium bg-surface-container-high px-2 py-0.5 rounded-sm inline-block mb-1.5 select-none text-secondary">
                    {ev.timestamp}
                  </span>

                  {/* Bubble body */}
                  <div className="bg-surface-container-lowest p-3 border border-outline-variant rounded shadow-3xs space-y-1 hover:border-outline transition-colors">
                    <div className="flex justify-between items-start gap-2">
                      <h4 className="text-xs font-bold text-primary leading-tight">{ev.title}</h4>
                      <span className={`text-[8px] font-black tracking-widest px-1.5 py-0.5 rounded uppercase select-none ${
                        ev.actor === 'SYSTEM' 
                          ? 'bg-primary-fixed text-on-primary-fixed' 
                          : ev.actor === 'AUDITOR' 
                          ? 'bg-secondary-container text-on-secondary-container' 
                          : 'bg-emerald-100 text-emerald-800'
                      }`}>
                        {ev.actor}
                      </span>
                    </div>

                    <p className="text-xs text-on-surface-variant leading-relaxed font-sans">{ev.description}</p>
                    
                    {/* Event metadata footer stamps */}
                    <div className="text-[9px] text-secondary font-mono pt-1 flex flex-wrap justify-between">
                      <span>IP: {ev.ip}</span>
                      {ev.agentId && <span>Agent: {ev.agentId}</span>}
                      {ev.session && <span>Session: {ev.session}</span>}
                      {ev.file && <span>File: {ev.file}</span>}
                    </div>
                  </div>

                </div>
              ))}
            </div>

            {/* View full logs export */}
            <div className="p-4 bg-surface-container border-t border-outline-variant text-center shrink-0">
              <button 
                onClick={handleDownloadAuditLogCSV}
                className="text-xs font-bold text-primary hover:underline"
              >
                Descargar Log de Auditoría (CSV/PDF)
              </button>
            </div>

          </section>
        </div>

      </div>

      {/* Selected Document Details Dialog Modal */}
      {selectedDoc && (
        <div className="fixed inset-0 z-[100] bg-primary-container/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-sm rounded-xl border border-outline-variant shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150">
            <div className="p-5 border-b border-outline-variant bg-surface-container-low flex justify-between items-start">
              <div>
                <h3 className="font-bold text-primary text-md">Inspector de Documentos</h3>
                <span className="text-[9px] font-bold px-1.5 py-0.5 bg-primary text-white rounded uppercase select-none">
                  {selectedDoc.type}
                </span>
              </div>
              <button 
                onClick={() => setSelectedDoc(null)}
                className="text-outline hover:text-primary transition-colors p-1 hover:bg-surface-container rounded"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            <div className="p-5 space-y-4">
              <div className="space-y-1">
                <span className="text-[9px] uppercase font-bold text-on-surface-variant block">Nombre de Registro</span>
                <p className="text-xs font-extrabold text-primary bg-surface-container px-3 py-2 border border-outline-variant rounded">
                  {selectedDoc.name}
                </p>
              </div>

              <div className="space-y-1">
                <span className="text-[9px] uppercase font-bold text-on-surface-variant block">Hash / UUID Metadata</span>
                <p className="text-xs font-mono font-medium text-secondary bg-surface-container px-3 py-2 border border-outline-variant rounded break-all">
                  {selectedDoc.uuidOrMeta}
                </p>
              </div>

              {selectedDoc.type === 'PEDIMENTO' && (
                <div className="bg-emerald-50 border border-emerald-100 p-3 rounded-lg space-y-1.5 font-sans">
                  <span className="text-[9px] uppercase font-extrabold text-emerald-800 block">Detalles Oficiales de Despacho (SAT)</span>
                  <div className="grid grid-cols-1 gap-1 text-[11px] font-sans">
                    <div><span className="font-bold text-[#0c4d32]">Agente Aduanal:</span> {agenteAduanal}</div>
                    <div><span className="font-bold text-[#0c4d32]">Número Pedimento:</span> {numeroPedimento}</div>
                  </div>
                </div>
              )}

              <p className="text-[11px] text-justify text-on-surface-variant leading-relaxed">
                Este documento electrónico forma parte integral del pedimento consolidado de aduanas regulado bajo la norma general de reglas de comercio exterior RNF-09. Su firma digital inalterable ha sido sellada.
              </p>
            </div>

            <div className="p-4 bg-surface-container-low border-t border-outline-variant flex gap-3">
              <button 
                onClick={() => setShowPDFViewer(true)}
                className="flex-1 bg-white border border-outline text-primary font-bold py-2 text-xs rounded hover:bg-surface-container transition-colors cursor-pointer"
              >
                Visualizar PDF
              </button>
              <button 
                onClick={() => {
                  handleDownloadDoc(selectedDoc);
                  setSelectedDoc(null);
                }}
                className="flex-1 bg-primary text-on-primary font-bold py-2 text-xs rounded hover:opacity-90 transition-opacity"
              >
                Descargar Archivo
              </button>
            </div>

          </div>
        </div>
      )}

      {showPDFViewer && selectedDoc && (
        <div className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
          <style>{`
            @media print {
              body * {
                visibility: hidden !important;
              }
              #printable-doc-preview-area, #printable-doc-preview-area * {
                visibility: visible !important;
              }
              #printable-doc-preview-area {
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
          
          <div className="bg-slate-900/30 w-full max-w-3xl rounded-2xl border border-outline-variant shadow-2xl flex flex-col overflow-hidden h-[85vh] bg-surface-container-lowest animate-in fade-in zoom-in-95 duration-200">
            {/* Toolbar */}
            <div className="no-print p-4 border-b border-outline-variant bg-surface-container-low flex justify-between items-center shrink-0">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-primary" />
                <span className="text-xs font-bold font-sans text-primary">Visualizador de Documentos PDF Oficiales</span>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  type="button"
                  onClick={() => window.print()}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 active:scale-95 transition-all cursor-pointer font-sans"
                >
                  <Printer className="w-3.5 h-3.5" />
                  <span>Imprimir PDF</span>
                </button>
                <button 
                  type="button"
                  onClick={() => setShowPDFViewer(false)}
                  className="text-outline hover:text-primary p-1.5 hover:bg-surface-container rounded-full transition-colors cursor-pointer"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>
            </div>

            {/* Paper area */}
            <div className="flex-1 overflow-y-auto p-6 justify-center bg-surface-container-low flex custom-scrollbar">
              <div 
                id="printable-doc-preview-area"
                className="bg-white border border-outline-variant/60 w-full max-w-[190mm] min-h-[260mm] p-10 text-slate-800 shadow-md flex flex-col justify-between font-sans relative"
              >
                <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-emerald-800 via-amber-600 to-emerald-800" />
                
                <div>
                  {/* Header */}
                  <div className="flex justify-between items-start pb-4 border-b-2 border-emerald-900 mb-6 font-sans">
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1">
                        <span className="inline-block w-3 h-3 bg-emerald-800 rounded-sm" />
                        <span className="text-[10px] font-black uppercase text-emerald-800 tracking-wider">SAT / ANAM</span>
                      </div>
                      <h4 className="text-md font-extrabold text-emerald-900">{selectedDoc.type} ADUANERO</h4>
                      <span className="text-[8px] font-bold text-amber-600 uppercase tracking-wider block">Sello Digital de la Operación de Importación</span>
                    </div>
                    <div className="text-right font-mono text-[8.5px] leading-relaxed text-slate-500">
                      <div><strong>REFERENCIA:</strong> {selectedDoc.ref}</div>
                      <div><strong>ARCHIVADO:</strong> {selectedDoc.date}</div>
                      <div><strong>ESTATUS:</strong> {selectedDoc.status}</div>
                    </div>
                  </div>

                  {/* Title */}
                  <div className="bg-slate-50 border border-slate-100 p-3 rounded-lg mb-6 text-center">
                    <h5 className="text-[11px] font-bold text-slate-800 uppercase tracking-wide">Previsualización de Archivo Integrado</h5>
                    <p className="text-[10px] text-slate-500 font-sans mt-0.5">{selectedDoc.name}</p>
                  </div>

                  {/* Dynamic Inner Preview based on type */}
                  {selectedDoc.type === 'XML_SELLO' ? (
                    <div className="space-y-4 font-mono text-[10px] bg-[#0c130d] text-[#4af626] p-4 rounded-lg border border-[#1e2e1e] overflow-auto max-h-[350px]">
                      <div>{`<?xml version="1.0" encoding="UTF-8"?>`}</div>
                      <div className="pl-2">{`<sat:ComprobanteAduanal version="3.3" folio="${selectedDoc.ref}" SelloDigital="SGA_${selectedDoc.uuidOrMeta.substring(0,6)}">`}</div>
                      <div className="pl-4">{`<sat:Emisor rfc="LOG880124MX1" razonSocial="HUMAN SOFTWARE MEXICO" />`}</div>
                      <div className="pl-4">{`<sat:Despacho patente="${agenteAduanal.split('-')[0].trim() || '3920'}" pedimento="${numeroPedimento}" />`}</div>
                      <div className="pl-4">{`<sat:Conceptos>`}</div>
                      <div className="pl-6">{`<sat:Flag eFirma="OK" status="CERTIFIED" timestamp="${new Date().toISOString()}" />`}</div>
                      <div className="pl-4">{`</sat:Conceptos>`}</div>
                      <div className="pl-4">{`<sat:CertificadoSello>`}</div>
                      <div className="pl-6 break-all text-emerald-400/80">{`MIIF3jCCA8agAwIBAgIUMDAwMDEwMDAwMDA1MDQwODAzMDMwDQYJKoZIhvcNAQELBQAwggGEMSAwHgYDVQQDDBdBVVRPUklEQUQgQ0VSVElGSUNBRE9SQTEuMCwGA1UECgwlU0VSVklDSU8gREUgQURNSU5JU1RSQUNJT04gVFJJQlVUQVJJQTEvMC0GA1UECwwmU0FULUlFUyBBdXRob3JpdHkxKjAoBgkqhkiG9w0BCQEWG2NvbnRhY3RvLnRlbGVmb25pY29Ac2F0LmdvYi5teA==`}</div>
                      <div className="pl-4">{`</sat:CertificadoSello>`}</div>
                      <div className="pl-2">{`</sat:ComprobanteAduanal>`}</div>
                    </div>
                  ) : selectedDoc.type === 'PEDIMENTO' ? (
                    <div className="space-y-3 font-mono text-[10px] border border-slate-200 p-4 rounded bg-slate-50">
                      <div className="flex justify-between font-bold border-b pb-1">
                        <span>PEDIMENTO PRINCIPAL DE IMPORTACIÓN RECTIFICADA</span>
                        <span className="text-emerald-700">T1 (DRAFT)</span>
                      </div>
                      <div className="grid grid-cols-2 gap-2 text-[9.5px]">
                        <div><span className="font-bold">PATENTE:</span> {agenteAduanal.split('-')[0].trim() || '3920'}</div>
                        <div><span className="font-bold">NÚMERO PEDIMENTO:</span> {numeroPedimento}</div>
                        <div><span className="font-bold">AGENTE ADUANAL:</span> {agenteAduanal.includes('-') ? agenteAduanal.split('-')[1].trim() : agenteAduanal}</div>
                        <div><span className="font-bold">TIPO OPER:</span> IMPORTACION (IM)</div>
                        <div><span className="font-bold">ADUANA SECCIÓN:</span> MEX (47-0) AICM</div>
                        <div><span className="font-bold">RÉGIMEN:</span> INTEGRAL DEFINITIVO (IMD)</div>
                        <div><span className="font-bold">RFC IMPORTADOR:</span> LOG880124MX1</div>
                        <div><span className="font-bold">VALOR ADUANA:</span> $345,120.00 USD</div>
                      </div>
                      <div className="border-t border-dashed my-2" />
                      <div className="text-[9px]">
                        <span className="font-bold block uppercase text-slate-700">DETALLE ARANCELARIO INTEGRAL:</span>
                        <div className="mt-1 flex justify-between">
                          <span>8517.12.01 - TELÉFONOS CELULARES</span>
                          <span>$12,450.00 USD - IGI %0</span>
                        </div>
                        <div className="flex justify-between">
                          <span>6204.43.01 - VESTIDOS DE COSER</span>
                          <span>$8,200.00 USD - IGI %20</span>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-4 text-xs">
                      <div className="space-y-2 border border-slate-200 rounded p-3">
                        <span className="font-bold text-slate-700 uppercase text-[10px] block">Detalles de Guía General</span>
                        <div className="grid grid-cols-2 gap-2 font-mono text-[10.5px]">
                          <div><span className="font-sans font-semibold">TIPO REGISTRO:</span> {selectedDoc.type}</div>
                          <div><span className="font-sans font-semibold">TAMAÑO ARCHIVO:</span> {selectedDoc.size}</div>
                          <div><span className="font-sans font-semibold">CÓDIGO ARCHIVO:</span> {selectedDoc.ref}</div>
                          <div><span className="font-sans font-semibold">FIRMA ADUANA:</span> ARCHIVED_OK</div>
                        </div>
                      </div>
                      
                      <div className="border border-slate-100 rounded bg-slate-50 p-3 leading-relaxed text-slate-600 text-[11px] font-sans">
                        Este archivo digital ({selectedDoc.name}) se encuentra debidamente pre-clasificado y auditado utilizando modelos inteligentes de SGA Customs. Sus firmas criptográficas acreditan el cumplimiento estricto con las Reglas de Carácter General en Materia de Comercio Exterior.
                      </div>
                    </div>
                  )}
                </div>

                {/* Footer seal */}
                <div className="border-t border-slate-200 pt-4 mt-8">
                  <div className="flex justify-between items-end">
                    <div className="font-mono text-[8px] text-slate-400 space-y-0.5">
                      <div>SELLO COMPLIANCE SGA-ANAM: 6da01f3e74c93ae8ffbd102ab</div>
                      <div>PROCESAMIENTO S S G A • PORTAL DE COMPLIANCE DE ADUANAS DE MÉXICO</div>
                    </div>
                    <div className="w-12 h-12 border border-slate-200 flex flex-col justify-center items-center bg-white">
                      <div className="w-10 h-1 bg-slate-800 mb-0.5" />
                      <div className="w-10 h-2 bg-slate-400 mb-0.5" />
                      <div className="w-10 h-4 bg-slate-800" />
                    </div>
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

// Simple internal loader icon companion
function LoaderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
    </svg>
  );
}
