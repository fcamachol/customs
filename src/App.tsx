/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SGA Customs — Ultimate Aduanas T1 Software
 * Main App shell with T1Context provider
 */

import { useState } from 'react';
import { Activity, FileBarChart2, type LucideIcon } from 'lucide-react';

import { T1Provider } from './context/T1Context';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppShell, type Section } from './components/AppShell';
import { LoginView } from './components/LoginView';
import { AcercaDeView } from './components/AcercaDeView';
import DashboardView from './components/DashboardView';
import RegistroView from './components/RegistroView';
import ConsultaView from './components/ConsultaView';

// ---------------------------------------------------------------------------
// Per-section page metadata (title + subtitle shown above each view)
// ---------------------------------------------------------------------------

const SECTION_META: Record<Section, { title: string; subtitle: string }> = {
  registro: {
    title: 'Realizar Registro',
    subtitle: 'Carga un manifiesto y ejecuta el análisis de riesgo T1.',
  },
  seguimiento: {
    title: 'Seguimiento',
    subtitle: 'Estado y trazabilidad de las guías en proceso.',
  },
  reporte: {
    title: 'Reporte General',
    subtitle: 'Consolidado de operaciones y cumplimiento.',
  },
  consulta: {
    title: 'Consulta',
    subtitle: 'Busca registros previos y descarga sus artefactos.',
  },
  dashboard: {
    title: 'Dashboard',
    subtitle: 'Métricas operativas en tiempo real.',
  },
  acerca: {
    title: 'Acerca de',
    subtitle: 'Plataforma de análisis de riesgo y cumplimiento T1.',
  },
};

// ---------------------------------------------------------------------------
// Empty state — used for sections without a backend capture endpoint yet
// ---------------------------------------------------------------------------

function EmptyState({ icon: Icon, message }: { icon: LucideIcon; message: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white px-6 py-20 text-center">
      <div className="grid h-12 w-12 place-items-center rounded-full bg-slate-100 text-slate-400">
        <Icon className="h-6 w-6" />
      </div>
      <p className="mt-4 max-w-sm text-sm text-slate-500">{message}</p>
      <span className="mt-3 rounded-full bg-slate-100 px-3 py-1 text-xs font-semibold text-slate-500">
        Próximamente
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Authenticated app — six-section shell (Plan 05)
// ---------------------------------------------------------------------------

function AuthenticatedApp() {
  const { user, logout } = useAuth();
  const [section, setSection] = useState<Section>('registro');
  const meta = SECTION_META[section];

  return (
    <div className="min-h-screen bg-slate-50 font-sans text-slate-900 antialiased">
      <AppShell
        role={user!.role}
        active={section}
        onSelect={setSection}
        username={user!.username}
        onLogout={logout}
      />
      <main className="mx-auto max-w-7xl px-6 py-8">
        <header className="mb-6">
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">{meta.title}</h1>
          <p className="mt-1 text-sm text-slate-500">{meta.subtitle}</p>
        </header>

        {section === 'registro' && <RegistroView />}
        {/* TODO: needs seguimiento/reporte backend capture endpoints */}
        {section === 'seguimiento' && (
          <EmptyState icon={Activity} message="El seguimiento de guías estará disponible cuando se conecte el endpoint de captura." />
        )}
        {section === 'reporte' && (
          <EmptyState icon={FileBarChart2} message="El reporte general consolidado estará disponible próximamente." />
        )}
        {section === 'consulta' && <ConsultaView />}
        {section === 'dashboard' && <DashboardView />}
        {section === 'acerca' && <AcercaDeView />}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Auth gate — LoginView when logged out, the app when logged in
// ---------------------------------------------------------------------------

function AuthGate() {
  const { user } = useAuth();
  if (!user) return <LoginView />;
  return (
    <T1Provider>
      <AuthenticatedApp />
    </T1Provider>
  );
}

// ---------------------------------------------------------------------------
// Export with Provider wrapper
// ---------------------------------------------------------------------------

export default function App() {
  return (
    <AuthProvider>
      <AuthGate />
    </AuthProvider>
  );
}
