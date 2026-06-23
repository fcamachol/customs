import { useState, useEffect } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Sidebar } from './components/Sidebar';
import { PageHeader } from './components/ui';
import { SECTION_META, visibleSectionsFor, type Section, type ConfigSection } from './nav';
import { LoginView } from './components/LoginView';
import { AcercaDeView } from './components/AcercaDeView';
import DashboardView from './components/DashboardView';
import RegistroView from './components/RegistroView';
import ConsultaView from './components/ConsultaView';
import SeguimientoView from './components/SeguimientoView';
import ReporteGeneralView from './components/ReporteGeneralView';
import ConfigurationView from './components/ConfigurationView';
import AutoridadView from './components/AutoridadView';

function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 3200);
    return () => clearTimeout(t);
  }, [message, onDone]);
  return (
    <div className="fixed bottom-6 right-6 z-50 rounded-lg bg-navy-800 px-4 py-2.5 text-sm font-medium text-white shadow-lg">
      {message}
    </div>
  );
}

function AuthenticatedApp() {
  const { user, logout } = useAuth();
  const [section, setSection] = useState<Section>('dashboard');
  const [toast, setToast] = useState<string | null>(null);
  const allowed = visibleSectionsFor(user!.role);
  const current = allowed.includes(section) ? section : 'dashboard';
  const meta = SECTION_META[current];

  return (
    <div className="flex min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">
      <Sidebar role={user!.role} active={current} onSelect={setSection} username={user!.username} onLogout={logout} />
      <main className="min-w-0 flex-1 px-8 py-8">
        <div className="mx-auto max-w-7xl">
          <PageHeader title={meta.title} subtitle={meta.subtitle} />
          {current === 'dashboard' && <DashboardView onNavigate={setSection} />}
          {current === 'registro' && <RegistroView />}
          {current === 'seguimiento' && <SeguimientoView />}
          {current === 'reporte' && <ReporteGeneralView />}
          {current === 'consulta' && <ConsultaView />}
          {current.startsWith('cfg_') && <ConfigurationView domain={current as ConfigSection} onToast={setToast} />}
          {current === 'autoridad' && <AutoridadView />}
          {current === 'acerca' && <AcercaDeView />}
        </div>
      </main>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function AuthGate() {
  const { user } = useAuth();
  if (!user) return <LoginView />;
  return <AuthenticatedApp />;
}

export default function App() {
  return (<AuthProvider><AuthGate /></AuthProvider>);
}
