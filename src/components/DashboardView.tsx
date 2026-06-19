/**
 * DashboardView — T1 Operational Metrics
 *
 * Real-time KPIs for courier T1 operations:
 *   - Guías T1 Pendientes
 *   - % Prevalidación Exitosa
 *   - Violaciones RRNA Detectadas
 *   - Utilización del Límite de Valor
 *   - Desglose de Tasas Globales (33.5% vs 19%)
 *   - Exenciones De Minimis
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import type { Section } from '../nav';
import {
  TrendingUp,
  Clock,
  AlertTriangle,
  Plane,
  CheckCircle,
  ShieldAlert,
  ArrowRight,
  Package,
  DollarSign,
  Percent,
  Zap,
} from 'lucide-react';
import { useT1 } from '../context/T1Context';
import { getCountryName } from '../utils/formatters';

export default function DashboardView({ onNavigate: _onNavigate }: { onNavigate?: (s: Section) => void } = {}) {
  const { state } = useT1();
  const { manifest, tax, compliance } = state;
  const shipments = manifest.shipments;

  // -------------------------------------------------------------------------
  // Derived metrics
  // -------------------------------------------------------------------------

  const metrics = useMemo(() => {
    const total = shipments.length;
    const valid = shipments.filter((s) => s.status === 'VALID').length;
    const blocked = shipments.filter(
      (s) => s.status !== 'VALID' && s.status !== 'PENDING'
    ).length;
    const pending = shipments.filter((s) => s.status === 'PENDING').length;
    const totalValue = shipments.reduce((sum, s) => sum + s.declaredValueUsd, 0);

    // De minimis count
    const deMinimis = shipments.filter((s) => s.declaredValueUsd <= 50).length;

    // USMCA eligible count
    const usmca = shipments.filter(
      (s) =>
        ['US', 'CA', 'USA', 'CAN'].includes(s.originCountry.toUpperCase()) &&
        s.declaredValueUsd > 117
    ).length;

    // Standard global rate count
    const standard = shipments.filter(
      (s) =>
        !['US', 'CA', 'USA', 'CAN'].includes(s.originCountry.toUpperCase()) &&
        s.declaredValueUsd > 50
    ).length;

    // Prevalidation success rate
    const prevalidationRate =
      compliance?.canProceed !== null
        ? compliance?.canProceed
          ? 100
          : Math.max(0, 100 - (compliance?.summary.blocking || 0) * 15)
        : 0;

    // Consignees near threshold
    const consigneeValues = new Map<string, number>();
    for (const s of shipments) {
      const rfc = s.consigneeRfc.toUpperCase().trim();
      consigneeValues.set(rfc, (consigneeValues.get(rfc) || 0) + s.declaredValueUsd);
    }
    const nearThreshold = Array.from(consigneeValues.values()).filter(
      (v) => v > 2000 && v <= 2500
    ).length;

    return {
      total,
      valid,
      blocked,
      pending,
      totalValue,
      deMinimis,
      usmca,
      standard,
      prevalidationRate,
      nearThreshold,
    };
  }, [shipments, compliance]);

  // Origin distribution for chart
  const originDist = useMemo(() => {
    const map = new Map<string, number>();
    for (const s of shipments) {
      map.set(s.originCountry, (map.get(s.originCountry) || 0) + 1);
    }
    return Array.from(map.entries())
      .map(([code, count]) => ({ code, name: getCountryName(code), count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);
  }, [shipments]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Metric cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard
          label="Guías T1"
          value={metrics.total}
          sub={`${metrics.valid} válidas / ${metrics.blocked} bloqueadas`}
          icon={<Package className="w-5 h-5" />}
          trend={metrics.total > 0 ? `+${metrics.valid} listas` : 'Sin manifiesto'}
          color="primary"
        />
        <MetricCard
          label="% Prevalidación"
          value={`${Math.round(metrics.prevalidationRate)}%`}
          sub={compliance?.canProceed ? 'Aprobado para T1' : compliance ? 'Con bloqueantes' : 'Pendiente'}
          icon={<CheckCircle className="w-5 h-5" />}
          trend="Target: 100%"
          color="emerald"
        />
        <MetricCard
          label="Violaciones RRNA"
          value={metrics.blocked}
          sub={metrics.blocked > 0 ? 'Requieren acción inmediata' : 'Sin violaciones'}
          icon={<AlertTriangle className="w-5 h-5" />}
          trend={metrics.blocked > 0 ? '🔴 Crítico' : '✅ Limpio'}
          color="red"
        />
        <MetricCard
          label="Cerca del Límite"
          value={metrics.nearThreshold}
          sub="Consignatarios >$2,000 USD"
          icon={<DollarSign className="w-5 h-5" />}
          trend="Máx $2,500/consignatario"
          color="amber"
        />
      </div>

      {/* Main charts area */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Tax rate breakdown */}
        <div className="lg:col-span-2 bg-white border border-outline-variant p-5 rounded-xl shadow-sm">
          <div className="flex justify-between items-center mb-4">
            <div>
              <h3 className="text-lg font-bold">Desglose de Tasas Globales Aplicadas</h3>
              <p className="text-xs text-on-surface-variant">
                Distribución por régimen fiscal según origen y valor (RGCE 3.7.35)
              </p>
            </div>
          </div>

          {shipments.length === 0 ? (
            <div className="h-[250px] flex items-center justify-center text-on-surface-variant text-sm">
              Cargue un manifiesto T1 para visualizar el desglose de tasas.
            </div>
          ) : (
            <div className="space-y-4">
              {/* De Minimis bar */}
              <div>
                <div className="flex justify-between items-center text-xs font-bold mb-1">
                  <span className="flex items-center gap-1.5">
                    <Zap className="w-3.5 h-3.5 text-emerald-500" />
                    De Minimis Exento (≤$50 USD)
                  </span>
                  <span className="text-emerald-600">{metrics.deMinimis} guías</span>
                </div>
                <div className="h-3 bg-surface-container-high rounded-full overflow-hidden">
                  <div
                    className="h-full bg-emerald-500 rounded-full transition-all duration-500"
                    style={{ width: `${metrics.total > 0 ? (metrics.deMinimis / metrics.total) * 100 : 0}%` }}
                  />
                </div>
              </div>

              {/* USMCA bar */}
              <div>
                <div className="flex justify-between items-center text-xs font-bold mb-1">
                  <span className="flex items-center gap-1.5">
                    <Plane className="w-3.5 h-3.5 text-blue-500" />
                    USMCA Preferencial (19%)
                  </span>
                  <span className="text-blue-600">{metrics.usmca} guías</span>
                </div>
                <div className="h-3 bg-surface-container-high rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-500"
                    style={{ width: `${metrics.total > 0 ? (metrics.usmca / metrics.total) * 100 : 0}%` }}
                  />
                </div>
              </div>

              {/* Standard bar */}
              <div>
                <div className="flex justify-between items-center text-xs font-bold mb-1">
                  <span className="flex items-center gap-1.5">
                    <Percent className="w-3.5 h-3.5 text-red-500" />
                    Tasa Global Estándar (33.5%)
                  </span>
                  <span className="text-red-600">{metrics.standard} guías</span>
                </div>
                <div className="h-3 bg-surface-container-high rounded-full overflow-hidden">
                  <div
                    className="h-full bg-red-500 rounded-full transition-all duration-500"
                    style={{ width: `${metrics.total > 0 ? (metrics.standard / metrics.total) * 100 : 0}%` }}
                  />
                </div>
              </div>

              {/* Total liquidation */}
              <div className="pt-3 border-t border-outline-variant/30 flex justify-between items-center">
                <span className="text-sm font-bold text-primary">Liquidación Total Estimada</span>
                <span className="text-lg font-black text-primary">
                  ${tax.globalTotals.totalLiquidacion.toLocaleString('es-MX', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Origin distribution */}
        <div className="bg-white border border-outline-variant p-5 rounded-xl shadow-sm">
          <h3 className="text-lg font-bold mb-4">Distribución por Origen</h3>
          {originDist.length === 0 ? (
            <div className="h-[200px] flex items-center justify-center text-on-surface-variant text-sm">
              Sin datos de origen.
            </div>
          ) : (
            <div className="space-y-3">
              {originDist.map((o) => (
                <div key={o.code}>
                  <div className="flex justify-between items-center text-xs font-bold mb-1">
                    <span>{o.name}</span>
                    <span className="text-on-surface-variant">{o.count} guías</span>
                  </div>
                  <div className="h-2 bg-surface-container-high rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary rounded-full transition-all duration-500"
                      style={{ width: `${(o.count / metrics.total) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="pt-4 border-t border-outline-variant mt-4">
            <div className="space-y-2">
              <div className="flex justify-between text-xs">
                <span className="text-on-surface-variant">Tipo de cambio SAT:</span>
                <span className="font-bold">${state.tax.exchangeRate.toFixed(2)} MXN/USD</span>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-on-surface-variant">Modalidad:</span>
                <span className="font-bold">{manifest.transportMode === 'AIR' ? 'Aérea' : 'Terrestre'}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Quick actions */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white border border-outline-variant p-6 rounded-xl flex items-start gap-4 border-l-4 border-l-emerald-500 hover:shadow-md transition-shadow">
          <div className="p-3 bg-emerald-50 text-emerald-600 rounded-full">
            <Package className="w-6 h-6" />
          </div>
          <div>
            <h4 className="font-bold text-sm">Nuevo Manifiesto T1</h4>
            <p className="text-xs text-on-surface-variant mt-1 mb-3">
              Cargue manifiestos de mensajería para validación automática RGCE 3.7.3 / 3.7.5.
            </p>
          </div>
        </div>

        <div className="bg-white border border-outline-variant p-6 rounded-xl flex items-start gap-4 border-l-4 border-l-red-500 hover:shadow-md transition-shadow">
          <div className="p-3 bg-red-50 text-red-600 rounded-full">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div>
            <h4 className="font-bold text-sm">Revisión RRNA</h4>
            <p className="text-xs text-on-surface-variant mt-1 mb-3">
              {metrics.blocked > 0
                ? `${metrics.blocked} guías bloqueadas por regulaciones no arancelarias.`
                : 'Sin violaciones RRNA detectadas en el manifiesto actual.'}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricCard({
  label,
  value,
  sub,
  icon,
  trend,
  color,
}: {
  label: string;
  value: string | number;
  sub: string;
  icon: ReactNode;
  trend: string;
  color: string;
}) {
  const colorMap: Record<string, { iconBg: string; iconText: string; border: string }> = {
    primary: { iconBg: 'bg-primary/10', iconText: 'text-primary', border: 'border-l-primary' },
    emerald: { iconBg: 'bg-emerald-50', iconText: 'text-emerald-600', border: 'border-l-emerald-500' },
    red: { iconBg: 'bg-red-50', iconText: 'text-red-600', border: 'border-l-red-500' },
    amber: { iconBg: 'bg-amber-50', iconText: 'text-amber-600', border: 'border-l-amber-500' },
  };
  const c = colorMap[color] || colorMap.primary;

  return (
    <div className={`glass-card p-5 rounded-xl flex flex-col gap-2 hover:shadow-md transition-shadow border-l-4 ${c.border}`}>
      <div className="flex justify-between items-start">
        <p className="text-xs font-semibold uppercase tracking-wider text-on-primary-container">{label}</p>
        <div className={`p-1.5 rounded-full ${c.iconBg} ${c.iconText}`}>{icon}</div>
      </div>
      <p className="text-3xl font-bold tracking-tight">{value}</p>
      <p className="text-[10px] text-on-surface-variant font-medium">{sub}</p>
      <p className={`text-[10px] font-bold ${color === 'red' ? 'text-red-600' : 'text-emerald-600'}`}>{trend}</p>
    </div>
  );
}
