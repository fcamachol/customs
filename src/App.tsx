/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { 
  LayoutDashboard, 
  UploadCloud, 
  ShieldAlert, 
  FileText, 
  Gavel, 
  Settings, 
  User, 
  AlertTriangle, 
  Activity, 
  Check, 
  X,
  Sparkles,
  ExternalLink
} from 'lucide-react';

// Data structure types
import { 
  GuideRecord, 
  ManifestActivity, 
  DocumentItem, 
  AuditTrailEvent, 
  ComplianceRule, 
  ParsingRecord,
  AuthorityPendingItem,
  OperationLogItem
} from './types';

// Initial master mock database sets
import { 
  initialGuideRecords, 
  initialManifestActivities, 
  initialDocumentItems, 
  initialAuditTrailEvents, 
  initialComplianceRules, 
  initialParsingRecords,
  initialAuthorityItems,
  initialOperationLogs 
} from './mockData';

// Modular visual templates
import DashboardView from './components/DashboardView';
import ManifestsView from './components/ManifestsView';
import RiskAnalysisView from './components/RiskAnalysisView';
import ExpedientesView from './components/ExpedientesView';
import PortalAnamView from './components/PortalAnamView';
import ConfigurationView from './components/ConfigurationView';

export default function App() {
  // Navigation tabs state
  const [activeTab, setActiveTab] = useState<string>('dashboard');

  // User type/role state: capturista, admin, autoridad
  const [userRole, setUserRole] = useState<'capturista' | 'admin' | 'autoridad'>('admin');

  // Unified master database state
  const [guideRecords, setGuideRecords] = useState<GuideRecord[]>(initialGuideRecords);
  const [activities, setActivities] = useState<ManifestActivity[]>(initialManifestActivities);
  const [docs, setDocs] = useState<DocumentItem[]>(initialDocumentItems);
  const [events, setEvents] = useState<AuditTrailEvent[]>(initialAuditTrailEvents);
  const [rules, setRules] = useState<ComplianceRule[]>(initialComplianceRules);
  const [parsingRecords, setParsingRecords] = useState<ParsingRecord[]>(initialParsingRecords);
  const [authorityItems, setAuthorityItems] = useState<AuthorityPendingItem[]>(initialAuthorityItems);
  const [logs, setLogs] = useState<OperationLogItem[]>(initialOperationLogs);

  // Configuration sliders simulator state
  const [satOnline, setSatOnline] = useState<boolean>(true);
  const [satLatency, setSatLatency] = useState<number>(124);

  // Customs dispatcher data capture states
  const [agenteAduanal, setAgenteAduanal] = useState<string>('3920 - Mario Sanchez');
  const [numeroPedimento, setNumeroPedimento] = useState<string>('24 12 3004 0001854');

  // Quick info alert bar state
  const [showDraftModal, setShowDraftModal] = useState<boolean>(false);
  const [recentDraftUrl, setRecentDraftUrl] = useState<string>('');

  // Floating notification trigger
  const [notification, setNotification] = useState<string | null>(null);

  const triggerToast = (message: string) => {
    setNotification(message);
    setTimeout(() => {
      setNotification(null);
    }, 4500);
  };

  // State manipulation handlers
  const handleAddCustomRecord = (newRec: Omit<GuideRecord, 'id'>) => {
    const freshRec: GuideRecord = {
      ...newRec,
      id: `custom_${Date.now()}`
    };

    setGuideRecords(prev => [freshRec, ...prev]);

    // Also register on current audit log list
    const auditLog: AuditTrailEvent = {
      id: `at_${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      title: `Inyección Docket: ${newRec.guideId}`,
      actor: 'USER',
      description: `Docket inyectado manualmente por administrador para validar HTS ${newRec.htsCode}.`,
      ip: '201.144.112.5',
      file: 'MANUAL_DRAFT.xlsx'
    };
    setEvents(prev => [auditLog, ...prev]);

    const opLog: OperationLogItem = {
      timestamp: `27 OCT ${new Date().toLocaleTimeString()}`,
      message: `Inyección de dintel: El importador ${newRec.importerName} declaró fracción arancelaria HTS ${newRec.htsCode}.`,
      actorCode: 'ID: ADMIN_FER',
      type: 'success'
    };
    setLogs(prev => [opLog, ...prev]);

    triggerToast(`🎉 Docket ${newRec.guideId} inyectado exitosamente!`);
  };

  const handleResetAllData = () => {
    setGuideRecords(initialGuideRecords);
    setActivities(initialManifestActivities);
    setDocs(initialDocumentItems);
    setEvents(initialAuditTrailEvents);
    setRules(initialComplianceRules);
    setParsingRecords(initialParsingRecords);
    setAuthorityItems(initialAuthorityItems);
    setLogs(initialOperationLogs);
    setSatOnline(true);
    setSatLatency(124);
    triggerToast('🔄 Datos de cumplimiento restaurados a su estado original.');
  };

  // Triggered when clicking "Generar Pedimento T1"
  const handleGeneratePedimento = (idCode: string, customBroker?: string, customPedNum?: string) => {
    const finalBroker = customBroker || agenteAduanal;
    const finalPedNum = customPedNum || numeroPedimento;

    if (customBroker) setAgenteAduanal(customBroker);
    if (customPedNum) setNumeroPedimento(customPedNum);

    const docId = docs.length + 1;
    const newPedimentoDoc: DocumentItem = {
      id: docId,
      name: `Pedimento T1 (${idCode})`,
      uuidOrMeta: `No. ${finalPedNum} (Agente: ${finalBroker})`,
      type: 'PEDIMENTO',
      generatedDate: new Date().toISOString().split('T')[0]
    };

    setDocs(prev => [...prev, newPedimentoDoc]);

    const newEvent: AuditTrailEvent = {
      id: `at_${Date.now()}`,
      timestamp: new Date().toISOString().replace('T', ' ').substring(0, 19),
      title: 'Pedimento Generado: SAT WebService',
      actor: 'SYSTEM',
      description: `Pedimento T1 consolidado para el Agente Aduanal / Patente: ${finalBroker}. Referencia SAT: ${finalPedNum}.`,
      ip: '187.162.4.22',
      session: 'API_PED_992'
    };
    setEvents(prev => [newEvent, ...prev]);

    setActiveTab('expedientes');
    triggerToast(`📜 Pedimento ${finalPedNum} generado con éxito para el Agente ${finalBroker}!`);
  };

  // Triggered from manual action in Risk Analysis
  const handleMarkAsDraftPedimento = () => {
    setRecentDraftUrl(`PED_T1_DRAFT_24_${Math.floor(100000 + Math.random() * 900000)}.pdf`);
    setShowDraftModal(true);
  };

  return (
    <div className="min-h-screen bg-surface-container-lowest text-primary-fixed flex flex-col font-sans antialiased selection:bg-primary/20 selection:text-primary">
      
      {/* SAT offline warning banner option */}
      {!satOnline && (
        <div className="bg-red-600 text-white py-2 px-4 text-center font-bold text-xs select-none flex items-center justify-center gap-2 animate-bounce">
          <AlertTriangle className="w-4 h-4 text-white fill-white/20 animate-pulse" />
          <span>¡SISTEMA SAT ADUANAS DE MÉXICO CAÍDO! Las verificaciones de fracciones arancelarias (HTS) usarán caché interna regional.</span>
        </div>
      )}

      {/* Main split grid layout */}
      <div className="flex-1 flex flex-col md:flex-row">
        
        {/* Left persistent high-contrast sidebar */}
        <aside className="w-full md:w-64 bg-primary text-white shrink-0 flex flex-col justify-between py-6 border-r border-outline-variant select-none">
          
          <div className="space-y-8">
            {/* SGA Brand header custom */}
            <div className="px-6 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center border border-white/20">
                <Gavel className="w-4 h-4 text-emerald-400 rotate-45" />
              </div>
              <div className="leading-tight">
                <h1 className="font-sans font-black tracking-wider text-sm">SGA Customs</h1>
                <p className="text-[10px] font-mono text-emerald-400 font-extrabold uppercase tracking-widest leading-none">Portal de Cumplimiento</p>
              </div>
            </div>

            {/* Sidebar navigation items list */}
            <nav className="space-y-1 block h-fit">
              {([
                { id: 'dashboard', label: 'Operaciones', icon: LayoutDashboard },
                { id: 'manifests', label: 'Cargar Manifiestos', icon: UploadCloud, badge: 'NUEVO' },
                { id: 'riskAnalysis', label: 'Análisis de Riesgo', icon: ShieldAlert, alertDot: true },
                { id: 'expedientes', label: 'Expediente Digital', icon: FileText },
                { id: 'portalAnam', label: 'Portal ANAM (Autoridad)', icon: Gavel },
                { id: 'configuration', label: 'Parámetros / Simulador', icon: Settings }
              ]).map(tab => {
                const IconComp = tab.icon;
                const isSelected = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`w-full flex items-center justify-between px-6 py-3.5 text-xs font-bold transition-all border-l-4 outline-none ${
                      isSelected 
                        ? 'bg-white/10 border-emerald-400 font-extrabold text-white' 
                        : 'border-transparent text-white/70 hover:text-white hover:bg-white/5 font-semibold'
                    }`}
                  >
                    <div className="flex items-center gap-3">
                      <IconComp className={`w-4 h-4 ${isSelected ? 'text-emerald-400' : 'text-white/60'}`} />
                      <span>{tab.label}</span>
                    </div>

                    {tab.badge && (
                      <span className="bg-emerald-500 text-[8px] font-black tracking-widest text-[#0c2f1f] px-1.5 py-0.5 rounded-sm">
                        {tab.badge}
                      </span>
                    )}

                    {tab.alertDot && (
                      <span className="w-2 h-2 rounded-full bg-error animate-pulse" />
                    )}
                  </button>
                );
              })}
            </nav>
          </div>

          {/* User profile and Role selector at bottom */}
          <div className="px-6 pt-6 border-t border-white/10 space-y-3.5">
            <div>
              <label className="text-[9px] font-mono font-bold text-white/50 tracking-wider block mb-1.5 uppercase">TIPO DE USUARIO (ROL)</label>
              <div className="grid grid-cols-3 gap-1 bg-white/5 p-1 rounded-lg border border-white/10 select-none">
                {(['capturista', 'admin', 'autoridad'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => {
                      setUserRole(r);
                      triggerToast(`👤 Rol de usuario cambiado a: ${r.toUpperCase()}`);
                    }}
                    className={`text-[8px] font-bold py-1.5 rounded transition-all capitalize select-none outline-none ${
                      userRole === r
                        ? 'bg-emerald-400 text-[#0c2f1f] font-black shadow-md'
                        : 'text-white/60 hover:text-white hover:bg-white/5 font-semibold'
                    }`}
                  >
                    {r === 'capturista' ? 'Captura' : r === 'autoridad' ? 'Autoridad' : 'Admin'}
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center gap-3 p-2 bg-white/5 rounded-xl border border-white/10">
              <div className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors duration-300 ${
                userRole === 'admin' ? 'bg-amber-100 text-amber-900 border border-amber-300' :
                userRole === 'autoridad' ? 'bg-indigo-100 text-indigo-950 border border-indigo-300' :
                'bg-emerald-100 text-[#09351e]'
              }`}>
                <User className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-black text-white truncate leading-none">
                  {userRole === 'admin' ? 'Ing. Fer (Administrador)' :
                   userRole === 'autoridad' ? 'Auditor ANAM / SAT' :
                   'M. Sanchez (Captura)'}
                </p>
                <p className="text-[9px] font-mono font-semibold text-emerald-400 mt-1 flex items-center gap-1 leading-none select-none">
                  <span className={`w-1.5 h-1.5 rounded-full inline-block ${
                    userRole === 'admin' ? 'bg-amber-400' :
                    userRole === 'autoridad' ? 'bg-indigo-400 animate-pulse' :
                    'bg-emerald-400'
                  }`} />
                  <span>{userRole.toUpperCase()}</span>
                </p>
              </div>
            </div>
            
            <div className="flex justify-between items-center text-[8px] font-mono font-semibold text-white/50 pt-2 px-1">
              <span>SGA PORTAL V1.1</span>
              <span className="flex items-center gap-1 select-none">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-ping" />
                <span>CONEXIÓN ACTIVA</span>
              </span>
            </div>
          </div>

        </aside>

        {/* Right workspace view frame */}
        <main className="flex-1 flex flex-col p-6 overflow-y-auto custom-scrollbar md:h-screen">
          
          {/* Active View Render block switcher */}
          <div className="flex-1 min-h-0 animate-in fade-in duration-500">
            {activeTab === 'dashboard' && (
              <DashboardView 
                activities={activities} 
                onAddDeclaration={() => setActiveTab('manifests')}
                onNavigateToTab={(tabId) => setActiveTab(tabId)}
                onSelectManifest={(ref) => {
                  setActiveTab('riskAnalysis');
                  triggerToast(`🔍 Iniciando auditoría preventiva sobre el Ref: ${ref}`);
                }}
              />
            )}

            {activeTab === 'manifests' && (
              <ManifestsView 
                initialRules={rules}
                initialParsingRecords={parsingRecords}
                onGeneratePedimento={handleGeneratePedimento}
                agenteAduanal={agenteAduanal}
                onChangeAgenteAduanal={setAgenteAduanal}
                numeroPedimento={numeroPedimento}
                onChangeNumeroPedimento={setNumeroPedimento}
                onNavigateToTab={setActiveTab}
                onUpdateRiskRecords={setGuideRecords}
                onUpdateParsingRecords={setParsingRecords}
                userRole={userRole}
              />
            )}

            {activeTab === 'riskAnalysis' && (
              <RiskAnalysisView 
                initialRecords={guideRecords}
                onCertifyPedimento={handleMarkAsDraftPedimento}
                onGeneratePedimento={handleGeneratePedimento}
                agenteAduanal={agenteAduanal}
                onChangeAgenteAduanal={setAgenteAduanal}
                numeroPedimento={numeroPedimento}
                onChangeNumeroPedimento={setNumeroPedimento}
              />
            )}

            {activeTab === 'expedientes' && (
              <ExpedientesView 
                initialDocs={docs}
                initialEvents={events}
                agenteAduanal={agenteAduanal}
                numeroPedimento={numeroPedimento}
                initialRecords={guideRecords}
              />
            )}

            {activeTab === 'portalAnam' && (
              <PortalAnamView 
                initialPending={authorityItems}
                initialLogs={logs}
                userRole={userRole}
              />
            )}

            {activeTab === 'configuration' && (
              <ConfigurationView 
                onAddCustomRecord={handleAddCustomRecord}
                onResetAllData={handleResetAllData}
                satOnline={satOnline}
                onToggleSatWeb={() => setSatOnline(prev => !prev)}
                satLatency={satLatency}
                onChangeSatLatency={(ms) => setSatLatency(ms)}
                agenteAduanal={agenteAduanal}
                onChangeAgenteAduanal={setAgenteAduanal}
                numeroPedimento={numeroPedimento}
                onChangeNumeroPedimento={setNumeroPedimento}
                userRole={userRole}
              />
            )}
          </div>

        </main>

      </div>

      {/* Floating notification Toast */}
      {notification && (
        <div className="fixed bottom-6 left-6 z-[101] bg-[#0c2e17] text-white py-3.5 px-5 rounded-xl border border-emerald-500 shadow-2xl flex items-center gap-3 animate-in slide-in-from-bottom duration-300">
          <div className="w-5 h-5 bg-emerald-500 text-white rounded-full flex items-center justify-center select-none text-[10px]">
            ✓
          </div>
          <span className="text-xs font-bold leading-none pr-2">{notification}</span>
          <button 
            onClick={() => setNotification(null)}
            className="text-white/60 hover:text-white transition-colors"
          >
            ×
          </button>
        </div>
      )}

      {/* Pedimento Draft Inspect Overlay Modal / Tool */}
      {showDraftModal && (
        <div className="fixed inset-0 z-[100] bg-primary-container/40 backdrop-blur-xs flex items-center justify-center p-4">
          <div className="bg-white w-full max-w-lg rounded-xl border border-outline-variant shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="p-5 border-b border-outline-variant bg-surface-container-low flex justify-between items-center">
              <div>
                <h3 className="font-bold text-primary text-md">Borrador de Pedimento de Aduanas Mexicanas</h3>
                <p className="text-xs text-on-surface-variant font-medium mt-1">
                  Plantilla de formato que cumple con las estructuras fiscales del SAT.
                </p>
              </div>
              <button 
                onClick={() => setShowDraftModal(false)}
                className="text-outline hover:text-primary transition-colors p-1.5 hover:bg-surface-container rounded-full"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            {/* Pedimento Mock Layout content block */}
            <div className="p-5 overflow-y-auto max-h-[400px] space-y-4 font-mono text-[11px] border-b border-outline-variant bg-white custom-scrollbar">
              
              {/* Captura de Datos Aduanales */}
              <div className="border border-emerald-200 bg-emerald-50/20 p-4 space-y-3 rounded-xl font-sans">
                <span className="font-sans font-extrabold text-xs text-primary block uppercase tracking-wider flex items-center gap-1.5">
                  <Sparkles className="w-4 h-4 text-emerald-600 animate-pulse" />
                  <span>✍️ Datos del Despacho (Captura Requerida)</span>
                </span>
                <p className="text-[10px] text-on-surface-variant font-medium leading-normal">
                  Capture o modifique la información de patente y clave del Agente aduanal, y el número oficial del pedimento.
                </p>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="space-y-1">
                    <label className="text-[9px] font-bold text-[#0c4d32] uppercase">Agente Aduanal / Patente</label>
                    <input 
                      type="text" 
                      value={agenteAduanal}
                      onChange={e => setAgenteAduanal(e.target.value)}
                      className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-bold text-primary"
                      placeholder="e.g. 3920 - Mario Sanchez"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[9px] font-bold text-[#0c4d32] uppercase">Número de Pedimento (15 dígitos)</label>
                    <input 
                      type="text" 
                      value={numeroPedimento}
                      onChange={e => setNumeroPedimento(e.target.value)}
                      className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-mono font-bold text-primary"
                      placeholder="e.g. 24 12 3004 0001854"
                    />
                  </div>
                </div>
              </div>

              <div className="border border-outline-variant p-3 space-y-2 rounded-lg bg-surface-container-low">
                <div className="flex justify-between items-center text-xs font-bold uppercase pb-1 border-b border-outline-variant">
                  <span>PEDIMENTO DE ADUANA</span>
                  <span className="bg-primary text-white px-2 py-0.5 rounded text-[9px]">DRAFT T1</span>
                </div>
                <div className="grid grid-cols-2 gap-2 text-justify">
                  <div><span className="font-bold">PATENTE:</span> {agenteAduanal.split('-')[0].trim() || '3920'}</div>
                  <div><span className="font-bold">AGENTE ADUANAL:</span> {agenteAduanal.includes('-') ? agenteAduanal.split('-')[1].trim() : agenteAduanal}</div>
                  <div><span className="font-bold">PEDIMENTO:</span> {numeroPedimento}</div>
                  <div><span className="font-bold">TIPO OPER:</span> IMPORTACION (IM)</div>
                  <div><span className="font-bold">DESTINO:</span> INTERIOR DEL PAIS (9)</div>
                  <div><span className="font-bold">REGIMEN:</span> DEFINITIVO DE C.E. (IMD)</div>
                  <div><span className="font-bold">ADUANA-SECC:</span> MEX (AICM) (47-0)</div>
                </div>
              </div>

              <div className="border border-outline-variant p-3 space-y-2 rounded-lg bg-surface-container-low">
                <span className="font-bold text-xs block uppercase pb-1 border-b border-outline-variant">DATOS DEL IMPORTADOR</span>
                <div className="grid grid-cols-1 gap-1 text-justify">
                  <div><span className="font-bold">RFC:</span> LOG880124MX1</div>
                  <div><span className="font-bold">CURP:</span> NOT APPLICABLE</div>
                  <div><span className="font-bold">RAZON SOCIAL:</span> HUMAN SOFTWARE MEXICO S.A. DE C.V.</div>
                  <div><span className="font-bold">DOMICILIO:</span> PUEBLA SUR 512, SECTOR JUAREZ, C.P. 72000</div>
                </div>
              </div>

              <div className="border border-outline-variant p-3 space-y-2 rounded-lg bg-surface-container-low">
                <span className="font-bold text-xs block uppercase pb-1 border-b border-outline-variant">LIQUIDACION EN PESOS MEXICANOS</span>
                <div className="divide-y divide-outline-variant-low text-justify">
                  <div className="flex justify-between py-1"><span>IGI (CONCEPTO 01):</span> <span>$24,103.00 MXN</span></div>
                  <div className="flex justify-between py-1"><span>DTA (CONCEPTO 03):</span> <span>$318.00 MXN</span></div>
                  <div className="flex justify-between py-1"><span>IVA (CONCEPTO 05):</span> <span>$14,500.00 MXN</span></div>
                  <div className="flex justify-between py-1 font-bold text-primary pt-1.5 text-xs"><span>TOTAL CONSOLIDADO:</span> <span>$38,921.00 MXN</span></div>
                </div>
              </div>

              <p className="text-[10px] text-justify font-sans text-on-surface-variant leading-relaxed">
                <span className="font-bold text-primary">CADENA ORGINAL DE COMPROBACION COMPROBANTE FISCAL:</span> |{agenteAduanal.split('-')[0].trim() || '3920'}|{numeroPedimento.replace(/\s/g, '')}|2024|LOG880124MX1|38921.00|e.firma:48fa88b901a1c97bd823901a97ce902b33cbde7baf88da72ef91001a4e21a4f0
              </p>

            </div>

            <div className="p-4 bg-surface-container-low bg-white flex flex-col sm:flex-row gap-3">
              <button 
                onClick={() => setShowDraftModal(false)}
                className="flex-1 bg-white border border-outline text-secondary font-bold py-2 text-xs rounded hover:bg-surface-container transition-colors"
              >
                Cerrar Draft
              </button>
              <button 
                onClick={() => {
                  alert(`Imprimiendo copia física de pedimento No. ${numeroPedimento} para el agente ${agenteAduanal} en formato oficial SAT 2024.`);
                  setShowDraftModal(false);
                }}
                className="flex-1 bg-white border border-primary text-primary font-bold py-2 text-xs rounded hover:bg-surface-container transition-colors flex items-center justify-center gap-1.5"
              >
                <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                <span>Imprimir de Prueba</span>
              </button>
              <button 
                onClick={() => {
                  handleGeneratePedimento('MAWB-7729104-MX', agenteAduanal, numeroPedimento);
                  setShowDraftModal(false);
                }}
                className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white font-bold py-2 text-xs rounded transition-all flex items-center justify-center gap-1.5 shadow-sm shadow-emerald-600/20"
              >
                <Sparkles className="w-3.5 h-3.5 text-emerald-300" />
                <span>Generar Pedimento T1</span>
              </button>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
