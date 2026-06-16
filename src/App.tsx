/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SGA Customs — Ultimate Aduanas T1 Software
 * Main App shell with T1Context provider
 */

import { useState, useEffect, useRef } from 'react';
import {
  LayoutDashboard,
  UploadCloud,
  ShieldAlert,
  FileText,
  Gavel,
  Settings,
  User,
  AlertTriangle,
  X,
  Check,
} from 'lucide-react';

import { T1Provider, useT1 } from './context/T1Context';
import DashboardView from './components/DashboardView';
import ManifestUploadView from './components/ManifestUploadView';
import T1ComplianceView from './components/T1ComplianceView';
import PedimentoBuilderView from './components/PedimentoBuilderView';
import AnamPortalView from './components/AnamPortalView';
import ConfigurationView from './components/ConfigurationView';

// ---------------------------------------------------------------------------
// Inner App — has access to T1Context
// ---------------------------------------------------------------------------

function AppInner() {
  const { state, dispatch } = useT1();
  const [activeTab, setActiveTab] = useState<string>('dashboard');
  const [notification, setNotification] = useState<string | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerToast = (message: string) => {
    setNotification(message);
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    toastTimerRef.current = setTimeout(() => setNotification(null), 4500);
  };

  useEffect(() => {
    return () => {
      if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    };
  }, []);

  const tabs = [
    { id: 'dashboard', label: 'Operaciones', icon: LayoutDashboard },
    { id: 'manifests', label: 'Cargar Manifiesto T1', icon: UploadCloud, badge: 'T1' },
    { id: 'compliance', label: 'Análisis de Cumplimiento', icon: ShieldAlert, alertDot: true },
    { id: 'pedimento', label: 'Generar Pedimento T1', icon: FileText },
    { id: 'anam', label: 'Portal ANAM (Autoridad)', icon: Gavel },
    { id: 'config', label: 'Parámetros / Simulador', icon: Settings },
  ];

  const handleRoleChange = (role: 'capturista' | 'admin' | 'autoridad') => {
    dispatch({ type: 'SET_USER_ROLE', payload: role });
    triggerToast(`👤 Rol de usuario cambiado a: ${role.toUpperCase()}`);
  };

  return (
    <div className="min-h-screen bg-surface-container-lowest text-primary-fixed flex flex-col font-sans antialiased selection:bg-primary/20 selection:text-primary">
      {/* SAT offline warning */}
      {!state.satOnline && (
        <div className="bg-red-600 text-white py-2 px-4 text-center font-bold text-xs select-none flex items-center justify-center gap-2 animate-bounce">
          <AlertTriangle className="w-4 h-4 text-white fill-white/20 animate-pulse" />
          <span>¡SISTEMA SAT ADUANAS DE MÉXICO CAÍDO! Las verificaciones usarán caché interna.</span>
        </div>
      )}

      <div className="flex-1 flex flex-col md:flex-row">
        {/* Sidebar */}
        <aside className="w-full md:w-64 bg-primary text-white shrink-0 flex flex-col justify-between py-6 border-r border-outline-variant select-none">
          <div className="space-y-8">
            {/* Brand */}
            <div className="px-6 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center border border-white/20">
                <Gavel className="w-4 h-4 text-emerald-400 rotate-45" />
              </div>
              <div className="leading-tight">
                <h1 className="font-sans font-black tracking-wider text-sm">SGA Customs</h1>
                <p className="text-[10px] font-mono text-emerald-400 font-extrabold uppercase tracking-widest leading-none">
                  T1 Pedimento Pro
                </p>
              </div>
            </div>

            {/* Navigation */}
            <nav className="space-y-1 block h-fit">
              {tabs.map((tab) => {
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

          {/* User profile */}
          <div className="px-6 pt-6 border-t border-white/10 space-y-3.5">
            <div>
              <label className="text-[9px] font-mono font-bold text-white/50 tracking-wider block mb-1.5 uppercase">
                TIPO DE USUARIO (ROL)
              </label>
              <div className="grid grid-cols-3 gap-1 bg-white/5 p-1 rounded-lg border border-white/10 select-none">
                {(['capturista', 'admin', 'autoridad'] as const).map((r) => (
                  <button
                    key={r}
                    onClick={() => handleRoleChange(r)}
                    className={`text-[8px] font-bold py-1.5 rounded transition-all capitalize select-none outline-none ${
                      state.userRole === r
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
              <div
                className={`w-8 h-8 rounded-full flex items-center justify-center transition-colors duration-300 ${
                  state.userRole === 'admin'
                    ? 'bg-amber-100 text-amber-900 border border-amber-300'
                    : state.userRole === 'autoridad'
                    ? 'bg-indigo-100 text-indigo-950 border border-indigo-300'
                    : 'bg-emerald-100 text-[#09351e]'
                }`}
              >
                <User className="w-4 h-4" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[11px] font-black text-white truncate leading-none">
                  {state.userRole === 'admin'
                    ? 'Ing. Fer (Administrador)'
                    : state.userRole === 'autoridad'
                    ? 'Auditor ANAM / SAT'
                    : 'M. Sanchez (Captura)'}
                </p>
                <p className="text-[9px] font-mono font-semibold text-emerald-400 mt-1 flex items-center gap-1 leading-none select-none">
                  <span
                    className={`w-1.5 h-1.5 rounded-full inline-block ${
                      state.userRole === 'admin'
                        ? 'bg-amber-400'
                        : state.userRole === 'autoridad'
                        ? 'bg-indigo-400 animate-pulse'
                        : 'bg-emerald-400'
                    }`}
                  />
                  <span>{state.userRole.toUpperCase()}</span>
                </p>
              </div>
            </div>

            <div className="flex justify-between items-center text-[8px] font-mono font-semibold text-white/50 pt-2 px-1">
              <span>SGA T1 PRO V2.0</span>
              <span className="flex items-center gap-1 select-none">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block animate-ping" />
                <span>CONEXIÓN ACTIVA</span>
              </span>
            </div>
          </div>
        </aside>

        {/* Main Content */}
        <main className="flex-1 flex flex-col p-6 overflow-y-auto custom-scrollbar md:h-screen">
          <div className="flex-1 min-h-0">
            {activeTab === 'dashboard' && <DashboardView />}
            {activeTab === 'manifests' && <ManifestUploadView onToast={triggerToast} />}
            {activeTab === 'compliance' && <T1ComplianceView onToast={triggerToast} />}
            {activeTab === 'pedimento' && <PedimentoBuilderView onToast={triggerToast} />}
            {activeTab === 'anam' && <AnamPortalView />}
            {activeTab === 'config' && <ConfigurationView onToast={triggerToast} />}
          </div>
        </main>
      </div>

      {/* Toast */}
      {notification && (
        <div className="fixed bottom-6 left-6 z-[101] bg-[#0c2e17] text-white py-3.5 px-5 rounded-xl border border-emerald-500 shadow-2xl flex items-center gap-3 animate-in slide-in-from-bottom duration-300">
          <div className="w-5 h-5 bg-emerald-500 text-white rounded-full flex items-center justify-center select-none text-[10px]">
            <Check className="w-3 h-3" />
          </div>
          <span className="text-xs font-bold leading-none pr-2">{notification}</span>
          <button
            onClick={() => setNotification(null)}
            className="text-white/60 hover:text-white transition-colors"
            aria-label="Cerrar notificación"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Export with Provider wrapper
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <T1Provider>
      <AppInner />
    </T1Provider>
  );
}
