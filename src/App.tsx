import { useState } from 'react';
import { T1Provider } from './context/T1Context';
import { AuthProvider, useAuth } from './context/AuthContext';
import { Sidebar } from './components/Sidebar';
import { PageHeader } from './components/ui';
import { SECTION_META, visibleSectionsFor, type Section } from './nav';
import { LoginView } from './components/LoginView';
import { AcercaDeView } from './components/AcercaDeView';
import DashboardView from './components/DashboardView';
import RegistroView from './components/RegistroView';
import ConsultaView from './components/ConsultaView';
import SeguimientoView from './components/SeguimientoView';
import ReporteGeneralView from './components/ReporteGeneralView';

function AuthenticatedApp() {
  const { user, logout } = useAuth();
  const [section, setSection] = useState<Section>('dashboard');
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
          {current === 'acerca' && <AcercaDeView />}
        </div>
      </main>
    </div>
  );
}

function AuthGate() {
  const { user } = useAuth();
  if (!user) return <LoginView />;
  return (<T1Provider><AuthenticatedApp /></T1Provider>);
}

export default function App() {
  return (<AuthProvider><AuthGate /></AuthProvider>);
}
