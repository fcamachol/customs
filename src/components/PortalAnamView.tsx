/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { 
  Gavel, 
  TrendingUp, 
  CheckCircle, 
  AlertTriangle, 
  Clock, 
  Search, 
  Bell, 
  History, 
  Download, 
  ChevronRight, 
  ShieldCheck, 
  Plus, 
  Calendar, 
  Activity, 
  Lock, 
  RefreshCw 
} from 'lucide-react';
import { AuthorityPendingItem, OperationLogItem } from '../types';

interface PortalAnamViewProps {
  initialPending: AuthorityPendingItem[];
  initialLogs: OperationLogItem[];
  userRole?: 'capturista' | 'admin' | 'autoridad';
}

export default function PortalAnamView({ 
  initialPending, 
  initialLogs,
  userRole = 'admin'
}: PortalAnamViewProps) {
  const [pending, setPending] = useState<AuthorityPendingItem[]>(initialPending);
  const [logs, setLogs] = useState<OperationLogItem[]>(initialLogs);
  const [historyDate, setHistoryDate] = useState('2023-10-27');
  const [searchTerm, setSearchTerm] = useState('');

  // Interactive metrics state
  const [alertsCount, setAlertsCount] = useState(14);
  const [complianceRate, setComplianceRate] = useState(98.4);

  // Toggles item audit status in real-time
  const toggleItemStatus = (refCode: string) => {
    if (userRole === 'capturista') {
      alert("🚫 Opción Bloqueada: Los Capturistas no tienen facultades fiscales de auditoría para dictaminar o liberar pedimentos en la cola de revisión. Por favor cambia tu tipo de usuario a 'Autoridad' o 'Admin' abajo en la barra lateral.");
      return;
    }
    let statusChangedTo = '';
    setPending(prev => prev.map(item => {
      if (item.reference === refCode) {
        const nextStatus = item.status === 'PENDIENTE' ? 'AUDITADO' : 'PENDIENTE';
        statusChangedTo = nextStatus;
        return { ...item, status: nextStatus };
      }
      return item;
    }));

    // Add log event
    const nowStamp = new Date().toLocaleTimeString();
    const newLog: OperationLogItem = {
      timestamp: `27 OCT ${nowStamp}`,
      message: `Auditoría ANAM: Estatus de ${refCode} actualizado a ${statusChangedTo} por ${userRole.toUpperCase()}.`,
      actorCode: userRole === 'admin' ? 'ADMIN_SGA' : 'ANAM_AUDITOR_3',
      type: statusChangedTo === 'AUDITADO' ? 'success' : 'normal'
    };
    setLogs(prev => [newLog, ...prev]);

    // Reactively modify metrics
    if (statusChangedTo === 'AUDITADO') {
      setAlertsCount(prev => Math.max(0, prev - 1));
      setComplianceRate(prev => Math.min(100, parseFloat((prev + 0.1).toFixed(1))));
    } else {
      setAlertsCount(prev => prev + 1);
      setComplianceRate(prev => Math.max(80, parseFloat((prev - 0.1).toFixed(1))));
    }
  };

  // Simulates loading more historical pending files
  const loadMoreToday = () => {
    if (userRole === 'capturista') {
      alert("🚫 Acción Denegada: Solo la Autoridad o Administrador de la ANAM pueden refrescar o jalar de los Web Services la cola vigente.");
      return;
    }
    const extraItems: AuthorityPendingItem[] = [
      {
        reference: 'AG-2023-9844',
        mawbEntry: '030-91124581',
        fechaArribo: '2023-10-27',
        riskLevel: 'Medio',
        status: 'PENDIENTE'
      },
      {
        reference: 'AG-2023-9810',
        mawbEntry: '405-22341097',
        fechaArribo: '2023-10-25',
        riskLevel: 'Bajo',
        status: 'PENDIENTE'
      }
    ];

    // Filter out duplicates
    setPending(prev => {
      const existingRefs = prev.map(p => p.reference);
      const uniqueExtras = extraItems.filter(e => !existingRefs.includes(e.reference));
      return [...prev, ...uniqueExtras];
    });
  };

  // Filter logs via text
  const filteredLogs = logs.filter(log => 
    log.message.toLowerCase().includes(searchTerm.toLowerCase()) ||
    log.actorCode.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // Consult history logs on Date
  const handleQueryHistory = () => {
    // Generate some fresh logs corresponding to the queried date
    const formattedDate = new Date(historyDate).toLocaleDateString('es-MX', {
      day: '2-digit', month: 'short'
    }).toUpperCase();

    const historicalLogs: OperationLogItem[] = [
      {
        timestamp: `${formattedDate} 11:20:00`,
        message: `Consulta de auditoría archivada para el período ${historyDate}. Registros íntegros.`,
        actorCode: 'ANAM_PROUT',
        type: 'success'
      },
      {
        timestamp: `${formattedDate} 08:30:15`,
        message: `Despacho aduanero completado para 1,120 guías de carga.`,
        actorCode: 'SYSTEM_SAT',
        type: 'normal'
      }
    ];

    setLogs(prev => [...historicalLogs, ...prev]);
  };

  return (
    <div className="space-y-6">
      
      {/* Banner de Autoridad EXCLUSIVO */}
      {userRole === 'capturista' ? (
        <div className="bg-red-50 text-red-900 py-3.5 px-6 rounded-xl font-mono text-[11px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border border-red-200 shadow-sm text-center">
          <AlertTriangle className="w-4 h-4 text-red-600 shrink-0 select-none animate-pulse" />
          <span>⚠️ ACCESO RESTRINGIDO: Modo Demo de Lectura para Capturistas. Cambia de Rol a "Autoridad" o "Admin" abajo en la barra lateral para dictaminar.</span>
        </div>
      ) : (
        <div className="bg-primary-container text-white py-2 px-6 rounded-xl font-mono text-[11px] font-bold uppercase tracking-wider flex items-center justify-center gap-2 border border-outline shadow-sm text-center">
          <Gavel className="w-4 h-4 text-emerald-400 shrink-0" />
          <span>ESTADO: VISTA DE AUTORIDAD (ANAM) - PERFIL AUTORIZADO DE REVISIÓN Y DICTAMEN [{userRole.toUpperCase()}]</span>
        </div>
      )}

      {/* Stats Bento Cards Row */}
      <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
        {/* Card A */}
        <div className="bg-white border border-outline-variant p-5 rounded-xl flex flex-col gap-1.5 shadow-xs hover:shadow-sm transition-shadow">
          <span className="text-on-surface-variant text-[10px] font-bold tracking-wider uppercase">
            MANIFIESTOS ANALIZADOS (FY24)
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-primary">12,842</span>
            <span className="text-emerald-600 font-bold text-xs flex items-center gap-0.5">
              <TrendingUp className="w-3.5 h-3.5" />
              <span>4.2%</span>
            </span>
          </div>
        </div>

        {/* Card B */}
        <div className="bg-white border border-outline-variant p-5 rounded-xl flex flex-col gap-1.5 shadow-xs hover:shadow-sm transition-shadow">
          <span className="text-on-surface-variant text-[10px] font-bold tracking-wider uppercase">
            TASA DE CUMPLIMIENTO
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-primary">{complianceRate}%</span>
            <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-800 rounded font-bold text-[9px]">
              ÓPTIMO
            </span>
          </div>
        </div>

        {/* Card C */}
        <div className="bg-white border border-outline-variant p-5 rounded-xl flex flex-col gap-1.5 border-l-4 border-l-error shadow-xs hover:shadow-sm transition-shadow">
          <span className="text-error text-[10px] font-bold tracking-wider uppercase">
            ALERTAS CRÍTICAS
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-error">{alertsCount}</span>
            <span className="text-on-surface-variant text-xs font-semibold">Sin Resolver</span>
          </div>
        </div>

        {/* Card D */}
        <div className="bg-primary-container text-white p-5 rounded-xl flex flex-col justify-between shadow-xs">
          <div className="flex justify-between items-start opacity-95">
            <span className="text-[10px] font-bold uppercase tracking-wider text-on-primary-container">
              ÚLTIMA CAPTURA DEL SISTEMA
            </span>
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="font-mono text-[14px] font-semibold mt-2 text-emerald-400">
            2023-10-27 14:22:01
          </div>
        </div>
      </section>

      {/* Grid: Pending Authority & Official Exports */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left main: Pending audits list table */}
        <section className="lg:col-span-2">
          <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
            <div className="p-4 border-b border-outline-variant flex justify-between items-center bg-surface-container-low/50">
              <h3 className="text-sm font-bold text-primary">Pendientes de Revisión Autoridad</h3>
              <span className="text-[10px] font-extrabold text-secondary bg-surface-container border px-2 py-1 rounded">
                COLA DE AUDITORÍA ANAM
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left font-sans">
                <thead className="bg-surface-container-high/60 text-on-surface-variant font-table-header text-table-header uppercase tracking-wider border-b border-outline-variant text-[11px]">
                  <tr>
                    <th className="px-6 py-3">Referencia</th>
                    <th className="px-6 py-3">MAWB / Entry</th>
                    <th className="px-6 py-3">Fecha Arribo</th>
                    <th className="px-6 py-3">Nivel Riesgo</th>
                    <th className="px-6 py-3">Estatus</th>
                    <th className="px-6 py-3 text-right">Acción</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant text-xs font-medium">
                  {pending.map((item) => {
                    const dotColors = {
                      Bajo: 'bg-emerald-500',
                      Medio: 'bg-amber-500',
                      Crítico: 'bg-error'
                    };
                    const rClass = dotColors[item.riskLevel] || 'bg-outline';

                    return (
                      <tr key={item.reference} className="hover:bg-surface-container-low/50 transition-colors">
                        <td className="px-6 py-4 font-mono font-bold text-primary">{item.reference}</td>
                        <td className="px-6 py-4 text-on-surface-variant">{item.mawbEntry}</td>
                        <td className="px-6 py-4 opacity-80">{item.fechaArribo}</td>
                        <td className="px-6 py-4">
                          <span className="flex items-center gap-1.5 font-bold">
                            <span className={`w-2 h-2 rounded-full ${rClass}`} />
                            <span>{item.riskLevel}</span>
                          </span>
                        </td>
                        <td className="px-6 py-4">
                          <span className={`px-2 py-0.5 rounded text-[9px] font-extrabold uppercase select-none ${
                            item.status === 'AUDITADO' 
                              ? 'bg-primary text-white' 
                              : 'bg-surface-container-highest border border-outline-variant text-primary font-bold'
                          }`}>
                            {item.status}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-right">
                          <button 
                            type="button"
                            onClick={() => toggleItemStatus(item.reference)}
                            className="bg-white hover:bg-surface-container p-1 rounded border border-outline text-[10px] font-bold transition-all text-primary active:scale-95"
                          >
                            {item.status === 'PENDIENTE' ? 'Auditar' : 'Revertir'}
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="p-3 bg-surface-container-low/40 text-center border-t border-outline-variant shrink-0">
              <button 
                onClick={loadMoreToday}
                className="text-xs font-bold text-primary hover:underline"
              >
                Cargar más registros de hoy
              </button>
            </div>
          </div>
        </section>

        {/* Right column sidebar */}
        <section className="space-y-6">
          
          {/* Exports block */}
          <div className="bg-white border border-outline-variant p-5 rounded-xl shadow-sm">
            <h3 className="text-md font-bold mb-3 flex items-center gap-2">
              <Download className="w-5 h-5 text-primary" />
              <span>Exportación Oficial</span>
            </h3>
            <p className="text-xs text-on-surface-variant leading-relaxed mb-4">
              Descarga cifrada de expedientes digitales consolidados para evidencia fiscal regulada.
            </p>

            <div className="space-y-2">
              <button 
                onClick={() => alert('Starting secure download: Certificado Análisis de Riesgo SAT...')}
                className="w-full flex items-center justify-between p-3 border border-outline-variant hover:border-primary rounded-lg hover:bg-surface-container-low transition-all group outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <Activity className="w-4 h-4 text-primary" />
                  <span className="font-bold text-xs text-primary">Certificado Análisis de Riesgo</span>
                </div>
                <ChevronRight className="w-4 h-4 text-outline group-hover:translate-x-1 transition-transform" />
              </button>

              <button 
                onClick={() => alert('Starting secure download: Expediente Completo ANAM...')}
                className="w-full flex items-center justify-between p-3 border border-outline-variant hover:border-primary rounded-lg hover:bg-surface-container-low transition-all group outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-primary" />
                  <span className="font-bold text-xs text-primary">Expediente Completo (ANAM)</span>
                </div>
                <ChevronRight className="w-4 h-4 text-outline group-hover:translate-x-1 transition-transform" />
              </button>

              <button 
                onClick={() => alert('Starting secure download: Acuse de Validación SAT...')}
                className="w-full flex items-center justify-between p-3 border border-outline-variant hover:border-primary rounded-lg hover:bg-surface-container-low transition-all group outline-none"
              >
                <div className="flex items-center gap-2.5">
                  <History className="w-4 h-4 text-primary" />
                  <span className="font-bold text-xs text-primary">Acuse de Validación SAT</span>
                </div>
                <ChevronRight className="w-4 h-4 text-outline group-hover:translate-x-1 transition-transform" />
              </button>
            </div>
          </div>

          {/* Custodia block */}
          <div className="bg-primary-container text-white p-5 rounded-xl relative overflow-hidden shadow-xs">
            <div className="absolute -right-4 -bottom-4 opacity-10 pointer-events-none">
              <ShieldCheck className="w-32 h-32 text-white" />
            </div>
            <h4 className="text-md font-bold mb-1.5">Cadena de Custodia</h4>
            <p className="text-xs opacity-80 leading-relaxed mb-4">
              Todos los dockets en SGA Customs son inalterables y cuentan con firma e.firma avanzada de la autoridad aduanera.
            </p>

            <div className="p-3 bg-white/5 rounded-lg border border-white/10 space-y-2">
              <div className="flex justify-between items-center text-[9px] font-bold opacity-90 uppercase">
                <span>TIEMPO DE ACTIVIDAD</span>
                <span className="text-emerald-400 font-extrabold">OPERATIVO</span>
              </div>
              <div className="flex gap-1 h-2 select-none">
                <div className="flex-1 bg-emerald-500 rounded-sm" />
                <div className="flex-1 bg-emerald-500 rounded-sm" />
                <div className="flex-1 bg-emerald-500 rounded-sm" />
                <div className="flex-1 bg-emerald-500 rounded-sm" />
                <div className="flex-1 bg-emerald-400 rounded-sm" />
                <div className="flex-1 bg-emerald-500 rounded-sm" />
                <div className="flex-1 bg-emerald-500 rounded-sm" />
                <div className="flex-1 bg-emerald-400 rounded-sm animate-pulse" />
              </div>
            </div>
          </div>

        </section>

      </div>

      {/* Bitácora Global de Operaciones */}
      <section className="bg-white border border-outline-variant rounded-xl p-5 shadow-sm space-y-4">
        
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h3 className="text-md font-bold">Bitácora Global de Operaciones</h3>
            <p className="text-xs text-on-surface-variant">
              Trazabilidad cifrada de modificaciones a niveles de declaración y dintel de riesgo fiscal
            </p>
          </div>

          <div className="flex gap-2 w-full sm:w-auto">
            {/* Find search bar */}
            <input 
              type="text" 
              placeholder="Buscar descriptor..." 
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              className="border border-outline-variant hover:border-outline focus:border-primary text-xs px-3 py-1.5 outline-none rounded bg-white w-full sm:w-52"
            />
            {/* Find date bar */}
            <input 
              type="date"
              value={historyDate}
              onChange={e => setHistoryDate(e.target.value)}
              className="border border-outline-variant px-2.5 py-1.5 text-xs font-semibold rounded bg-white"
            />
            <button 
              onClick={handleQueryHistory}
              className="bg-primary hover:opacity-90 text-on-primary font-bold text-xs px-4 py-1.5 rounded flex items-center justify-center gap-1.5 select-none shrink-0"
            >
              <Calendar className="w-3.5 h-3.5" />
              <span>Consultar Histórico</span>
            </button>
          </div>
        </div>

        {/* Global Operation logs rows */}
        <div className="border border-outline-variant rounded-lg overflow-hidden font-mono text-xs divide-y divide-outline-variant">
          {filteredLogs.length === 0 ? (
            <div className="p-4 text-center text-on-surface-variant font-sans">
              No se encontraron registros de operaciones.
            </div>
          ) : (
            filteredLogs.map((log, index) => {
              return (
                <div 
                  key={index} 
                  className={`grid grid-cols-1 md:grid-cols-[140px_1fr_120px] items-center p-3 gap-2 hover:bg-surface-container-low transition-colors ${
                    log.type === 'error' 
                      ? 'bg-red-50/20 text-red-950' 
                      : log.type === 'success' 
                      ? 'bg-emerald-50/10 text-emerald-950' 
                      : 'bg-surface-container-low/40'
                  }`}
                >
                  <span className="text-on-surface-variant font-semibold text-[11px] select-none">{log.timestamp}</span>
                  <p className="text-xs font-sans text-primary capitalize leading-relaxed select-text truncate md:whitespace-normal md:overflow-visible pr-4">
                    {log.message}
                  </p>
                  <span className="text-right text-[10px] font-bold text-primary select-all break-all">{log.actorCode}</span>
                </div>
              );
            })
          )}
        </div>

      </section>

      {/* Persistent mini server metrics summary */}
      <div className="fixed bottom-6 right-6 pointer-events-none z-30">
        <div className="bg-white border border-outline focus:border-primary shadow-xl px-4 py-3 rounded-xl flex items-center gap-4 pointer-events-auto shrink-0 select-none animate-bounce duration-1000">
          <div className="flex flex-col">
            <span className="text-[9px] font-bold text-on-surface-variant leading-none uppercase">Latencia de respuesta ANAM</span>
            <span className="font-mono text-xs font-bold text-emerald-600 mt-1">124ms</span>
          </div>
          <div className="w-[1px] h-8 bg-outline-variant" />
          <div className="flex flex-col">
            <span className="text-[9px] font-bold text-on-surface-variant leading-none uppercase">Auditores Activos</span>
            <span className="font-mono text-xs font-bold text-primary mt-1">03</span>
          </div>
        </div>
      </div>

    </div>
  );
}
