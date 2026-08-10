/**
 * ConfigurationView — DB-driven catalogs, branding, validation params,
 * validated RFCs, and global-rate vigencias (RF-24 / D3 / D4 / §10).
 *
 * Navigation lives in the global sidebar (collapsible "Configuración" parent); this
 * component renders the single domain selected there, showing its complete view:
 *   · cfg_motor:       Parámetros de validación + Listas de exclusión (V6/V7)
 *   · cfg_clientes:    Clientes (master data)
 *   · cfg_transportistas: Transportistas, flota, convenios y tarifas (R24 / R25-D9)
 *   · cfg_rfcs:        RFCs validados
 *   · cfg_empresa:     Identidad / branding
 *   · cfg_tasa:        Tasa global (vigencias) — Super Admin only
 *   · cfg_entidades:   Importador de registro + agente aduanal — Super Admin only
 * Mutations require an Administrador role; Tasa global and Entidades are reserved
 * for the Super Admin. Non-admins see read-only fields and a notice card.
 */

import { useEffect, useState, type ReactNode } from 'react';
import {
  Tag,
  AlertOctagon,
  Building2,
  Sliders,
  ShieldCheck,
  ScrollText,
  Save,
  Plus,
  Trash2,
  Lock,
  ChevronRight,
  Layers,
  Search,
  Landmark,
  UserCheck,
  RotateCcw,
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiGet, apiPut, apiPost, apiDelete } from '../api';
import { Card, Button, Field, Input, Textarea, Modal, SearchSelect, StatusPill, EmptyState } from './ui';
import { ANAM_COUNTRY_OPTIONS, countryDisplayName } from '../../shared/parsing/catalogs';
import type { ConfigSection } from '../nav';
import type { Client, ClientPlatform } from './AddClientModal';
import { AddClientModal } from './AddClientModal';
import { TransportistasTab } from './TransportistasTab';

interface Props {
  domain: ConfigSection;
  onToast: (msg: string) => void;
  /**
   * Jump to Trazabilidad with a carrier preselected. Optional so every existing test that renders a
   * Configuración pane on its own keeps working; when absent the affordance is simply not offered.
   */
  onVerTrazabilidad?: (transportistaId: string) => void;
}

interface ConfigResponse<T> {
  key: string;
  value: T | null;
}

interface BrandingConfig {
  companyName?: string;
  rfc?: string;
  logoUrl?: string;
}

interface ValidationParams {
  cantidad: number;
  montoMin: number;
  montoMax: number;
  consignatario: number;
  direccion: number;
  importacionesMes: number;
}

interface ValidatedRfc {
  id: string;
  id_ref: string;
  rfc?: string;
  curp?: string;
  name?: string;
}

type OriginType = 'GENERAL' | 'TMEC';
interface TasaVigencia {
  startDate: string;
  originType: OriginType;
  rate: number;
}

interface AgenteAduanal {
  id: string;
  patente: string;
  name: string | null;
  agentRfc: string | null;
  agencyRfc: string | null;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
}

interface Importador {
  id: string;
  rfc: string;
  name: string | null;
  fiscalAddress: string | null;
  verified: boolean;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_PARAMS: ValidationParams = {
  cantidad: 10,
  montoMin: 1,
  montoMax: 2500,
  consignatario: 3,
  direccion: 2,
  importacionesMes: 4,
};

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Error inesperado';
}

