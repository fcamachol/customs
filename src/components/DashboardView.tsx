/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import { 
  TrendingUp, 
  Clock, 
  AlertTriangle, 
  Plane, 
  Download, 
  Plus, 
  ArrowRight,
  TrendingDown,
  CheckCircle,
  Upload,
  ShieldAlert,
  ArrowUpRight,
  Search,
  ChevronRight,
  ExternalLink
} from 'lucide-react';
import { ManifestActivity } from '../types';

interface DashboardViewProps {
  activities: ManifestActivity[];
  onAddDeclaration: () => void;
  onNavigateToTab: (tabId: string) => void;
  onSelectManifest: (id: string) => void;
}

export default function DashboardView({ 
  activities, 
  onAddDeclaration, 
  onNavigateToTab,
  onSelectManifest
}: DashboardViewProps) {
  const [timeRange, setTimeRange] = useState<'7D' | '30D' | '90D'>('7D');
  const [searchTerm, setSearchTerm] = useState('');

  // Animated bars data depending on time scale
  const barData = {
    '7D': [
      { day: 'MON', value: 840, height: 'h-[60%]' },
      { day: 'TUE', value: 620, height: 'h-[45%]' },
      { day: 'WED', value: 980, height: 'h-[75%]' },
      { day: 'THU', value: 740, height: 'h-[55%]' },
      { day: 'FRI', value: 1248, height: 'h-[90%]', current: true },
      { day: 'SAT', value: 550, height: 'h-[40%]' },
      { day: 'SUN', value: 910, height: 'h-[65%]' }
    ],
    '30D': [
      { day: 'W1', value: 4200, height: 'h-[50%]' },
      { day: 'W2', value: 5600, height: 'h-[70%]' },
      { day: 'W3', value: 7200, height: 'h-[90%]', current: true },
      { day: 'W4', value: 4800, height: 'h-[60%]' }
    ],
    '90D': [
      { day: 'MAR', value: 18400, height: 'h-[55%]' },
      { day: 'APR', value: 24500, height: 'h-[78%]' },
      { day: 'MAY', value: 29800, height: 'h-[95%]', current: true }
    ]
  };

  const filteredActivities = activities.filter(activity => 
    activity.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
    activity.origin.toLowerCase().includes(searchTerm.toLowerCase()) ||
    activity.destination.toLowerCase().includes(searchTerm.toLowerCase()) ||
    activity.assignedAgent.toLowerCase().includes(searchTerm.toLowerCase())
  );

  return (
    <div className="space-y-6">
      {/* Metrics Row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1 */}
        <div className="glass-card p-5 rounded-xl flex flex-col gap-2 hover:shadow-md transition-shadow">
          <div className="flex justify-between items-start">
            <p className="text-xs font-semibold uppercase tracking-wider text-on-primary-container">MAWBs en proceso</p>
            <Clock className="w-5 h-5 text-secondary" />
          </div>
          <p className="text-3xl font-bold tracking-tight">1,248</p>
          <div className="flex items-center gap-1 text-xs text-emerald-600 font-bold">
            <TrendingUp className="w-3.5 h-3.5" />
            <span>+12.5% vs ayer</span>
          </div>
        </div>

        {/* Card 2 */}
        <div className="glass-card p-5 rounded-xl flex flex-col gap-2 border-l-4 border-l-primary hover:shadow-md transition-shadow">
          <div className="flex justify-between items-start">
            <p className="text-xs font-semibold uppercase tracking-wider text-on-primary-container">% Eficiencia de Validación</p>
            <CheckCircle className="w-5 h-5 text-emerald-600" />
          </div>
          <p className="text-3xl font-bold tracking-tight">99.2%</p>
          <div className="flex items-center gap-1 text-xs text-on-surface-variant">
            <span>Target: 98.0%</span>
          </div>
        </div>

        {/* Card 3 */}
        <div className="glass-card p-5 rounded-xl flex flex-col gap-2 bg-error-container/10 border-l-4 border-l-error hover:shadow-md transition-shadow">
          <div className="flex justify-between items-start">
            <p className="text-xs font-semibold uppercase tracking-wider text-error">Casos en Rojo (Riesgo)</p>
            <AlertTriangle className="w-5 h-5 text-error fill-error/20" />
          </div>
          <p className="text-3xl font-bold tracking-tight text-error">14</p>
          <div className="flex items-center gap-1 text-xs text-error font-bold">
            <span>Acción Crítica Requerida</span>
          </div>
        </div>

        {/* Card 4 */}
        <div className="glass-card p-5 rounded-xl flex flex-col gap-2 hover:shadow-md transition-shadow">
          <div className="flex justify-between items-start">
            <p className="text-xs font-semibold uppercase tracking-wider text-on-primary-container">Próximos Arribos</p>
            <Plane className="w-5 h-5 text-secondary" />
          </div>
          <p className="text-3xl font-bold tracking-tight">32</p>
          <div className="flex items-center gap-1 text-xs text-on-surface-variant font-bold">
            <span>Próximas 24 Horas</span>
          </div>
        </div>
      </div>

      {/* Main Chart and Global KPIs */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Chart Column */}
        <div className="lg:col-span-2 glass-card p-5 rounded-xl h-[400px] flex flex-col justify-between">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-lg font-bold">Tendencia de Volumen Diario</h3>
              <p className="text-xs text-on-surface-variant">Registros procesados en todas las patentes de agencias aduanales</p>
            </div>
            {/* Range Toggle */}
            <div className="flex gap-1 bg-surface-container-low p-1 rounded">
              {(['7D', '30D', '90D'] as const).map(range => (
                <button
                  key={range}
                  onClick={() => setTimeRange(range)}
                  className={`px-3 py-1 rounded text-xs font-bold transition-all ${
                    timeRange === range 
                      ? 'bg-white shadow-sm text-primary' 
                      : 'text-on-surface-variant hover:text-primary'
                  }`}
                >
                  {range}
                </button>
              ))}
            </div>
          </div>

          {/* Interactive Bars container */}
          <div className="flex-1 flex items-end gap-4 md:gap-6 pb-2 pt-6 relative h-[250px]">
            {/* Dotted Grid lines */}
            <div className="absolute inset-0 flex flex-col justify-between pointer-events-none opacity-10 pt-6">
              <div className="border-t border-dashed border-primary"></div>
              <div className="border-t border-dashed border-primary"></div>
              <div className="border-t border-dashed border-primary"></div>
              <div className="border-t border-dashed border-primary"></div>
            </div>

            {/* Render bars */}
            {barData[timeRange].map((bar, idx) => (
              <div 
                key={idx} 
                className="flex-1 flex flex-col items-center h-full justify-end group relative cursor-pointer"
              >
                {/* Floating tooltip on hover */}
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 bg-primary-container text-white text-[10px] px-2 py-1 rounded opacity-0 group-hover:opacity-100 transition-opacity z-10 shadow whitespace-nowrap">
                  {bar.value.toLocaleString()} bultos
                </div>

                {/* Animated bar column */}
                <div 
                  className={`w-full rounded-t-sm transition-all duration-700 ease-out ${bar.height} ${
                    bar.current 
                      ? 'bg-primary shadow-lg ring-2 ring-primary/20' 
                      : 'bg-primary/20 hover:bg-primary/40'
                  }`}
                />
                
                {/* Day label */}
                <span className="text-[10px] font-bold text-on-surface-variant uppercase mt-2 tracking-wider">
                  {bar.day}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Global KPIs Sidebar */}
        <div className="glass-card p-5 rounded-xl flex flex-col justify-between">
          <div>
            <h3 className="text-lg font-bold mb-4">Índice de Cumplimiento</h3>
            <div className="space-y-4">
              {/* Row 1 */}
              <div>
                <div className="flex justify-between items-center text-xs font-bold mb-1">
                  <span>O1: Integridad de Datos</span>
                  <span className="text-emerald-600 font-bold">99.9%</span>
                </div>
                <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                  <div className="h-full bg-emerald-500 rounded-full" style={{ width: '99.9%' }}></div>
                </div>
              </div>

              {/* Row 2 */}
              <div>
                <div className="flex justify-between items-center text-xs font-bold mb-1">
                  <span>O2: Tiempo de Validación SAT</span>
                  <span>2.4m</span>
                </div>
                <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full" style={{ width: '85%' }}></div>
                </div>
              </div>

              {/* Row 3 */}
              <div>
                <div className="flex justify-between items-center text-xs font-bold mb-1">
                  <span>O3: Precisión de Riesgo</span>
                  <span>96.4%</span>
                </div>
                <div className="h-1.5 bg-surface-container-high rounded-full overflow-hidden">
                  <div className="h-full bg-primary rounded-full" style={{ width: '96.4%' }}></div>
                </div>
              </div>

              {/* Row 4 */}
              <div>
                <div className="flex justify-between items-center text-xs font-semibold mb-1 text-error">
                  <span>O4: Tasa de Discrepancias</span>
                  <span>0.4%</span>
                </div>
                <div className="h-1.5 bg-error-container rounded-full overflow-hidden">
                  <div className="h-full bg-error rounded-full" style={{ width: '15%' }}></div>
                </div>
              </div>
            </div>
          </div>

          <div className="pt-6 border-t border-outline-variant mt-4">
            <button 
              onClick={() => onNavigateToTab('riskAnalysis')}
              className="w-full flex items-center justify-between p-3 border border-outline hover:border-primary rounded hover:bg-surface-container-low transition-colors group"
            >
              <span className="text-xs font-bold text-primary">Reporte Completo de Cumplimiento</span>
              <ArrowRight className="w-4 h-4 text-primary group-hover:translate-x-1 transition-transform" />
            </button>
          </div>
        </div>
      </div>

      {/* Recents Table Panel */}
      <div className="glass-card rounded-xl overflow-hidden shadow-sm">
        <div className="p-5 border-b border-outline-variant bg-surface-container-low/50 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h3 className="text-lg font-bold">Actividades Recientes de Manifiestos</h3>
            <p className="text-xs text-on-surface-variant">Haga clic en el código de referencia para abrir la inspección de cumplimiento</p>
          </div>
          {/* Search Box */}
          <div className="relative w-full sm:w-72">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-outline" />
            <input
              type="text"
              value={searchTerm}
              onChange={e => setSearchTerm(e.target.value)}
              placeholder="Buscar manifiesto, agente, ruta..."
              className="w-full pl-9 pr-4 py-1.5 bg-white border border-outline-variant rounded focus:border-primary focus:ring-1 focus:ring-primary text-xs outline-none"
            />
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead className="bg-surface-container-low font-table-header text-table-header uppercase tracking-wider text-on-surface-variant border-b border-outline-variant">
              <tr>
                <th className="px-6 py-3 text-xs font-semibold">ID Ref</th>
                <th className="px-6 py-3 text-xs font-semibold">Origen / Destino</th>
                <th className="px-6 py-3 text-xs font-semibold">Bultos / Items</th>
                <th className="px-6 py-3 text-xs font-semibold">Agente Asignado</th>
                <th className="px-6 py-3 text-xs font-semibold">Estatus</th>
                <th className="px-6 py-3 text-xs font-semibold">Marca de Tiempo</th>
                <th className="px-6 py-3 text-xs font-semibold text-right">Acciones</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-outline-variant text-[13px] font-medium">
              {filteredActivities.length === 0 ? (
                <tr>
                   <td colSpan={7} className="px-6 py-8 text-center text-on-surface-variant">
                     No se encontraron registros de manifiestos.
                   </td>
                </tr>
              ) : (
                filteredActivities.map((activity) => (
                  <tr 
                    key={activity.id} 
                    className={`hover:bg-surface-container-low/60 transition-colors ${
                      activity.status === 'RECHAZADO' ? 'bg-error-container/5' : ''
                    }`}
                  >
                    <td className="px-6 py-4 font-mono font-bold text-primary">
                      <button 
                        onClick={() => {
                          // Handle route lookup - usually redirect to Manifest view or click inspection
                          if (activity.id === 'CA-2024-00994') {
                            onNavigateToTab('manifests');
                          } else {
                            onSelectManifest(activity.id);
                          }
                        }}
                        className="hover:underline text-left text-primary"
                      >
                        {activity.id}
                      </button>
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-1.5">
                        <span className="font-bold">{activity.origin}</span>
                        <ChevronRight className="w-3.5 h-3.5 text-outline" />
                        <span className="font-bold">{activity.destination}</span>
                      </div>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs">{activity.items}</td>
                    <td className="px-6 py-4 text-on-surface-variant">{activity.assignedAgent}</td>
                    <td className="px-6 py-4">
                      <span className={`px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                        activity.status === 'VALIDADO' 
                          ? 'bg-emerald-100 text-emerald-800' 
                          : activity.status === 'EN COLA' 
                          ? 'bg-surface-container-highest text-on-surface-variant' 
                          : activity.status === 'RECHAZADO' 
                          ? 'bg-error text-white' 
                          : 'bg-blue-100 text-blue-800'
                      }`}>
                        {activity.status}
                      </span>
                    </td>
                    <td className="px-6 py-4 font-mono text-xs opacity-80">{activity.timestamp}</td>
                    <td className="px-6 py-4 text-right">
                      <button 
                        onClick={() => onSelectManifest(activity.id)}
                        className="text-primary hover:underline font-bold text-xs"
                      >
                        Auditar
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Bottom Hub Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Card Left */}
        <div className="glass-card p-6 rounded-xl flex items-start gap-4 border-l-4 border-l-emerald-500 hover:shadow-md transition-shadow">
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-full">
            <Upload className="w-6 h-6" />
          </div>
          <div>
            <h4 className="font-bold text-sm">Nueva Declaración Aduanal</h4>
            <p className="text-xs text-on-surface-variant mt-1 mb-3">
              Cargue manifiestos masivos en formato XML o JSON para validación automática SAT/ANAM.
            </p>
            <button 
              onClick={onAddDeclaration}
              className="text-xs font-bold text-primary hover:underline flex items-center gap-1"
            >
              <span>Ir a Cargar Manifiesto</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        </div>

        {/* Card Right */}
        <div className="glass-card p-6 rounded-xl flex items-start gap-4 border-l-4 border-l-error hover:shadow-md transition-shadow">
          <div className="p-3 bg-red-50 text-error rounded-full">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div>
            <h4 className="font-bold text-sm">Reporte de Riesgo Preventivo</h4>
            <p className="text-xs text-on-surface-variant mt-1 mb-3">
              Análisis heurístico de consignatarios y HTS restringidos para evitar multas operativas.
            </p>
            <button 
              onClick={() => onNavigateToTab('riskAnalysis')}
              className="text-xs font-bold text-error hover:underline flex items-center gap-1"
            >
              <span>Ver Reporte de Riesgo</span>
              <ExternalLink className="w-3 h-3" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
