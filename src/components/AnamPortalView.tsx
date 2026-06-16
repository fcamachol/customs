/**
 * AnamPortalView — Authority Audit Interface (ANAM / SAT)
 *
 * Simulates the ANAM auditor perspective on T1 operations:
 *   - Pending T1 reviews
 *   - Risk flags: volume spikes, fractional indicators, tax discrepancies
 *   - Audit actions: request previo, flag for cancellation (Rule 3.7.34)
 *   - Live access simulation to courier risk systems
 */

import { useState } from 'react';
import {
  Gavel,
  Search,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Eye,
  FileSearch,
  Ban,
  ShieldCheck,
  Clock,
  ChevronRight,
  Lock,
} from 'lucide-react';
import { useT1 } from '../context/T1Context';
import { getCountryName, formatUSD } from '../utils/formatters';

export default function AnamPortalView() {
  const { state } = useT1();
  const { manifest, compliance, pedimento, userRole } = state;
  const shipments = manifest.shipments;

  const [searchTerm, setSearchTerm] = useState('');
  const [selectedAuditTab, setSelectedAuditTab] = useState<'pending' | 'risk' | 'history'>('pending');

  // Only autoridad role gets full access
  const isAuthority = userRole === 'autoridad';

  // Risk analysis from ANAM perspective
  const riskFlags = [
    {
      id: 'RISK-001',
      title: 'Consignatarios con múltiples envíos cercanos a $2,500',
      severity: 'HIGH' as const,
      count: 2,
      detail: 'RFCs con 3+ envíos sumando entre $2,400-$2,499 USD. Posible fraccionamiento.',
    },
    {
      id: 'RISK-002',
      title: 'Origen con alta tasa de RRNA',
      severity: 'MEDIUM' as const,
      count: shipments.filter((s) => s.rrnaFlags.length > 0).length,
      detail: 'Envíos de China con descripciones que evaden clasificación específica.',
    },
    {
      id: 'RISK-003',
      title: 'Discrepancia en liquidación fiscal',
      severity: 'LOW' as const,
      count: 0,
      detail: 'Comparación entre tasa declarada y calculada por el sistema.',
    },
  ];

  const pendingAudits = [
    {
      id: 'AUD-2024-001',
      pedimento: '24 12 3004 0001854',
      em: 'EM123456',
      guias: 45,
      value: 12450,
      status: 'PENDIENTE',
      date: '2024-12-15',
    },
    {
      id: 'AUD-2024-002',
      pedimento: '24 12 3005 0002311',
      em: 'EM789012',
      guias: 12,
      value: 3200,
      status: 'PREVIO_SOLICITADO',
      date: '2024-12-14',
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-white border border-outline-variant p-6 rounded-xl shadow-sm flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-indigo-600 text-white rounded-lg">
            <Gavel className="w-6 h-6" />
          </div>
          <div>
            <h2 className="text-lg font-bold">Portal ANAM — Auditoría T1</h2>
            <p className="text-xs text-on-surface-variant">
              Interfaz de fiscalización para Empresas de Mensajería y Paquetería (Trámite 78/LA)
            </p>
          </div>
        </div>
        {!isAuthority && (
          <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-lg px-4 py-2 text-xs font-bold flex items-center gap-2">
            <Lock className="w-4 h-4" />
            Vista limitada. Cambie a rol Autoridad para acceso completo.
          </div>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <StatBox label="Pedimentos Pendientes" value={pendingAudits.filter((a) => a.status === 'PENDIENTE').length} color="indigo" />
        <StatBox label="Previos Solicitados" value={pendingAudits.filter((a) => a.status === 'PREVIO_SOLICITADO').length} color="amber" />
        <StatBox label="Riesgos Detectados" value={riskFlags.length} color="red" />
        <StatBox label="Aprobados Hoy" value={0} color="emerald" />
      </div>

      {/* Tabs */}
      <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
        <div className="flex border-b border-outline-variant">
          {[
            { id: 'pending', label: 'Pendientes de Revisión', icon: Clock },
            { id: 'risk', label: 'Banderas de Riesgo', icon: AlertTriangle },
            { id: 'history', label: 'Historial de Auditoría', icon: FileSearch },
          ].map((tab) => {
            const Icon = tab.icon;
            const active = selectedAuditTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => setSelectedAuditTab(tab.id as typeof selectedAuditTab)}
                className={`flex items-center gap-2 px-5 py-3 text-xs font-bold transition-all border-b-2 ${
                  active
                    ? 'border-indigo-500 text-indigo-700 bg-indigo-50/30'
                    : 'border-transparent text-on-surface-variant hover:text-primary hover:bg-surface-container-low'
                }`}
              >
                <Icon className="w-4 h-4" />
                {tab.label}
              </button>
            );
          })}
        </div>

        {/* Pending tab */}
        {selectedAuditTab === 'pending' && (
          <div className="p-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead className="bg-surface-container-high text-on-surface-variant border-b border-outline-variant">
                  <tr>
                    <th className="px-4 py-3 text-[11px] font-semibold uppercase">ID Auditoría</th>
                    <th className="px-4 py-3 text-[11px] font-semibold uppercase">Pedimento T1</th>
                    <th className="px-4 py-3 text-[11px] font-semibold uppercase">EM</th>
                    <th className="px-4 py-3 text-[11px] font-semibold uppercase text-center">Guías</th>
                    <th className="px-4 py-3 text-[11px] font-semibold uppercase text-right">Valor USD</th>
                    <th className="px-4 py-3 text-[11px] font-semibold uppercase">Estado</th>
                    <th className="px-4 py-3 text-[11px] font-semibold uppercase text-right">Acciones</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-outline-variant text-xs font-sans">
                  {pendingAudits.map((audit) => (
                    <tr key={audit.id} className="hover:bg-surface-container-low transition-colors">
                      <td className="px-4 py-3 font-mono font-bold text-primary">{audit.id}</td>
                      <td className="px-4 py-3 font-mono">{audit.pedimento}</td>
                      <td className="px-4 py-3">{audit.em}</td>
                      <td className="px-4 py-3 text-center font-bold">{audit.guias}</td>
                      <td className="px-4 py-3 text-right font-mono">{formatUSD(audit.value)}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-extrabold ${
                          audit.status === 'PENDIENTE'
                            ? 'bg-amber-100 text-amber-800'
                            : 'bg-indigo-100 text-indigo-800'
                        }`}>
                          {audit.status === 'PENDIENTE' ? <Clock className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                          {audit.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-1">
                          <button
                            className="p-1.5 rounded hover:bg-emerald-50 text-emerald-600 transition-colors"
                            title="Aprobar"
                          >
                            <CheckCircle className="w-4 h-4" />
                          </button>
                          <button
                            className="p-1.5 rounded hover:bg-amber-50 text-amber-600 transition-colors"
                            title="Solicitar Previo"
                          >
                            <FileSearch className="w-4 h-4" />
                          </button>
                          <button
                            className="p-1.5 rounded hover:bg-red-50 text-red-600 transition-colors"
                            title="Rechazar"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* Risk tab */}
        {selectedAuditTab === 'risk' && (
          <div className="p-4 space-y-3">
            {riskFlags.map((risk) => (
              <div
                key={risk.id}
                className={`p-4 rounded-lg border flex items-start gap-3 ${
                  risk.severity === 'HIGH'
                    ? 'bg-red-50 border-red-200'
                    : risk.severity === 'MEDIUM'
                    ? 'bg-amber-50 border-amber-200'
                    : 'bg-blue-50 border-blue-200'
                }`}
              >
                <AlertTriangle className={`w-5 h-5 shrink-0 mt-0.5 ${
                  risk.severity === 'HIGH' ? 'text-red-600' : risk.severity === 'MEDIUM' ? 'text-amber-600' : 'text-blue-600'
                }`} />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-sm">{risk.title}</span>
                    <span className={`text-[9px] font-extrabold px-1.5 py-0.5 rounded ${
                      risk.severity === 'HIGH'
                        ? 'bg-red-200 text-red-900'
                        : risk.severity === 'MEDIUM'
                        ? 'bg-amber-200 text-amber-900'
                        : 'bg-blue-200 text-blue-900'
                    }`}>
                      {risk.severity}
                    </span>
                  </div>
                  <p className="text-xs text-on-surface-variant mt-1">{risk.detail}</p>
                  <p className="text-[10px] font-mono mt-1">
                    Afectados: <span className="font-bold">{risk.count}</span> guías
                  </p>
                </div>
                {isAuthority && (
                  <button className="text-[10px] font-bold text-primary hover:underline flex items-center gap-1 shrink-0">
                    <Eye className="w-3 h-3" />
                    Investigar
                  </button>
                )}
              </div>
            ))}

            {/* Fractional detection from actual data */}
            {shipments.length > 0 && (
              <div className="p-4 rounded-lg border bg-white border-outline-variant">
                <h4 className="font-bold text-sm flex items-center gap-2">
                  <Ban className="w-4 h-4 text-red-600" />
                  Análisis de Fraccionamiento (Datos Actuales)
                </h4>
                <p className="text-xs text-on-surface-variant mt-1">
                  Consignatarios con múltiples envíos que suman &gt;$2,500 USD
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead className="text-on-surface-variant border-b border-outline-variant">
                      <tr>
                        <th className="py-2">RFC</th>
                        <th className="py-2">Envíos</th>
                        <th className="py-2 text-right">Total USD</th>
                        <th className="py-2 text-center">Acción</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-outline-variant/50">
                      {Object.entries(
                        shipments.reduce((acc, s) => {
                          const rfc = s.consigneeRfc.toUpperCase().trim();
                          if (!acc[rfc]) acc[rfc] = [];
                          acc[rfc].push(s);
                          return acc;
                        }, {} as Record<string, typeof shipments>)
                      )
                        .filter(([, group]) => group.length >= 2)
                        .map(([rfc, group]) => {
                          const total = group.reduce((sum, s) => sum + s.declaredValueUsd, 0);
                          return (
                            <tr key={rfc}>
                              <td className="py-2 font-mono">{rfc}</td>
                              <td className="py-2">{group.length}</td>
                              <td className="py-2 text-right font-bold">${total.toFixed(2)}</td>
                              <td className="py-2 text-center">
                                {total > 2500 ? (
                                  <span className="text-[9px] font-extrabold px-1.5 py-0.5 rounded bg-red-100 text-red-800">
                                    FRACCIONAMIENTO
                                  </span>
                                ) : (
                                  <span className="text-[9px] font-bold text-emerald-600">OK</span>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        )}

        {/* History tab */}
        {selectedAuditTab === 'history' && (
          <div className="p-8 text-center text-on-surface-variant">
            <FileSearch className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">Historial de auditorías ANAM</p>
            <p className="text-xs mt-1">Las auditorías completadas se registrarán aquí.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatBox({ label, value, color }: { label: string; value: number; color: string }) {
  const colorMap: Record<string, { bg: string; text: string }> = {
    indigo: { bg: 'bg-indigo-50', text: 'text-indigo-600' },
    amber: { bg: 'bg-amber-50', text: 'text-amber-600' },
    red: { bg: 'bg-red-50', text: 'text-red-600' },
    emerald: { bg: 'bg-emerald-50', text: 'text-emerald-600' },
  };
  const c = colorMap[color] || colorMap.indigo;

  return (
    <div className="bg-white border border-outline-variant p-5 rounded-xl shadow-sm">
      <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">{label}</p>
      <p className={`text-2xl font-black mt-1 ${c.text}`}>{value}</p>
    </div>
  );
}