export default function ConfigurationView({ domain, onToast, onVerTrazabilidad }: Props) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const isSuperAdmin = user?.role === 'super_admin';
  // Demo-reset card renders only on a DEMO_MODE deployment for an admin/super_admin.
  const demoMode = user?.demoMode === true;

  const [saving, setSaving] = useState(false);

  // Catálogos
  const [prohibitedText, setProhibitedText] = useState('');
  const [brandsText, setBrandsText] = useState('');
  const [clients, setClients] = useState<Client[]>([]);

  // Branding
  const [companyName, setCompanyName] = useState('');
  const [rfc, setRfc] = useState('');
  const [logoUrl, setLogoUrl] = useState('');

  // Parámetros de validación
  const [params, setParams] = useState<ValidationParams>(DEFAULT_PARAMS);

  // RFCs validados
  const [rfcs, setRfcs] = useState<ValidatedRfc[]>([]);

  // Tasa global
  const [vigencias, setVigencias] = useState<TasaVigencia[]>([]);

  // Entidades de pedimento (auto-registradas desde pedimentos)
  const [agentes, setAgentes] = useState<AgenteAduanal[]>([]);
  const [importadores, setImportadores] = useState<Importador[]>([]);

  // Load all config on mount; each fetch is independent and non-fatal.
  useEffect(() => {
    let active = true;
    async function load() {
      await Promise.all([
        apiGet<ConfigResponse<string[]>>('/api/catalogs/config/prohibited')
          .then((r) => { if (active && r.value) setProhibitedText(r.value.join('\n')); })
          .catch(() => {}),
        apiGet<ConfigResponse<string[]>>('/api/catalogs/config/piracy_brands')
          .then((r) => { if (active && r.value) setBrandsText(r.value.join('\n')); })
          .catch(() => {}),
        apiGet<ConfigResponse<BrandingConfig>>('/api/catalogs/config/branding')
          .then((r) => {
            if (active && r.value) {
              setCompanyName(r.value.companyName ?? '');
              setRfc(r.value.rfc ?? '');
              setLogoUrl(r.value.logoUrl ?? '');
            }
          })
          .catch(() => {}),
        apiGet<ConfigResponse<ValidationParams>>('/api/catalogs/config/validation_params')
          .then((r) => { if (active && r.value) setParams({ ...DEFAULT_PARAMS, ...r.value }); })
          .catch(() => {}),
        apiGet<ConfigResponse<TasaVigencia[]>>('/api/catalogs/config/tasa_vigencias')
          .then((r) => { if (active && Array.isArray(r.value)) setVigencias(r.value); })
          .catch(() => {}),
        apiGet<AgenteAduanal[]>('/api/catalogs/agentes-aduanales')
          .then((r) => { if (active && Array.isArray(r)) setAgentes(r); })
          .catch(() => {}),
        apiGet<Importador[]>('/api/catalogs/importadores')
          .then((r) => { if (active && Array.isArray(r)) setImportadores(r); })
          .catch(() => {}),
        apiGet<Client[]>('/api/catalogs/clients')
          .then((r) => { if (active) setClients(r); })
          .catch(() => {}),
        apiGet<ValidatedRfc[]>('/api/catalogs/validated-rfcs')
          .then((r) => { if (active) setRfcs(r); })
          .catch(() => {}),
      ]);
    }
    load();
    return () => { active = false; };
  }, []);

  function refreshClients() {
    apiGet<Client[]>('/api/catalogs/clients').then(setClients).catch(() => {});
  }
  function refreshRfcs() {
    apiGet<ValidatedRfc[]>('/api/catalogs/validated-rfcs').then(setRfcs).catch(() => {});
  }
  function refreshAgentes() {
    apiGet<AgenteAduanal[]>('/api/catalogs/agentes-aduanales').then((r) => { if (Array.isArray(r)) setAgentes(r); }).catch(() => {});
  }
  function refreshImportadores() {
    apiGet<Importador[]>('/api/catalogs/importadores').then((r) => { if (Array.isArray(r)) setImportadores(r); }).catch(() => {});
  }
  // Re-pull the config catalogs after a demo reset so the current view reflects fresh data.
  function refreshAll() {
    refreshClients();
    refreshRfcs();
    refreshAgentes();
    refreshImportadores();
  }

  // --- Catálogos save handlers ---
  async function saveProhibited() {
    if (!isAdmin) return;
    setSaving(true);
    try {
      const value = prohibitedText.split('\n').map((s) => s.trim()).filter(Boolean);
      await apiPut('/api/catalogs/config/prohibited', { value });
      onToast('Lista de prohibidos guardada');
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveBrands() {
    if (!isAdmin) return;
    setSaving(true);
    try {
      const value = brandsText.split('\n').map((s) => s.trim()).filter(Boolean);
      await apiPut('/api/catalogs/config/piracy_brands', { value });
      onToast('Lista de piratería guardada');
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveBranding() {
    if (!isAdmin) return;
    setSaving(true);
    try {
      const value: BrandingConfig = {
        companyName: companyName.trim() || undefined,
        rfc: rfc.trim() || undefined,
        logoUrl: logoUrl.trim() || undefined,
      };
      await apiPut('/api/catalogs/config/branding', { value });
      onToast('Datos de empresa guardados');
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveParams() {
    if (!isAdmin) return;
    setSaving(true);
    try {
      const value: ValidationParams = {
        cantidad: Number(params.cantidad) || 0,
        montoMin: Number(params.montoMin) || 0,
        montoMax: Number(params.montoMax) || 0,
        consignatario: Number(params.consignatario) || 0,
        direccion: Number(params.direccion) || 0,
        importacionesMes: Number(params.importacionesMes) || 0,
      };
      await apiPut('/api/catalogs/config/validation_params', { value });
      onToast('Parámetros de validación guardados');
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function saveVigencias(rows: TasaVigencia[]) {
    if (!isSuperAdmin) return;
    setSaving(true);
    try {
      await apiPut('/api/catalogs/config/tasa_vigencias', { value: rows });
      onToast('Vigencias de tasa global guardadas');
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {!isAdmin && (
        <Card className="flex gap-3 border-amber-200 bg-amber-50 p-4">
          <Lock className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
          <div className="text-sm text-amber-900">
            <p className="font-bold">Configuración restringida — requiere rol Administrador</p>
            <p className="mt-1 text-amber-800">Los campos se muestran en modo solo lectura.</p>
          </div>
        </Card>
      )}

      {/* The selected sidebar destination renders its complete view here. */}
      {domain === 'cfg_motor' && (
        <div className="space-y-6">
          <ParametrosTab isAdmin={isAdmin} saving={saving} params={params} setParams={setParams} onSave={saveParams} />
          <ListasTab
            isAdmin={isAdmin}
            saving={saving}
            prohibitedText={prohibitedText}
            setProhibitedText={setProhibitedText}
            brandsText={brandsText}
            setBrandsText={setBrandsText}
            onSaveProhibited={saveProhibited}
            onSaveBrands={saveBrands}
          />
        </div>
      )}

      {domain === 'cfg_clientes' && (
        <ClientesTab isAdmin={isAdmin} clients={clients} onClientsChanged={refreshClients} onToast={onToast} />
      )}

      {domain === 'cfg_transportistas' && (
        <TransportistasTab isAdmin={isAdmin} onToast={onToast} onVerTrazabilidad={onVerTrazabilidad} />
      )}

      {domain === 'cfg_rfcs' && (
        <RfcsTab isAdmin={isAdmin} rfcs={rfcs} onChanged={refreshRfcs} onToast={onToast} />
      )}

      {domain === 'cfg_empresa' && (
        <BrandingTab
          isAdmin={isAdmin}
          saving={saving}
          companyName={companyName}
          setCompanyName={setCompanyName}
          rfc={rfc}
          setRfc={setRfc}
          logoUrl={logoUrl}
          setLogoUrl={setLogoUrl}
          onSave={saveBranding}
        />
      )}

      {domain === 'cfg_tasa' && (
        <TasaTab
          isSuperAdmin={isSuperAdmin}
          saving={saving}
          vigencias={vigencias}
          setVigencias={setVigencias}
          onSave={saveVigencias}
        />
      )}

      {domain === 'cfg_entidades' && (
        <EntidadesTab
          canEdit={isAdmin}
          agentes={agentes}
          importadores={importadores}
          onAgentesChanged={refreshAgentes}
          onImportadoresChanged={refreshImportadores}
          onToast={onToast}
        />
      )}

      {/* Demo-reset lives at the bottom of every Configuración pane, gated to DEMO_MODE admins. */}
      {demoMode && isAdmin && (
        <DemoResetCard onToast={onToast} onReset={refreshAll} />
      )}
    </div>
  );
}

/* ---------- Modo demostración (DEMO_MODE-gated data reset) ---------- */

interface DeleteCounts {
  manifests: number;
  pedimentos: number;
  shipments: number;
  files: number;
  operaciones: number;
  prealertas: number;
  despachos: number;
  pods: number;
  facturas: number;
}

// Mirrors the route's response — see server/src/routes/admin.ts. Optional because a caller could,
// in principle, be talking to an older server; the UI degrades to the base message rather than throw.
interface DemoResetSuperficies {
  manifiestos: boolean;
  archivos: boolean;
  operaciones: boolean;
  catalogosDurables: boolean;
}

interface DemoResetConservado {
  catalogosDurables: string[];
  transportistas: number;
  convenios: number;
}

interface DemoResetResponse {
  deleted: DeleteCounts;
  superficies?: DemoResetSuperficies;
  conservado?: DemoResetConservado;
}

function DemoResetCard({ onToast, onReset }: { onToast: (msg: string) => void; onReset: () => void }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  // Default UNCHECKED: the pre-PRD-02 behaviour (manifest graph only) stays the one-click default.
  const [incluirOperaciones, setIncluirOperaciones] = useState(false);
  const [busy, setBusy] = useState(false);

  // The destructive action stays disabled until the operator types the exact word.
  const canConfirm = confirmText === 'BORRAR';

  function closeModal() {
    setModalOpen(false);
    setConfirmText('');
  }

  async function handleReset() {
    if (!canConfirm || busy) return;
    setBusy(true);
    try {
      const body = incluirOperaciones ? { incluirOperaciones: true } : {};
      const { deleted, superficies, conservado } = await apiPost<DemoResetResponse>('/api/admin/demo-reset', body);
      const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
      let msg = `🔄 ${plural(deleted.manifests, 'manifiesto')} y ${plural(deleted.pedimentos, 'pedimento')} eliminados.`;
      // Only the wider surface earns the extra sentence — the response says whether it actually ran.
      if (superficies?.operaciones) {
        msg += ` También ${plural(deleted.despachos, 'despacho')}, ${plural(deleted.pods, 'POD')}, ` +
          `${plural(deleted.facturas, 'factura')} y la bitácora de operaciones. Catálogos durables conservados: ` +
          `${plural(conservado?.transportistas ?? 0, 'transportista')}, ${plural(conservado?.convenios ?? 0, 'convenio')}.`;
      }
      onToast(msg);
      closeModal();
      onReset();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="border-amber-300 bg-amber-50/60 p-6 shadow-sm">
      <SectionHeader icon={RotateCcw}>Modo demostración</SectionHeader>
      <p className="mb-4 max-w-2xl text-sm text-amber-900">
        Restablece la base de datos a un estado limpio: elimina <strong>todos los manifiestos y pedimentos</strong> y
        sus archivos asociados para iniciar una demostración desde cero. Los usuarios, clientes, plataformas,
        catálogos y la bitácora de auditoría se conservan. Esta acción no se puede deshacer.
      </p>
      <label className="mb-4 flex items-center gap-2 text-sm text-amber-900">
        <input
          type="checkbox"
          checked={incluirOperaciones}
          onChange={(e) => setIncluirOperaciones(e.target.checked)}
          className="h-4 w-4 rounded border-amber-300 text-navy-700 focus:ring-navy-500/25"
        />
        Incluir operaciones (despachos, PODs, facturas, holds y bitácora)
      </label>
      <button
        type="button"
        onClick={() => setModalOpen(true)}
        className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700"
      >
        <Trash2 className="h-4 w-4" /> Restablecer datos de demostración
      </button>

      <Modal open={modalOpen} onClose={closeModal} title="Restablecer datos de demostración">
        <p className="text-sm text-slate-700">
          Se eliminarán de forma permanente <strong>todos los manifiestos y pedimentos</strong> junto con sus
          envíos, escaneos y archivos. Los usuarios, clientes, catálogos y la bitácora de auditoría se conservan.
        </p>
        {incluirOperaciones && (
          <p className="mt-3 text-sm font-medium text-red-700">
            También se eliminará la bitácora de operaciones (ledger), despachos, PODs, facturas, holds y
            requerimientos vigentes. Los catálogos durables — transportistas, convenios y tarifas — se conservan.
          </p>
        )}
        <p className="mt-3 text-sm text-slate-700">
          Escriba <strong>BORRAR</strong> para confirmar.
        </p>
        <Input
          className="mt-2 font-mono"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder="BORRAR"
          aria-label="Confirmar escribiendo BORRAR"
          autoFocus
        />
        <div className="mt-5 flex items-center justify-end gap-2 border-t border-slate-200 pt-4">
          <Button variant="secondary" type="button" onClick={closeModal} disabled={busy}>
            Cancelar
          </Button>
          <button
            type="button"
            onClick={handleReset}
            disabled={!canConfirm || busy}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Trash2 className="h-4 w-4" /> Eliminar todo
          </button>
        </div>
      </Modal>
    </Card>
  );
}

/* ---------- Shared bits ---------- */

function SectionHeader({ icon: Icon, children }: { icon: typeof Tag; children: ReactNode }) {
  return (
    <h3 className="mb-3 flex items-center gap-2 text-sm font-bold uppercase tracking-wide text-slate-700">
      <Icon className="h-4 w-4 text-navy-700" />
      {children}
    </h3>
  );
}

/* ---------- Listas de exclusión (V6 prohibidos · V7 piratería) ---------- */

interface ListasProps {
  isAdmin: boolean;
  saving: boolean;
  prohibitedText: string;
  setProhibitedText: (v: string) => void;
  brandsText: string;
  setBrandsText: (v: string) => void;
  onSaveProhibited: () => void;
  onSaveBrands: () => void;
}

function ListasTab(props: ListasProps) {
  const {
    isAdmin, saving, prohibitedText, setProhibitedText,
    brandsText, setBrandsText, onSaveProhibited, onSaveBrands,
  } = props;

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="p-6 shadow-sm">
        <SectionHeader icon={AlertOctagon}>Artículos prohibidos (V6)</SectionHeader>
        <p className="mb-2 text-xs text-slate-500">Una palabra clave por línea. Vacío usa la lista predeterminada del motor.</p>
        <Textarea
          rows={8}
          value={prohibitedText}
          onChange={(e) => setProhibitedText(e.target.value)}
          disabled={!isAdmin}
          className="font-mono text-xs disabled:bg-slate-50"
          placeholder={'maquillaje\nliquido\nautoparte'}
        />
        <Button className="mt-3" onClick={onSaveProhibited} disabled={!isAdmin || saving}>
          <Save className="h-4 w-4" /> Guardar
        </Button>
      </Card>

      <Card className="p-6 shadow-sm">
        <SectionHeader icon={Tag}>Marcas de piratería (V7)</SectionHeader>
        <p className="mb-2 text-xs text-slate-500">Una marca por línea. Vacío usa la lista predeterminada del motor.</p>
        <Textarea
          rows={8}
          value={brandsText}
          onChange={(e) => setBrandsText(e.target.value)}
          disabled={!isAdmin}
          className="font-mono text-xs disabled:bg-slate-50"
          placeholder={'Nike\nAdidas\nGucci'}
        />
        <Button className="mt-3" onClick={onSaveBrands} disabled={!isAdmin || saving}>
          <Save className="h-4 w-4" /> Guardar
        </Button>
      </Card>
    </div>
  );
}

/* ---------- Clientes (master data) ---------- */

interface ClientesProps {
  isAdmin: boolean;
  clients: Client[];
  onClientsChanged: () => void;
  onToast: (msg: string) => void;
}

function ClientesTab({ isAdmin, clients, onClientsChanged, onToast }: ClientesProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  // Derive the open client from props so it stays in sync after platform edits refetch.
  const detailClient = detailId ? clients.find((c) => c.id === detailId) ?? null : null;

  const q = search.trim().toLowerCase();
  const filteredClients = q
    ? clients.filter((c) =>
        [c.name, c.tax_id, c.email].some((f) => (f ?? '').toLowerCase().includes(q)),
      )
    : clients;

  function handleCreated() {
    onToast('Cliente agregado');
    onClientsChanged();
  }

  async function removeClient(id: string) {
    if (!isAdmin) return;
    try {
      await apiDelete('/api/catalogs/clients/' + id);
      onToast('Cliente eliminado');
      setDetailId(null);
      onClientsChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  async function addPlatform(clientId: string, p: ClientPlatform) {
    if (!isAdmin) return;
    try {
      await apiPost(`/api/catalogs/clients/${clientId}/platforms`, p);
      onToast('Plataforma agregada');
      onClientsChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  async function editPlatform(clientId: string, pid: string, p: ClientPlatform) {
    if (!isAdmin) return;
    try {
      await apiPut(`/api/catalogs/clients/${clientId}/platforms/${pid}`, p);
      onToast('Plataforma actualizada');
      onClientsChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  async function removePlatform(clientId: string, pid: string) {
    if (!isAdmin) return;
    try {
      await apiDelete(`/api/catalogs/clients/${clientId}/platforms/${pid}`);
      onToast('Plataforma eliminada');
      onClientsChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  return (
    <div className="space-y-6">
      <Card className="p-6 shadow-sm">
        <div className="mb-4 flex items-center gap-3">
          <div className="relative flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
            <Input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre, RFC o email"
              className="pl-10"
            />
          </div>
          {isAdmin && (
            <Button className="shrink-0" onClick={() => setModalOpen(true)}>
              <Plus className="h-4 w-4" /> Agregar cliente
            </Button>
          )}
        </div>

        {clients.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">Sin clientes registrados.</p>
        ) : filteredClients.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">Sin coincidencias para «{search.trim()}».</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Nombre</th>
                  <th className="px-3 py-2 font-semibold">RFC / Tax ID</th>
                  <th className="px-3 py-2 font-semibold">Email</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filteredClients.map((c) => {
                  const count = (c.platforms ?? []).length;
                  return (
                    <tr
                      key={c.id}
                      onClick={() => setDetailId(c.id)}
                      className="cursor-pointer transition hover:bg-slate-50"
                    >
                      <td className="px-3 py-2 font-medium text-slate-800">{c.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-slate-600">{c.tax_id || '—'}</td>
                      <td className="px-3 py-2 text-slate-600">{c.email || '—'}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center justify-end gap-3 text-slate-400">
                          <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-500">
                            <Layers className="h-3 w-3" />
                            {count} {count === 1 ? 'plataforma' : 'plataformas'}
                          </span>
                          <ChevronRight className="h-4 w-4" />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

      </Card>

      <AddClientModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        onCreated={handleCreated}
      />

      {detailClient && (
        <ClientDetailModal
          client={detailClient}
          isAdmin={isAdmin}
          onClose={() => setDetailId(null)}
          onAddPlatform={(p) => addPlatform(detailClient.id, p)}
          onEditPlatform={(pid, p) => editPlatform(detailClient.id, pid, p)}
          onRemovePlatform={(pid) => removePlatform(detailClient.id, pid)}
          onDelete={() => removeClient(detailClient.id)}
        />
      )}
    </div>
  );
}

/* ---------- Branding ---------- */

interface BrandingProps {
  isAdmin: boolean;
  saving: boolean;
  companyName: string;
  setCompanyName: (v: string) => void;
  rfc: string;
  setRfc: (v: string) => void;
  logoUrl: string;
  setLogoUrl: (v: string) => void;
  onSave: () => void;
}

function BrandingTab(props: BrandingProps) {
  const { isAdmin, saving, companyName, setCompanyName, rfc, setRfc, logoUrl, setLogoUrl, onSave } = props;
  return (
    <Card className="max-w-xl p-6 shadow-sm">
      <SectionHeader icon={Building2}>Datos de empresa</SectionHeader>
      <div className="space-y-4">
        <Field label="Nombre de empresa" htmlFor="br-name">
          <Input id="br-name" value={companyName} onChange={(e) => setCompanyName(e.target.value)} disabled={!isAdmin} placeholder="Capital Centennials" />
        </Field>
        <Field label="RFC" htmlFor="br-rfc">
          <Input id="br-rfc" value={rfc} onChange={(e) => setRfc(e.target.value.toUpperCase())} disabled={!isAdmin} className="font-mono" placeholder="CAP010101ABC" />
        </Field>
        <Field label="URL del logo" htmlFor="br-logo">
          <Input id="br-logo" value={logoUrl} onChange={(e) => setLogoUrl(e.target.value)} disabled={!isAdmin} placeholder="https://..." />
        </Field>
        <Button onClick={onSave} disabled={!isAdmin || saving}>
          <Save className="h-4 w-4" /> Guardar
        </Button>
      </div>
    </Card>
  );
}

/* ---------- Parámetros de validación ---------- */

interface ParametrosProps {
  isAdmin: boolean;
  saving: boolean;
  params: ValidationParams;
  setParams: (v: ValidationParams) => void;
  onSave: () => void;
}

const PARAM_FIELDS: { key: keyof ValidationParams; label: string; help: string }[] = [
  { key: 'cantidad', label: 'Máx. productos por partida', help: 'Cantidad máxima de productos por partida.' },
  { key: 'montoMin', label: 'Valor mínimo USD', help: 'Valor declarado mínimo aceptable.' },
  { key: 'montoMax', label: 'Valor máximo USD (subvaluación)', help: 'Umbral de valor máximo / subvaluación.' },
  { key: 'consignatario', label: 'Repeticiones de consignatario', help: 'Repeticiones para alertar por consignatario.' },
  { key: 'direccion', label: 'Repeticiones de dirección', help: 'Repeticiones de dirección para alertar.' },
  { key: 'importacionesMes', label: 'Umbral importaciones / mes', help: 'Operaciones por consignatario en el mes que disparan la alerta (Ficha 124: >3, por lo que 4).' },
];

function ParametrosTab({ isAdmin, saving, params, setParams, onSave }: ParametrosProps) {
  return (
    <Card className="p-6 shadow-sm">
      <SectionHeader icon={Sliders}>Parámetros de validación</SectionHeader>
      <p className="mb-4 text-xs text-slate-500">
        Vacío/0 usa los valores predeterminados del motor. Los cambios aplican a la siguiente corrida de riesgo y
        sellan la versión del ruleset configurada.
      </p>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PARAM_FIELDS.map((f) => (
          <div key={String(f.key)}>
            <Field label={f.label} htmlFor={`vp-${f.key}`}>
              <Input
                id={`vp-${f.key}`}
                type="number"
                value={params[f.key]}
                onChange={(e) => setParams({ ...params, [f.key]: e.target.value === '' ? 0 : Number(e.target.value) })}
                disabled={!isAdmin}
                className="font-mono disabled:bg-slate-50"
              />
            </Field>
            <p className="mt-1 text-[11px] text-slate-400">{f.help}</p>
          </div>
        ))}
      </div>
      <Button className="mt-4" onClick={onSave} disabled={!isAdmin || saving}>
        <Save className="h-4 w-4" /> Guardar
      </Button>
    </Card>
  );
}

/* ---------- RFCs validados ---------- */

interface RfcsProps {
  isAdmin: boolean;
  rfcs: ValidatedRfc[];
  onChanged: () => void;
  onToast: (msg: string) => void;
}

function RfcsTab({ isAdmin, rfcs, onChanged, onToast }: RfcsProps) {
  const [idRef, setIdRef] = useState('');
  const [rfc, setRfc] = useState('');
  const [curp, setCurp] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!isAdmin || !idRef.trim()) return;
    setBusy(true);
    try {
      await apiPost('/api/catalogs/validated-rfcs', {
        id_ref: idRef.trim(),
        rfc: rfc.trim(),
        curp: curp.trim(),
        name: name.trim(),
      });
      onToast('RFC validado guardado');
      setIdRef(''); setRfc(''); setCurp(''); setName('');
      onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (!isAdmin) return;
    try {
      await apiDelete('/api/catalogs/validated-rfcs/' + id);
      onToast('RFC validado eliminado');
      onChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  return (
    <Card className="p-6 shadow-sm">
      <SectionHeader icon={ShieldCheck}>RFCs validados</SectionHeader>
      <p className="mb-4 text-xs text-slate-500">
        El manifiesto trae solo un ID; esta tabla provee el RFC/CURP validado para el reporte T1.
      </p>

      {rfcs.length === 0 ? (
        <p className="py-4 text-sm text-slate-400">Sin RFCs validados.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">ID CNNE</th>
                <th className="px-3 py-2 font-semibold">RFC</th>
                <th className="px-3 py-2 font-semibold">CURP</th>
                <th className="px-3 py-2 font-semibold">Nombre</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rfcs.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.id_ref}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-700">{r.rfc || '—'}</td>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{r.curp || '—'}</td>
                  <td className="px-3 py-2 text-slate-700">{r.name || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={() => remove(r.id)}
                        className="text-slate-400 transition hover:text-red-600"
                        aria-label="Eliminar RFC validado"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isAdmin && (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-600">Agregar RFC validado</p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="ID del CNNE *" htmlFor="vr-idref">
              <Input id="vr-idref" value={idRef} onChange={(e) => setIdRef(e.target.value)} className="font-mono" />
            </Field>
            <Field label="RFC" htmlFor="vr-rfc">
              <Input id="vr-rfc" value={rfc} onChange={(e) => setRfc(e.target.value.toUpperCase())} className="font-mono" />
            </Field>
            <Field label="CURP" htmlFor="vr-curp">
              <Input id="vr-curp" value={curp} onChange={(e) => setCurp(e.target.value.toUpperCase())} className="font-mono" />
            </Field>
            <Field label="Nombre" htmlFor="vr-name">
              <Input id="vr-name" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
          </div>
          <Button className="mt-3" onClick={add} disabled={busy || !idRef.trim()}>
            <Plus className="h-4 w-4" /> Agregar
          </Button>
        </div>
      )}
    </Card>
  );
}

/* ---------- Tasa global (vigencias) ---------- */

interface TasaProps {
  isSuperAdmin: boolean;
  saving: boolean;
  vigencias: TasaVigencia[];
  setVigencias: (v: TasaVigencia[]) => void;
  onSave: (rows: TasaVigencia[]) => void;
}

/* ---------- Client detail (read-only data + platform management) ---------- */

function DetailRow({ label, value, mono }: { label: string; value?: string; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-400">{label}</dt>
      <dd className={`text-slate-700 ${mono ? 'font-mono text-xs' : 'text-sm'}`}>{value?.trim() || '—'}</dd>
    </div>
  );
}

function ClientDetailModal({ client, isAdmin, onClose, onAddPlatform, onEditPlatform, onRemovePlatform, onDelete }: {
  client: Client;
  isAdmin: boolean;
  onClose: () => void;
  onAddPlatform: (p: ClientPlatform) => void;
  onEditPlatform: (pid: string, p: ClientPlatform) => void;
  onRemovePlatform: (pid: string) => void;
  onDelete: () => void;
}) {
  const platforms = client.platforms ?? [];
  const [editingId, setEditingId] = useState<string | null>(null);
  return (
    <Modal open onClose={onClose} title={client.name}>
      <section className="mb-5">
        <h4 className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-500">Datos del cliente</h4>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2">
          <DetailRow label="Id fiscal" value={client.tax_id} mono />
          <DetailRow label="Correo" value={client.email} />
          <DetailRow label="Teléfono" value={client.phone} />
          <DetailRow label="Sitio web" value={client.website} />
          <div className="sm:col-span-2">
            <DetailRow label="Domicilio" value={client.address} />
          </div>
        </dl>
      </section>

      <section className="border-t border-slate-200 pt-4">
        <h4 className="mb-3 flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
          <Layers className="h-3.5 w-3.5" />
          Plataformas
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-500">
            {platforms.length}
          </span>
        </h4>

        {platforms.length === 0 ? (
          <p className="text-sm text-slate-400">Este cliente no tiene plataformas registradas.</p>
        ) : (
          <ul className="space-y-2">
            {platforms.map((p) => {
              if (isAdmin && editingId === p.id) {
                return (
                  <li key={p.id}>
                    <PlatformForm
                      initial={p}
                      submitLabel="Guardar cambios"
                      onSubmit={(updated) => { onEditPlatform(p.id!, updated); setEditingId(null); }}
                      onCancel={() => setEditingId(null)}
                    />
                  </li>
                );
              }
              const sub = [
                p.legalName && p.legalName !== p.commercialName ? p.legalName : null,
                p.countryOfOrigin ? countryDisplayName(p.countryOfOrigin) : null,
                p.email,
                p.url,
              ].filter(Boolean).join(' · ');
              return (
                <li
                  key={p.id}
                  className={`flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 ${
                    isAdmin ? 'cursor-pointer transition hover:border-navy-300 hover:bg-navy-50/40' : ''
                  }`}
                  onClick={isAdmin ? () => setEditingId(p.id!) : undefined}
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-slate-800">
                      {p.commercialName || p.legalName || '—'}
                    </p>
                    {sub && <p className="truncate text-xs text-slate-500">{sub}</p>}
                  </div>
                  {isAdmin && (
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); onRemovePlatform(p.id!); }}
                      className="shrink-0 text-slate-300 transition hover:text-red-600"
                      aria-label="Eliminar plataforma"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}

        {isAdmin && (
          <div className="mt-3">
            <PlatformAdder onAdd={onAddPlatform} />
          </div>
        )}
      </section>

      {isAdmin && (
        <div className="mt-5 flex items-center justify-between border-t border-slate-200 pt-4">
          <button
            type="button"
            onClick={onDelete}
            className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-red-600 transition hover:bg-red-50"
          >
            <Trash2 className="h-4 w-4" /> Eliminar cliente
          </button>
          <Button variant="secondary" type="button" onClick={onClose}>Cerrar</Button>
        </div>
      )}
    </Modal>
  );
}

function PlatformAdder({ onAdd }: { onAdd: (p: ClientPlatform) => void }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1 text-xs font-medium text-navy-700 hover:underline">
        + Agregar plataforma
      </button>
    );
  }
  return (
    <PlatformForm
      initial={{}}
      submitLabel="Guardar"
      onSubmit={(p) => { onAdd(p); setOpen(false); }}
      onCancel={() => setOpen(false)}
    />
  );
}

/** Shared add/edit form for a client platform. */
function PlatformForm({ initial, submitLabel, onSubmit, onCancel }: {
  initial: ClientPlatform;
  submitLabel: string;
  onSubmit: (p: ClientPlatform) => void;
  onCancel: () => void;
}) {
  const [p, setP] = useState<ClientPlatform>(initial);
  return (
    <div className="mt-2 space-y-1 rounded border border-slate-200 bg-slate-50 p-2">
      <Input placeholder="Nombre comercial" value={p.commercialName ?? ''} onChange={(e) => setP({ ...p, commercialName: e.target.value })} />
      <SearchSelect
        placeholder="País de origen"
        options={ANAM_COUNTRY_OPTIONS}
        value={p.countryOfOrigin ?? ''}
        onChange={(v) => setP({ ...p, countryOfOrigin: v })}
      />
      <Input placeholder="Razón social" value={p.legalName ?? ''} onChange={(e) => setP({ ...p, legalName: e.target.value })} />
      <Input placeholder="Correo" value={p.email ?? ''} onChange={(e) => setP({ ...p, email: e.target.value })} />
      <Input placeholder="URL" value={p.url ?? ''} onChange={(e) => setP({ ...p, url: e.target.value })} />
      <div className="flex gap-2 pt-1">
        <Button type="button" onClick={() => onSubmit(p)}>{submitLabel}</Button>
        <Button variant="secondary" type="button" onClick={onCancel}>Cancelar</Button>
      </div>
    </div>
  );
}

function TasaTab({ isSuperAdmin, saving, vigencias, setVigencias, onSave }: TasaProps) {
  const [startDate, setStartDate] = useState('');
  const [originType, setOriginType] = useState<OriginType>('GENERAL');
  const [rate, setRate] = useState('');

  function addRow() {
    if (!isSuperAdmin || !startDate || rate.trim() === '') return;
    const row: TasaVigencia = { startDate, originType, rate: Number(rate) };
    const next = [...vigencias, row];
    setVigencias(next);
    setStartDate(''); setRate(''); setOriginType('GENERAL');
  }

  function removeRow(idx: number) {
    if (!isSuperAdmin) return;
    setVigencias(vigencias.filter((_, i) => i !== idx));
  }

  return (
    <Card className="p-6 shadow-sm">
      <SectionHeader icon={ScrollText}>Tasa global (vigencias)</SectionHeader>

      {!isSuperAdmin && (
        <div className="mb-4 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p>Solo el Super Admin puede editar las vigencias de tasa global.</p>
        </div>
      )}

      <p className="mb-4 text-xs text-slate-500">
        Mensajería 2025: GENERAL 33.5% (0.335), T-MEC 19% (0.19). Capture la tasa como número (0.335 o 33.5).
      </p>

      {vigencias.length === 0 ? (
        <p className="py-4 text-sm text-slate-400">Sin vigencias configuradas.</p>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Vigente desde</th>
                <th className="px-3 py-2 font-semibold">Origen</th>
                <th className="px-3 py-2 font-semibold">Tasa</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {vigencias.map((v, i) => (
                <tr key={`${v.startDate}-${v.originType}-${i}`}>
                  <td className="px-3 py-2 font-mono text-xs text-slate-600">{v.startDate}</td>
                  <td className="px-3 py-2 text-slate-700">{v.originType}</td>
                  <td className="px-3 py-2 font-mono text-slate-700">{v.rate}</td>
                  <td className="px-3 py-2 text-right">
                    {isSuperAdmin && (
                      <button
                        type="button"
                        onClick={() => removeRow(i)}
                        className="text-slate-400 transition hover:text-red-600"
                        aria-label="Eliminar vigencia"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {isSuperAdmin && (
        <>
          <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
            <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-600">Agregar vigencia</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Field label="Vigente desde" htmlFor="tv-date">
                <Input id="tv-date" type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
              </Field>
              <Field label="Origen" htmlFor="tv-origin">
                <select
                  id="tv-origin"
                  value={originType}
                  onChange={(e) => setOriginType(e.target.value as OriginType)}
                  className="w-full rounded-lg border border-slate-300 px-3.5 py-2.5 text-sm text-slate-900 outline-none transition focus:border-navy-500 focus:ring-2 focus:ring-navy-500/25"
                >
                  <option value="GENERAL">GENERAL</option>
                  <option value="TMEC">TMEC</option>
                </select>
              </Field>
              <Field label="Tasa (0.335 o 33.5)" htmlFor="tv-rate">
                <Input id="tv-rate" type="number" step="any" value={rate} onChange={(e) => setRate(e.target.value)} className="font-mono" />
              </Field>
            </div>
            <Button variant="secondary" className="mt-3" onClick={addRow} disabled={!startDate || rate.trim() === ''}>
              <Plus className="h-4 w-4" /> Agregar fila
            </Button>
          </div>

          <Button className="mt-4" onClick={() => onSave(vigencias)} disabled={saving}>
            <Save className="h-4 w-4" /> Guardar vigencias
          </Button>
        </>
      )}
    </Card>
  );
}

/* ---------- Entidades de pedimento (agentes aduanales + importadores, auto-registrados) ---------- */

interface EntidadesProps {
  canEdit: boolean;
  agentes: AgenteAduanal[];
  importadores: Importador[];
  onAgentesChanged: () => void;
  onImportadoresChanged: () => void;
  onToast: (msg: string) => void;
}

function EntidadesTab({ canEdit, agentes, importadores, onAgentesChanged, onImportadoresChanged, onToast }: EntidadesProps) {
  async function updateAgente(id: string, patch: Partial<Pick<AgenteAduanal, 'name' | 'agentRfc' | 'agencyRfc' | 'verified'>>) {
    if (!canEdit) return;
    try {
      await apiPut(`/api/catalogs/agentes-aduanales/${id}`, patch);
      onToast('Agente aduanal actualizado');
      onAgentesChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  async function updateImportador(id: string, patch: Partial<Pick<Importador, 'name' | 'fiscalAddress' | 'verified'>>) {
    if (!canEdit) return;
    try {
      await apiPut(`/api/catalogs/importadores/${id}`, patch);
      onToast('Importador actualizado');
      onImportadoresChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    }
  }

  const autoRegisterMsg = 'Se registran automáticamente al subir un pedimento. Complete o confirme los datos aquí.';

  return (
    <div className="space-y-6">
      {!canEdit && (
        <div className="flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <Lock className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
          <p>Solo los administradores pueden editar las entidades de pedimento.</p>
        </div>
      )}

      <Card className="p-6 shadow-sm">
        <SectionHeader icon={UserCheck}>Agentes aduanales</SectionHeader>
        <p className="mb-4 text-xs text-slate-500">{autoRegisterMsg}</p>
        {agentes.length === 0 ? (
          <EmptyState icon={UserCheck} title="Sin agentes aduanales" message={autoRegisterMsg} />
        ) : (
          <AgentesAduanalesTable agentes={agentes} canEdit={canEdit} onUpdate={updateAgente} />
        )}
      </Card>

      <Card className="p-6 shadow-sm">
        <SectionHeader icon={Landmark}>Importadores</SectionHeader>
        <p className="mb-4 text-xs text-slate-500">{autoRegisterMsg}</p>
        {importadores.length === 0 ? (
          <EmptyState icon={Landmark} title="Sin importadores" message={autoRegisterMsg} />
        ) : (
          <ImportadoresTable importadores={importadores} canEdit={canEdit} onUpdate={updateImportador} />
        )}
      </Card>
    </div>
  );
}

function VerifiedBadge({ verified }: { verified: boolean }) {
  return (
    <StatusPill resultado={verified ? 'verde' : 'amarillo'} label={verified ? 'Verificado' : 'Sin verificar'} />
  );
}

function RowActions({ canEdit, isEditing, verified, busy, onVerify, onEdit, onSave, onCancel }: {
  canEdit: boolean;
  isEditing: boolean;
  verified: boolean;
  busy: boolean;
  onVerify: () => void;
  onEdit: () => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  if (!canEdit) return null;
  if (isEditing) {
    return (
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onSave} disabled={busy}>Guardar</Button>
        <Button variant="ghost" onClick={onCancel} disabled={busy}>Cancelar</Button>
      </div>
    );
  }
  return (
    <div className="flex justify-end gap-2">
      {!verified && <Button variant="secondary" onClick={onVerify} disabled={busy}>Verificar</Button>}
      <Button variant="ghost" onClick={onEdit} disabled={busy}>Editar</Button>
    </div>
  );
}

function AgentesAduanalesTable({ agentes, canEdit, onUpdate }: {
  agentes: AgenteAduanal[];
  canEdit: boolean;
  onUpdate: (id: string, patch: Partial<Pick<AgenteAduanal, 'name' | 'agentRfc' | 'agencyRfc' | 'verified'>>) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', agentRfc: '', agencyRfc: '' });
  const [busyId, setBusyId] = useState<string | null>(null);

  function startEdit(a: AgenteAduanal) {
    setEditingId(a.id);
    setDraft({ name: a.name ?? '', agentRfc: a.agentRfc ?? '', agencyRfc: a.agencyRfc ?? '' });
  }

  async function saveEdit(id: string) {
    setBusyId(id);
    try {
      await onUpdate(id, { name: draft.name.trim(), agentRfc: draft.agentRfc.trim().toUpperCase(), agencyRfc: draft.agencyRfc.trim().toUpperCase() });
      setEditingId(null);
    } finally {
      setBusyId(null);
    }
  }

  async function verify(id: string) {
    setBusyId(id);
    try {
      await onUpdate(id, { verified: true });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2 font-semibold">Patente</th>
            <th className="px-3 py-2 font-semibold">Nombre</th>
            <th className="px-3 py-2 font-semibold">RFC agente</th>
            <th className="px-3 py-2 font-semibold">RFC agencia</th>
            <th className="px-3 py-2 font-semibold">Estado</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {agentes.map((a) => {
            const isEditing = editingId === a.id;
            const busy = busyId === a.id;
            return (
              <tr key={a.id}>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{a.patente}</td>
                {isEditing ? (
                  <>
                    <td className="px-3 py-2"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></td>
                    <td className="px-3 py-2"><Input className="font-mono" value={draft.agentRfc} onChange={(e) => setDraft({ ...draft, agentRfc: e.target.value.toUpperCase() })} /></td>
                    <td className="px-3 py-2"><Input className="font-mono" value={draft.agencyRfc} onChange={(e) => setDraft({ ...draft, agencyRfc: e.target.value.toUpperCase() })} /></td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-2 text-slate-700">{a.name || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">{a.agentRfc || '—'}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">{a.agencyRfc || '—'}</td>
                  </>
                )}
                <td className="px-3 py-2"><VerifiedBadge verified={a.verified} /></td>
                <td className="px-3 py-2 text-right">
                  <RowActions
                    canEdit={canEdit}
                    isEditing={isEditing}
                    verified={a.verified}
                    busy={busy}
                    onVerify={() => verify(a.id)}
                    onEdit={() => startEdit(a)}
                    onSave={() => saveEdit(a.id)}
                    onCancel={() => setEditingId(null)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ImportadoresTable({ importadores, canEdit, onUpdate }: {
  importadores: Importador[];
  canEdit: boolean;
  onUpdate: (id: string, patch: Partial<Pick<Importador, 'name' | 'fiscalAddress' | 'verified'>>) => Promise<void>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState({ name: '', fiscalAddress: '' });
  const [busyId, setBusyId] = useState<string | null>(null);

  function startEdit(i: Importador) {
    setEditingId(i.id);
    setDraft({ name: i.name ?? '', fiscalAddress: i.fiscalAddress ?? '' });
  }

  async function saveEdit(id: string) {
    setBusyId(id);
    try {
      await onUpdate(id, { name: draft.name.trim(), fiscalAddress: draft.fiscalAddress.trim() });
      setEditingId(null);
    } finally {
      setBusyId(null);
    }
  }

  async function verify(id: string) {
    setBusyId(id);
    try {
      await onUpdate(id, { verified: true });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
          <tr>
            <th className="px-3 py-2 font-semibold">RFC</th>
            <th className="px-3 py-2 font-semibold">Nombre</th>
            <th className="px-3 py-2 font-semibold">Domicilio fiscal</th>
            <th className="px-3 py-2 font-semibold">Estado</th>
            <th className="px-3 py-2" />
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {importadores.map((i) => {
            const isEditing = editingId === i.id;
            const busy = busyId === i.id;
            return (
              <tr key={i.id}>
                <td className="px-3 py-2 font-mono text-xs text-slate-600">{i.rfc}</td>
                {isEditing ? (
                  <>
                    <td className="px-3 py-2"><Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></td>
                    <td className="px-3 py-2"><Input value={draft.fiscalAddress} onChange={(e) => setDraft({ ...draft, fiscalAddress: e.target.value })} /></td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-2 text-slate-700">{i.name || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{i.fiscalAddress || '—'}</td>
                  </>
                )}
                <td className="px-3 py-2"><VerifiedBadge verified={i.verified} /></td>
                <td className="px-3 py-2 text-right">
                  <RowActions
                    canEdit={canEdit}
                    isEditing={isEditing}
                    verified={i.verified}
                    busy={busy}
                    onVerify={() => verify(i.id)}
                    onEdit={() => startEdit(i)}
                    onSave={() => saveEdit(i.id)}
                    onCancel={() => setEditingId(null)}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
