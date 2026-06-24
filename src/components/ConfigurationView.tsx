/**
 * ConfigurationView — DB-driven catalogs, branding, validation params,
 * validated RFCs, and global-rate vigencias (RF-24 / D3 / D4 / §10).
 *
 * Navigation lives in the global sidebar (collapsible "Configuración" parent); this
 * component renders the single domain selected there, showing its complete view:
 *   · cfg_motor:     Parámetros de validación + Listas de exclusión (V6/V7)
 *   · cfg_clientes:  Clientes (master data)
 *   · cfg_rfcs:      RFCs validados
 *   · cfg_empresa:   Identidad / branding
 *   · cfg_tasa:      Tasa global (vigencias) — Super Admin only
 * Mutations require an Administrador role; Tasa global is reserved for the Super
 * Admin. Non-admins see read-only fields and a notice card.
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
} from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { apiGet, apiPut, apiPost, apiDelete } from '../api';
import { Card, Button, Field, Input, Textarea } from './ui';
import type { ConfigSection } from '../nav';
import type { Client, ClientPlatform } from './AddClientModal';

interface Props {
  domain: ConfigSection;
  onToast: (msg: string) => void;
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

export default function ConfigurationView({ domain, onToast }: Props) {
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin' || user?.role === 'super_admin';
  const isSuperAdmin = user?.role === 'super_admin';

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
    </div>
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
  const empty: ClientForm = {
    name: '', tax_id: '', address: '', phone: '', email: '', website: '',
    commercialName: '', countryOfOrigin: '', legalName: '', platformEmail: '',
  };
  const [form, setForm] = useState<ClientForm>(empty);
  const [adding, setAdding] = useState(false);

  async function addClient() {
    if (!isAdmin || !form.name.trim()) return;
    setAdding(true);
    try {
      await apiPost('/api/catalogs/clients', {
        name: form.name.trim(),
        tax_id: form.tax_id.trim(),
        address: form.address.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        website: form.website.trim(),
        platform: {
          commercialName: form.commercialName.trim(),
          countryOfOrigin: form.countryOfOrigin.trim(),
          legalName: form.legalName.trim(),
          email: form.platformEmail.trim(),
        },
      });
      onToast('Cliente agregado');
      setForm(empty);
      onClientsChanged();
    } catch (e) {
      onToast(`Error: ${errMsg(e)}`);
    } finally {
      setAdding(false);
    }
  }

  async function removeClient(id: string) {
    if (!isAdmin) return;
    try {
      await apiDelete('/api/catalogs/clients/' + id);
      onToast('Cliente eliminado');
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
        <SectionHeader icon={Building2}>Clientes</SectionHeader>
        <p className="mb-4 text-xs text-slate-500">
          Datos recurrentes de remitente y plataforma, reutilizados al generar el Reporte General.
        </p>

        {clients.length === 0 ? (
          <p className="py-4 text-sm text-slate-400">Sin clientes registrados.</p>
        ) : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-3 py-2 font-semibold">Nombre</th>
                  <th className="px-3 py-2 font-semibold">RFC / Tax ID</th>
                  <th className="px-3 py-2 font-semibold">Plataforma</th>
                  <th className="px-3 py-2 font-semibold">Email</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {clients.map((c) => (
                  <tr key={c.id}>
                    <td className="px-3 py-2 font-medium text-slate-800">{c.name}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">{c.tax_id || '—'}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {(c.platforms ?? []).length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        <ul className="space-y-1">
                          {(c.platforms ?? []).map((p) => (
                            <li key={p.id} className="flex items-center gap-2">
                              <span>{p.commercialName || p.legalName || '—'}</span>
                              {p.countryOfOrigin && <span className="text-xs text-slate-400">({p.countryOfOrigin})</span>}
                              {isAdmin && (
                                <button
                                  type="button"
                                  onClick={() => removePlatform(c.id, p.id!)}
                                  className="text-slate-300 transition hover:text-red-600"
                                  aria-label="Eliminar plataforma"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              )}
                            </li>
                          ))}
                        </ul>
                      )}
                      {isAdmin && <PlatformAdder onAdd={(p) => addPlatform(c.id, p)} />}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{c.email || '—'}</td>
                    <td className="px-3 py-2 text-right">
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={() => removeClient(c.id)}
                          className="text-slate-400 transition hover:text-red-600"
                          aria-label="Eliminar cliente"
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
            <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-600">Agregar cliente</p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Nombre *" htmlFor="cl-name">
                <Input id="cl-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label="RFC / Tax ID" htmlFor="cl-tax">
                <Input id="cl-tax" value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })} />
              </Field>
              <Field label="Teléfono" htmlFor="cl-phone">
                <Input id="cl-phone" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
              </Field>
              <Field label="Dirección" htmlFor="cl-addr">
                <Input id="cl-addr" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
              </Field>
              <Field label="Email" htmlFor="cl-email">
                <Input id="cl-email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label="Sitio web" htmlFor="cl-website">
                <Input id="cl-website" value={form.website} onChange={(e) => setForm({ ...form, website: e.target.value })} />
              </Field>
              <Field label="Plataforma (nombre comercial)" htmlFor="cl-pcom">
                <Input id="cl-pcom" value={form.commercialName} onChange={(e) => setForm({ ...form, commercialName: e.target.value })} />
              </Field>
              <Field label="País de origen" htmlFor="cl-pcoo">
                <Input id="cl-pcoo" value={form.countryOfOrigin} onChange={(e) => setForm({ ...form, countryOfOrigin: e.target.value })} />
              </Field>
              <Field label="Razón social" htmlFor="cl-plegal">
                <Input id="cl-plegal" value={form.legalName} onChange={(e) => setForm({ ...form, legalName: e.target.value })} />
              </Field>
              <Field label="Email plataforma" htmlFor="cl-pemail">
                <Input id="cl-pemail" value={form.platformEmail} onChange={(e) => setForm({ ...form, platformEmail: e.target.value })} />
              </Field>
            </div>
            <Button className="mt-3" onClick={addClient} disabled={adding || !form.name.trim()}>
              <Plus className="h-4 w-4" /> Agregar cliente
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

interface ClientForm {
  name: string;
  tax_id: string;
  address: string;
  phone: string;
  email: string;
  website: string;
  commercialName: string;
  countryOfOrigin: string;
  legalName: string;
  platformEmail: string;
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

function PlatformAdder({ onAdd }: { onAdd: (p: ClientPlatform) => void }) {
  const [open, setOpen] = useState(false);
  const [p, setP] = useState<ClientPlatform>({});
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-1 text-xs font-medium text-navy-700 hover:underline">
        + Agregar plataforma
      </button>
    );
  }
  return (
    <div className="mt-2 space-y-1 rounded border border-slate-200 bg-slate-50 p-2">
      <Input placeholder="Nombre comercial" value={p.commercialName ?? ''} onChange={(e) => setP({ ...p, commercialName: e.target.value })} />
      <Input placeholder="País de origen" value={p.countryOfOrigin ?? ''} onChange={(e) => setP({ ...p, countryOfOrigin: e.target.value })} />
      <Input placeholder="Razón social" value={p.legalName ?? ''} onChange={(e) => setP({ ...p, legalName: e.target.value })} />
      <Input placeholder="Correo" value={p.email ?? ''} onChange={(e) => setP({ ...p, email: e.target.value })} />
      <div className="flex gap-2 pt-1">
        <Button type="button" onClick={() => { onAdd(p); setP({}); setOpen(false); }}>Guardar</Button>
        <Button variant="secondary" type="button" onClick={() => { setP({}); setOpen(false); }}>Cancelar</Button>
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
