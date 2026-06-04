/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { 
  Settings, 
  Plus, 
  Trash2, 
  RefreshCw, 
  Activity, 
  Database, 
  AlertOctagon, 
  BadgeHelp,
  Sliders,
  Check,
  Zap,
  Radio,
  FileCheck2,
  Lock
} from 'lucide-react';
import { GuideRecord, RiskLevel } from '../types';

interface ConfigurationViewProps {
  onAddCustomRecord: (newRecord: Omit<GuideRecord, 'id'>) => void;
  onResetAllData: () => void;
  satOnline: boolean;
  onToggleSatWeb: () => void;
  satLatency: number;
  onChangeSatLatency: (ms: number) => void;
  agenteAduanal: string;
  onChangeAgenteAduanal: (val: string) => void;
  numeroPedimento: string;
  onChangeNumeroPedimento: (val: string) => void;
  userRole?: 'capturista' | 'admin' | 'autoridad';
}

export default function ConfigurationView({
  onAddCustomRecord,
  onResetAllData,
  satOnline,
  onToggleSatWeb,
  satLatency,
  onChangeSatLatency,
  agenteAduanal,
  onChangeAgenteAduanal,
  numeroPedimento,
  onChangeNumeroPedimento,
  userRole = 'admin'
}: ConfigurationViewProps) {
  // Record Form state
  const [guideId, setGuideId] = useState('MX-HD-90866');
  const [importer, setImporter] = useState('Apple Logistics Mexico');
  const [htsCode, setHtsCode] = useState('8517.13.01');
  const [declaredVal, setDeclaredVal] = useState('145000');
  const [desc, setDesc] = useState('Apple iPhone 15 Pro Commercial Units');
  const [risk, setRisk] = useState<RiskLevel>('WARNING');
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const triggerToast = (msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage(null);
    }, 3000);
  };

  const handleCreateRecord = (e: React.FormEvent) => {
    e.preventDefault();
    if (userRole !== 'admin') {
      triggerToast(`🔒 Inyección denegada: Tu rol de ${userRole.toUpperCase()} no tiene privilegios de Admin.`);
      alert(`🚫 Acción Restringida: Solo el Administrador de SGA puede inyectar guías directamente a la base de datos fiscal.`);
      return;
    }
    const valObj = parseFloat(declaredVal);
    
    if (!guideId || !importer || !htsCode || isNaN(valObj)) {
      triggerToast('⚠️ Por favor completa los campos requeridos.');
      return;
    }

    onAddCustomRecord({
      guideId: guideId.trim(),
      importerName: importer.trim(),
      htsCode: htsCode.trim(),
      description: desc.trim(),
      declaredValue: valObj,
      riskLevel: risk,
      flags: risk === 'CRITICAL' ? ['notes', 'location'] : risk === 'WARNING' ? ['wallet'] : []
    });

    triggerToast(`🎉 Docket ${guideId.trim()} inyectado en base de datos.`);
    
    // Auto increment guide code
    const parts = guideId.split('-');
    if (parts.length === 3) {
      const code = parseInt(parts[2], 10);
      if (!isNaN(code)) {
        setGuideId(`MX-HD-${code + 1}`);
      }
    } else {
      setGuideId(`MX-HD-${Math.floor(10000 + Math.random() * 90000)}`);
    }

    setImporter('');
    setDesc('');
  };

  return (
    <div className="space-y-6">
      
      {/* Configuration Header block */}
      <div className="bg-white border border-outline-variant p-6 rounded-xl flex items-center gap-4 shadow-sm">
        <div className="p-3 bg-primary text-white rounded-lg">
          <Settings className="w-6 h-6" />
        </div>
        <div>
          <h2 className="text-lg font-bold">Plataforma de Configuración & Simulador</h2>
          <p className="text-xs text-on-surface-variant">
            Inyecte expedientes nuevos en caliente y administre la latencia de red de los servidores SAT / ANAM.
          </p>
        </div>
      </div>

      {userRole !== 'admin' && (
        <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-xl p-4 flex gap-3 text-xs select-none">
          <Lock className="w-5 h-5 text-amber-600 shrink-0 mt-0.5 animate-bounce" />
          <div>
            <p className="font-extrabold text-amber-800">Parámetros del Simulador Bloqueados (Reservado para Administradores)</p>
            <p className="text-amber-700 font-medium mt-1 leading-relaxed">
              Como <strong>{userRole === 'capturista' ? 'Capturista' : 'Autoridad fiscal'}</strong> no posees permisos de superusuario o administración para inyectar expedientes de forma cruda en aduanas o simular caídas de servidores. Si deseas interactuar plenamente con el simulador, cambia tu tipo de usuario a <strong>Admin</strong> abajo a la izquierda en la barra lateral.
            </p>
          </div>
        </div>
      )}

      {toastMessage && (
        <div className="p-3 bg-primary-container text-white border border-outline rounded-lg text-xs leading-none flex items-center justify-between animate-in fade-in duration-200">
          <span>{toastMessage}</span>
          <Check className="w-4 h-4 text-emerald-400" />
        </div>
      )}

      {/* Two columns: Left Register New Guide vs Right Net metrics config */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Form column */}
        <section className="lg:col-span-7 bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm flex flex-col">
          <div className="p-4 border-b border-outline-variant bg-surface-container-low/50 flex items-center gap-2">
            <Database className="w-4.5 h-4.5 text-primary" />
            <h3 className="font-bold text-sm text-primary">Simular Inyección de Expediente de Aduana</h3>
          </div>

          <form onSubmit={handleCreateRecord} className="p-5 space-y-4 flex-1">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-on-surface-variant">Guía ID (Fórmula: MX-HD-xxxxx)</label>
                <input 
                  type="text" 
                  value={guideId}
                  onChange={e => setGuideId(e.target.value)}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary font-bold font-mono placeholder:font-sans"
                  placeholder="e.g. MX-HD-90888"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-on-surface-variant">Importador / Razón Social</label>
                <input 
                  type="text" 
                  value={importer}
                  onChange={e => setImporter(e.target.value)}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                  placeholder="e.g. Logística Apple Inc"
                  required
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-on-surface-variant">HS Code (Fracción Arancelaria)</label>
                <input 
                  type="text" 
                  value={htsCode}
                  onChange={e => setHtsCode(e.target.value)}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary font-mono"
                  placeholder="e.g. 8517.13.01"
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-bold uppercase text-on-surface-variant">Valor Declarado (USD)</label>
                <input 
                  type="number" 
                  value={declaredVal}
                  onChange={e => setDeclaredVal(e.target.value)}
                  className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary font-mono font-bold"
                  placeholder="e.g. 15000"
                  required
                />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-on-surface-variant">Descripción de Mercancía</label>
              <input 
                type="text" 
                value={desc}
                onChange={e => setDesc(e.target.value)}
                className="w-full p-2 border border-outline rounded text-xs outline-none focus:border-primary focus:ring-1 focus:ring-primary"
                placeholder="e.g. Smart Telephones with internal antennas"
              />
            </div>

            <div className="space-y-1">
              <label className="text-[10px] font-bold uppercase text-on-surface-variant block mb-1">Nivel de Riesgo Evaluado</label>
              <div className="flex gap-2">
                {([
                  { label: 'Aprobado', val: 'CLEARED' as RiskLevel, colorClass: 'border-emerald-500 hover:bg-emerald-50 text-emerald-700' },
                  { label: 'Advertencia', val: 'WARNING' as RiskLevel, colorClass: 'border-amber-400 hover:bg-amber-50 text-amber-700' },
                  { label: 'Crítico', val: 'CRITICAL' as RiskLevel, colorClass: 'border-red-600 hover:bg-red-50 text-red-700' },
                ]).map(opt => (
                  <button
                    key={opt.val}
                    type="button"
                    onClick={() => setRisk(opt.val)}
                    className={`flex-1 py-2 text-xs font-bold border rounded transition-all select-none ${opt.colorClass} ${
                      risk === opt.val 
                        ? 'bg-primary text-white hover:text-white border-primary shadow' 
                        : 'bg-white text-secondary'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="pt-4 flex gap-3">
              <button 
                type="submit"
                className={`flex-1 font-bold py-2.5 text-xs rounded-lg transition-all flex items-center justify-center gap-2 select-none ${
                  userRole !== 'admin'
                    ? 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                    : 'bg-primary text-on-primary hover:opacity-90 cursor-pointer'
                }`}
                disabled={userRole !== 'admin'}
              >
                <Plus className="w-4 h-4" />
                <span>{userRole !== 'admin' ? 'Inyección Bloqueada (Solo Admin)' : 'Inyectar en Base de Datos'}</span>
              </button>
            </div>
          </form>
        </section>

        {/* Right column sidebar parameter tweaking */}
        <section className="lg:col-span-5 space-y-6 flex flex-col justify-between">
          
          {/* Latency card */}
          <div className="bg-white border border-outline-variant p-5 rounded-xl shadow-sm space-y-4">
            <h3 className="text-sm font-bold flex items-center gap-2">
              <Sliders className="w-5 h-5 text-primary" />
              <span>Parámetros de Interconexión</span>
            </h3>

            {/* SAT online switch option */}
            <div className="flex items-center justify-between py-2 border-b border-outline-variant/60">
              <div>
                <p className="text-xs font-bold">Servidor SAT WebService</p>
                <p className="text-[10px] text-on-surface-variant">
                  {satOnline ? 'Integrado online activo' : 'Mantenimiento preventivo SAT'}
                </p>
              </div>
              
              <button
                type="button"
                onClick={() => {
                  if (userRole !== 'admin') {
                    alert("🚫 Acción Denegada: Solo el Administrador de SGA tiene facultades para simular la desconexión del WebService del SAT.");
                    return;
                  }
                  onToggleSatWeb();
                }}
                className={`w-12 h-6 flex items-center rounded-full p-1 transition-all outline-none ${
                  satOnline ? 'bg-primary' : 'bg-outline-variant'
                } ${userRole !== 'admin' ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
              >
                <div className={`w-4 h-4 bg-white rounded-full shadow transition-all ${
                  satOnline ? 'translate-x-6' : 'translate-x-0'
                }`} />
              </button>
            </div>

            {/* Latency adjustment slide */}
            <div className="space-y-2 pt-1">
              <div className="flex justify-between text-xs font-bold">
                <span>Latencia de Servidores ANAM</span>
                <span className="font-mono text-primary">{satLatency} ms</span>
              </div>
              <input
                type="range"
                min="10"
                max="1000"
                step="10"
                value={satLatency}
                onChange={e => {
                  if (userRole !== 'admin') {
                    alert("🚫 Acción Denegada: Solo el Administrador de SGA tiene facultades para alterar las latencias de interconexión con ANAM.");
                    return;
                  }
                  onChangeSatLatency(parseInt(e.target.value, 10));
                }}
                disabled={userRole !== 'admin'}
                className={`w-full accent-primary h-1.5 bg-outline-variant rounded-lg ${userRole !== 'admin' ? 'opacity-45 cursor-not-allowed' : 'cursor-pointer'}`}
              />
              <div className="flex justify-between text-[9px] text-secondary font-bold uppercase">
                <span>Rápido (10ms)</span>
                <span>Normal (124ms)</span>
                <span>Retraso (1000ms)</span>
              </div>
            </div>
          </div>

          {/* Captura de datos de despacho */}
          <div className="bg-white border border-outline-variant p-5 rounded-xl shadow-sm space-y-4">
            <h3 className="text-sm font-bold flex items-center gap-2 text-primary">
              <FileCheck2 className="w-5 h-5 text-emerald-500" />
              <span>Captura de Datos de Despacho</span>
            </h3>
            <p className="text-[11px] text-on-surface-variant leading-relaxed">
              Establezca la información predeterminada del Agente aduanal representante y el número oficial de pedimento a registrar ante el SAT WebService.
            </p>

            <div className="space-y-3 pt-1">
              <div className="space-y-1 bg-surface-container-low/40 p-2.5 rounded border border-outline-variant/60">
                <label className="text-[10px] font-bold uppercase text-on-surface-variant block mb-1">Agente Aduanal / Patente</label>
                <input 
                  type="text" 
                  value={agenteAduanal}
                  onChange={e => onChangeAgenteAduanal(e.target.value)}
                  className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-bold text-primary"
                  placeholder="e.g. 3920 - Mario Sanchez"
                  required
                />
              </div>

              <div className="space-y-1 bg-surface-container-low/40 p-2.5 rounded border border-outline-variant/60">
                <label className="text-[10px] font-bold uppercase text-on-surface-variant block mb-1">Número de Pedimento (15 dígitos)</label>
                <input 
                  type="text" 
                  value={numeroPedimento}
                  onChange={e => onChangeNumeroPedimento(e.target.value)}
                  className="w-full p-2 bg-white border border-outline rounded text-xs outline-none focus:border-primary font-mono font-bold text-primary"
                  placeholder="e.g. 24 12 3004 0001854"
                  required
                />
                <span className="text-[9px] text-secondary font-mono mt-1 block">Estructura SAT: YY AA BBBB CCCNNNN</span>
              </div>
            </div>
          </div>

          {/* Reset button card */}
          <div className="bg-red-50/20 border border-error/10 p-5 rounded-xl text-center space-y-3 shadow-xs">
            <AlertOctagon className="w-10 h-10 text-error mx-auto animate-pulse" />
            <div>
              <p className="text-xs font-bold text-error">¿Restaurar Dockets de Pruebas?</p>
              <p className="text-[11px] text-on-surface-variant max-w-xs mx-auto mt-1 leading-normal">
                Esta acción elimina todos sus registros inyectados personalizados y devuelve el sistema a la configuración de auditoría inicial.
              </p>
            </div>
            
            <button
              type="button"
              onClick={() => {
                if (userRole !== 'admin') {
                  alert("🚫 Acción Denegada: Solo el Administrador de SGA tiene privilegios para restaurar o inicializar de cero el simulador.");
                  return;
                }
                onResetAllData();
                triggerToast('🔄 Base de datos reseteada a dockets originales.');
              }}
              className={`font-bold py-2 px-4 text-xs rounded select-none transition-all cursor-pointer active:scale-95 flex items-center justify-center gap-1.5 mx-auto ${
                userRole !== 'admin'
                  ? 'bg-slate-150 text-slate-405 border border-slate-200 cursor-not-allowed opacity-50'
                  : 'bg-error text-white hover:opacity-90 shadow-sm'
              }`}
              disabled={userRole !== 'admin'}
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Restaurar Datos de Pruebas</span>
            </button>
          </div>

        </section>

      </div>

    </div>
  );
}
