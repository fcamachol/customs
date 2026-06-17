/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 *
 * SGA Customs — Ultimate Aduanas T1 Software
 * Main App shell with T1Context provider
 */

import { useState } from 'react';

import { T1Provider } from './context/T1Context';
import { AuthProvider, useAuth } from './context/AuthContext';
import { AppShell, type Section } from './components/AppShell';
import { LoginView } from './components/LoginView';
import { AcercaDeView } from './components/AcercaDeView';
import DashboardView from './components/DashboardView';
import RegistroView from './components/RegistroView';
import ConsultaView from './components/ConsultaView';

// ---------------------------------------------------------------------------
// Authenticated app — six-section shell (Plan 05)
// ---------------------------------------------------------------------------

function AuthenticatedApp() {
  const { user } = useAuth();
  const [section, setSection] = useState<Section>('registro');

  return (
    <div className="min-h-screen bg-surface-container-lowest text-primary-fixed flex flex-col font-sans antialiased">
      <AppShell role={user!.role} active={section} onSelect={setSection} />
      <div className="flex-1 min-h-0 p-6 overflow-y-auto">
        {section === 'registro' && <RegistroView />}
        {/* TODO: needs seguimiento/reporte backend capture endpoints */}
        {section === 'seguimiento' && <div>Seguimiento</div>}
        {section === 'reporte' && <div>Reporte General</div>}
        {section === 'consulta' && <ConsultaView />}
        {section === 'dashboard' && <DashboardView />}
        {section === 'acerca' && <AcercaDeView />}
      </div>
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
