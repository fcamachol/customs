/**
 * T1ComplianceView — T1 Shipment Registry & Audit
 *
 * Comprehensive view of all T1 shipments with:
 *   - Detailed data table (guía, consignatario, RFC, origen, valor, UOM, código genérico, tasa, liquidación)
 *   - Filtering by status, origin country, RRNA category
 *   - Search by RFC, consignee name, guide ID
 *   - Consignee aggregation panel (detect fractional shipments)
 *   - Bulk actions
 */

import { useState, useMemo } from 'react';
import type { ReactNode } from 'react';
import {
  Search,
  Filter,
  Download,
  CheckCircle,
  AlertTriangle,
  Ban,
  ArrowRightLeft,
  Users,
  FileText,
  TrendingUp,
  X,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { useT1 } from '../context/T1Context';
import { T1Shipment, ShipmentStatus } from '../types/t1';
import { getCountryName, formatUSD, formatMXN } from '../utils/formatters';
import { getRecommendedAction } from '../engine/t1Compliance';
import { RRNA_LABELS } from '../constants/rrnaCategories';

interface Props {
  onToast: (msg: string) => void;
}

type FilterTab = 'ALL' | 'VALID' | 'BLOCKING' | 'BY_CONSIGNEE';

export default function T1ComplianceView({ onToast }: Props) {
  const { state } = useT1();
  const { manifest, tax, compliance } = state;
  const shipments = manifest.shipments;

  const [searchTerm, setSearchTerm] = useState('');
  const [filterTab, setFilterTab] = useState<FilterTab>('ALL');
  const [selectedOrigin, setSelectedOrigin] = useState<string>('ALL');
  const [selectedStatus, setSelectedStatus] = useState<ShipmentStatus | 'ALL'>('ALL');

  // -------------------------------------------------------------------------
  // Derived data
  // -------------------------------------------------------------------------

  const origins = useMemo(() => {
    const set = new Set(shipments.map((s) => s.originCountry));
    return Array.from(set).sort();
  }, [shipments]);

  const filteredShipments = useMemo(() => {
    let result = [...shipments];

    // Search
    if (searchTerm) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (s) =>
          s.guideId.toLowerCase().includes(term) ||
          s.consigneeName.toLowerCase().includes(term) ||
          s.consigneeRfc.toLowerCase().includes(term) ||
          s.description.toLowerCase().includes(term) ||
          s.genericHsCode?.toLowerCase().includes(term)
      );
    }

    // Origin filter
    if (selectedOrigin !== 'ALL') {
      result = result.filter((s) => s.originCountry === selectedOrigin);
    }

    // Status filter
    if (selectedStatus !== 'ALL') {
      result = result.filter((s) => s.status === selectedStatus);
    }

    // Tab filter
    if (filterTab === 'VALID') {
      result = result.filter((s) => s.status === 'VALID');
    } else if (filterTab === 'BLOCKING') {
      result = result.filter((s) => s.status !== 'VALID' && s.status !== 'PENDING');
    }

    return result;
  }, [shipments, searchTerm, selectedOrigin, selectedStatus, filterTab]);

  // Consignee aggregation
  const consigneeGroups = useMemo(() => {
    const map = new Map<string, T1Shipment[]>();
    for (const s of shipments) {
      const key = s.consigneeRfc.toUpperCase().trim();
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries())
      .map(([rfc, group]) => ({
        rfc,
        name: group[0].consigneeName,
        count: group.length,
        totalValue: group.reduce((sum, s) => sum + s.declaredValueUsd, 0),
        hasBlocking: group.some((s) => s.status !== 'VALID' && s.status !== 'PENDING'),
        isFractional: group.length >= 3 && group.reduce((sum, s) => sum + s.declaredValueUsd, 0) > 2500,
      }))
      .sort((a, b) => b.totalValue - a.totalValue);
  }, [shipments]);

  // Stats
  const stats = useMemo(() => {
    const total = shipments.length;
    const valid = shipments.filter((s) => s.status === 'VALID').length;
    const blocked = shipments.filter((s) => s.status !== 'VALID' && s.status !== 'PENDING').length;
    const pending = shipments.filter((s) => s.status === 'PENDING').length;
    const totalValue = shipments.reduce((sum, s) => sum + s.declaredValueUsd, 0);
    return { total, valid, blocked, pending, totalValue };
  }, [shipments]);

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------

  const exportCSV = () => {
    const headers = [
      'Guia', 'Consignatario', 'RFC', 'Descripcion', 'Valor_USD', 'Cantidad', 'UOM',
      'Peso_Kg', 'Origen', 'Codigo_Generico', 'Tasa_Aplicada', 'IGI_MXN', 'IVA_MXN',
      'DTA_MXN', 'Total_Liquidacion_MXN', 'Estado_T1', 'RRNA_Flags',
    ];
    const rows = filteredShipments.map((s) => [
      s.guideId,
      `"${s.consigneeName.replace(/"/g, '""')}"`,
      s.consigneeRfc,
      `"${s.description.replace(/"/g, '""')}"`,
      s.declaredValueUsd.toString(),
      s.quantity.toString(),
      s.unit,
      s.weightKg.toString(),
      s.originCountry,
      s.genericHsCode || '',
      s.taxBreakdown ? `${(s.taxBreakdown.applicableRate * 100).toFixed(1)}%` : 'N/A',
      s.taxBreakdown ? s.taxBreakdown.igi.toString() : '0',
      s.taxBreakdown ? s.taxBreakdown.iva.toString() : '0',
      s.taxBreakdown ? s.taxBreakdown.dta.toString() : '0',
      s.taxBreakdown ? s.taxBreakdown.total.toString() : '0',
      s.status,
      `"${s.rrnaFlags.join(', ')}"`,
    ]);
    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `T1_SHIPMENTS_${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
    onToast('📥 CSV exportado');
  };

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white border border-outline-variant p-6 rounded-xl flex flex-col md:flex-row justify-between items-start md:items-center shadow-sm gap-4">
          <div className="space-y-2">
            <span className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block">
              REGISTRO T1 — EMPRESAS DE MENSAJERÍA Y PAQUETERÍA
            </span>
            <h3 className="text-2xl font-black text-primary tracking-tight">
              {stats.total} Guías Registradas
            </h3>
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-primary bg-surface-container/60 border border-outline-variant/30 px-2.5 py-1 rounded">
                <FileText className="w-3.5 h-3.5 text-secondary" />
                <span>MAWB: {manifest.mawbReference || 'N/A'}</span>
              </span>
              <span className="inline-flex items-center gap-1 text-[11px] font-bold text-primary bg-surface-container/60 border border-outline-variant/30 px-2.5 py-1 rounded">
                <TrendingUp className="w-3.5 h-3.5 text-secondary" />
                <span>Total: {formatUSD(stats.totalValue)}</span>
              </span>
            </div>
          </div>
          <div className="shrink-0 flex gap-2">
            <button
              onClick={exportCSV}
              className="bg-primary text-on-primary hover:opacity-90 px-4 py-3 rounded-lg font-bold text-xs flex items-center justify-center gap-2 transition-all active:scale-95 cursor-pointer whitespace-nowrap"
            >
              <Download className="w-4 h-4" />
              <span>Exportar CSV</span>
            </button>
          </div>
        </div>

        {/* Global stats */}
        <div className="bg-white border border-outline-variant p-6 rounded-xl relative overflow-hidden flex flex-col justify-center shadow-sm">
          <div className="absolute -right-4 -bottom-4 opacity-5 pointer-events-none">
            <CheckCircle className="w-32 h-32 text-primary" />
          </div>
          <span className="text-[10px] font-bold text-on-surface-variant uppercase tracking-widest block mb-1">
            ESTADO GENERAL
          </span>
          <div className="flex items-baseline gap-1.5 pt-1">
            <h4 className="text-[34px] font-black leading-none text-primary">
              {stats.total > 0 ? Math.round((stats.valid / stats.total) * 100) : 0}%
            </h4>
            <p className="text-xs font-bold text-on-surface-variant">Válidas T1</p>
          </div>
          <div className="w-full bg-surface-container-high h-2 rounded-full mt-4">
            <div
              className="bg-emerald-500 h-full rounded-full"
              style={{ width: `${stats.total > 0 ? (stats.valid / stats.total) * 100 : 0}%` }}
            />
          </div>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <MetricCard
          label="Aprobadas T1"
          value={stats.valid}
          color="emerald"
          icon={<CheckCircle className="w-5 h-5" />}
          onClick={() => setFilterTab('VALID')}
          active={filterTab === 'VALID'}
        />
        <MetricCard
          label="Bloqueadas"
          value={stats.blocked}
          color="red"
          icon={<Ban className="w-5 h-5" />}
          onClick={() => setFilterTab('BLOCKING')}
          active={filterTab === 'BLOCKING'}
        />
        <MetricCard
          label="Pendientes"
          value={stats.pending}
          color="slate"
          icon={<AlertTriangle className="w-5 h-5" />}
          onClick={() => setFilterTab('ALL')}
          active={filterTab === 'ALL'}
        />
        <MetricCard
          label="Consignatarios"
          value={consigneeGroups.length}
          color="indigo"
          icon={<Users className="w-5 h-5" />}
          onClick={() => setFilterTab('BY_CONSIGNEE')}
          active={filterTab === 'BY_CONSIGNEE'}
        />
      </div>

      {/* Filters */}
      <div className="bg-white border border-outline-variant rounded-xl p-4 shadow-sm flex flex-wrap gap-3 items-center">
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-outline absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Buscar guía, RFC, consignatario..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="pl-8 pr-3 py-1.5 bg-white border border-outline-variant rounded text-xs outline-none focus:border-primary w-64"
          />
        </div>

        <select
          value={selectedOrigin}
          onChange={(e) => setSelectedOrigin(e.target.value)}
          className="px-3 py-1.5 bg-white border border-outline-variant rounded text-xs outline-none focus:border-primary"
        >
          <option value="ALL">Todos los países</option>
          {origins.map((o) => (
            <option key={o} value={o}>{getCountryName(o)} ({o})</option>
          ))}
        </select>

        <select
          value={selectedStatus}
          onChange={(e) => setSelectedStatus(e.target.value as ShipmentStatus | 'ALL')}
          className="px-3 py-1.5 bg-white border border-outline-variant rounded text-xs outline-none focus:border-primary"
        >
          <option value="ALL">Todos los estados</option>
          <option value="VALID">Válida T1</option>
          <option value="EXCEEDS_THRESHOLD">Excede $2,500</option>
          <option value="RRNA_BLOCKED">RRNA Bloqueada</option>
          <option value="FRACTIONAL_FLAG">Fraccionado</option>
          <option value="ZERO_VALUE_BLOCKED">Valor Cero</option>
          <option value="GENERIC_DESC_BLOCKED">Desc. Genérica</option>
          <option value="PENDING">Pendiente</option>
        </select>

        {(searchTerm || selectedOrigin !== 'ALL' || selectedStatus !== 'ALL' || filterTab !== 'ALL') && (
          <button
            onClick={() => {
              setSearchTerm('');
              setSelectedOrigin('ALL');
              setSelectedStatus('ALL');
              setFilterTab('ALL');
            }}
            className="text-[11px] font-bold text-secondary hover:text-primary flex items-center gap-1"
          >
            <X className="w-3 h-3" />
            Limpiar filtros
          </button>
        )}

        <span className="text-xs font-semibold text-on-surface-variant ml-auto">
          Mostrando {filteredShipments.length} de {shipments.length}
        </span>
      </div>

      {/* Consignee aggregation view */}
      {filterTab === 'BY_CONSIGNEE' && (
        <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
          <div className="p-4 border-b border-outline-variant bg-surface-container-low/40">
            <h3 className="font-bold text-primary text-sm flex items-center gap-2">
              <Users className="w-4 h-4" />
              Agregación por Consignatario — Detección de Fraccionamiento
            </h3>
            <p className="text-xs text-on-surface-variant mt-1">
              Grupo con {'≥'}3 envíos y total {'>$2,500'} USD = posible fraccionamiento (RGCE 3.7.5-C)
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead className="bg-surface-container-high text-on-surface-variant border-b border-outline-variant">
                <tr>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase">RFC</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase">Nombre</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase text-center">Envíos</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase text-right">Total USD</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase text-center">Fraccionado</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase text-center">Bloqueos</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant text-xs font-sans">
                {consigneeGroups.map((g) => (
                  <tr key={g.rfc} className={`hover:bg-surface-container-low transition-colors ${g.isFractional ? 'bg-amber-50/30' : ''}`}>
                    <td className="px-4 py-3 font-mono font-bold text-primary">{g.rfc}</td>
                    <td className="px-4 py-3">{g.name}</td>
                    <td className="px-4 py-3 text-center font-bold">{g.count}</td>
                    <td className="px-4 py-3 text-right font-mono font-bold">${g.totalValue.toFixed(2)}</td>
                    <td className="px-4 py-3 text-center">
                      {g.isFractional ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[10px] font-extrabold">
                          <AlertTriangle className="w-3 h-3" />
                          Sospecha
                        </span>
                      ) : (
                        <span className="text-[10px] text-emerald-600 font-bold">No</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center">
                      {g.hasBlocking ? (
                        <span className="px-2 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-extrabold">Sí</span>
                      ) : (
                        <span className="text-[10px] text-emerald-600 font-bold">No</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Shipment table */}
      {filterTab !== 'BY_CONSIGNEE' && (
        <div className="bg-white border border-outline-variant rounded-xl overflow-hidden shadow-sm">
          <div className="overflow-x-auto custom-scrollbar">
            <table className="w-full text-left border-collapse min-w-[1100px]">
              <thead className="bg-surface-container-high text-on-surface-variant border-b border-outline-variant">
                <tr>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase">Guía</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase">Consignatario</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase">RFC</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase">Descripción</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase text-right">Valor USD</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase">UOM</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase">Cód. Genérico</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase">Origen</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase text-right">Liquidación MXN</th>
                  <th className="px-4 py-3 text-[11px] font-semibold uppercase text-center">Estado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-outline-variant text-[12px] font-sans">
                {filteredShipments.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-4 py-8 text-center text-on-surface-variant">
                      No se encontraron guías con los filtros aplicados.
                    </td>
                  </tr>
                ) : (
                  filteredShipments.map((s) => (
                    <tr
                      key={s.id}
                      className={`hover:bg-surface-container-low transition-colors ${
                        s.status !== 'VALID' && s.status !== 'PENDING' ? 'bg-red-50/10' : ''
                      }`}
                    >
                      <td className="px-4 py-3 font-mono font-bold text-primary">{s.guideId}</td>
                      <td className="px-4 py-3 max-w-[140px] truncate">{s.consigneeName}</td>
                      <td className="px-4 py-3 font-mono text-[10px] text-secondary">{s.consigneeRfc}</td>
                      <td className="px-4 py-3 max-w-[200px] truncate text-on-surface-variant">{s.description}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold">{formatUSD(s.declaredValueUsd)}</td>
                      <td className="px-4 py-3">{s.unit}</td>
                      <td className="px-4 py-3 font-mono text-[10px] text-secondary">{s.genericHsCode}</td>
                      <td className="px-4 py-3">{getCountryName(s.originCountry)}</td>
                      <td className="px-4 py-3 text-right font-mono font-bold">
                        {s.taxBreakdown ? formatMXN(s.taxBreakdown.total) : '$0.00'}
                        {s.taxBreakdown && s.taxBreakdown.applicableRate > 0 && (
                          <span className="text-[9px] text-on-surface-variant ml-1">
                            ({(s.taxBreakdown.applicableRate * 100).toFixed(1)}%)
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <StatusTag status={s.status} rrnaFlags={s.rrnaFlags} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricCard({
  label,
  value,
  color,
  icon,
  onClick,
  active,
}: {
  label: string;
  value: number;
  color: string;
  icon: ReactNode;
  onClick: () => void;
  active: boolean;
}) {
  const colorMap: Record<string, { border: string; bg: string; text: string; iconBg: string }> = {
    emerald: { border: 'border-l-emerald-500', bg: 'bg-white', text: 'text-emerald-600', iconBg: 'bg-emerald-50 text-emerald-600' },
    red: { border: 'border-l-red-500', bg: 'bg-white', text: 'text-red-600', iconBg: 'bg-red-50 text-red-600' },
    slate: { border: 'border-l-slate-400', bg: 'bg-white', text: 'text-slate-600', iconBg: 'bg-slate-50 text-slate-600' },
    indigo: { border: 'border-l-indigo-500', bg: 'bg-white', text: 'text-indigo-600', iconBg: 'bg-indigo-50 text-indigo-600' },
  };
  const c = colorMap[color];

  return (
    <button
      onClick={onClick}
      className={`text-left border p-5 rounded-xl ${c.border} border-l-4 hover:shadow-md transition-all relative cursor-pointer outline-none ${
        active ? 'ring-2 ring-offset-1 ring-' + color + '-500 shadow-sm' : 'border-outline-variant'
      } ${c.bg}`}
    >
      <div className="flex justify-between items-start mb-3">
        <div>
          <p className="text-[10px] font-bold text-on-surface-variant uppercase tracking-wider">{label}</p>
          <h4 className={`text-3xl font-black mt-1 ${c.text}`}>{value}</h4>
        </div>
        <div className={`p-2 rounded-full ${c.iconBg}`}>{icon}</div>
      </div>
    </button>
  );
}

function StatusTag({ status, rrnaFlags }: { status: string; rrnaFlags: string[] }) {
  if (status === 'VALID') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-emerald-100 text-emerald-800">
        <CheckCircle className="w-3 h-3" />
        VÁLIDA
      </span>
    );
  }
  if (status === 'PENDING') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-slate-100 text-slate-700">
        PENDIENTE
      </span>
    );
  }

  const label =
    status === 'EXCEEDS_THRESHOLD'
      ? '>$2,500'
      : status === 'RRNA_BLOCKED'
      ? 'RRNA'
      : status === 'FRACTIONAL_FLAG'
      ? 'FRACCIONADO'
      : status === 'ZERO_VALUE_BLOCKED'
      ? 'VALOR CERO'
      : status === 'GENERIC_DESC_BLOCKED'
      ? 'DESC. GENÉRICA'
      : 'BLOQUEADA';

  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[9px] font-extrabold bg-red-100 text-red-800">
      <Ban className="w-3 h-3" />
      {label}
    </span>
  );
}
