import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { Search, Download } from 'lucide-react';
import { apiGet, apiPost, apiDownload } from '../api';
import { Card, Field, Input, Button, SearchSelect } from './ui';
import type { SearchSelectOption } from './ui';
import type { Client } from './AddClientModal';

interface RecordSummary {
  id: string;
  mawbReference: string;
  clientName: string;
  createdAt: string;
}

export default function ReporteGeneralView() {
  // Record search state
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<RecordSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedLabel, setSelectedLabel] = useState<string>('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);

  // Remitente form state
  const [nombreCompleto, setNombreCompleto] = useState('');
  const [idFiscal, setIdFiscal] = useState('');
  const [domicilio, setDomicilio] = useState('');
  const [telefono, setTelefono] = useState('');
  const [correoRemitente, setCorreoRemitente] = useState('');

  // Plataforma form state
  const [nombreComercial, setNombreComercial] = useState('');
  const [paisOrigen, setPaisOrigen] = useState('');
  const [denominacionPlataforma, setDenominacionPlataforma] = useState('');
  const [correoPlataforma, setCorreoPlataforma] = useState('');

  // Cascading client → platform selection
  const [clients, setClients] = useState<Client[]>([]);
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedPlatformId, setSelectedPlatformId] = useState('');

  // Load clients on mount for the cascading selector
  useEffect(() => {
    apiGet<Client[]>('/api/catalogs/clients').then(setClients).catch(() => setClients([]));
  }, []);

  const clientOptions: SearchSelectOption[] = useMemo(
    () => clients.map((c) => ({ value: c.id, label: c.name })),
    [clients],
  );

  const platformOptions: SearchSelectOption[] = useMemo(() => {
    const c = clients.find((c) => c.id === selectedClientId);
    return (c?.platforms ?? []).map((p) => ({
      value: p.id!,
      label: p.commercialName || p.legalName || 'Plataforma',
    }));
  }, [clients, selectedClientId]);

  function handleClientChange(id: string) {
    setSelectedClientId(id);
    setSelectedPlatformId(''); // platform list depends on the client
  }

  async function handleSearch(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSelectedId(null);
    setSelectedLabel('');
    setSearchLoading(true);
    try {
      const results = await apiGet<RecordSummary[]>(`/api/records?q=${encodeURIComponent(query)}`);
      setRecords(results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al buscar registros.');
    } finally {
      setSearchLoading(false);
    }
  }

  function handleSelect(r: RecordSummary) {
    setSelectedId(r.id);
    setSelectedLabel(`${r.mawbReference} — ${r.clientName}`);
  }

  async function handleGenerateReport() {
    if (!selectedId) return;
    if (!selectedClientId) { setError('Selecciona un cliente.'); return; }
    if (!selectedPlatformId) { setError('Selecciona una plataforma.'); return; }
    setError(null);
    setDownloading(true);
    try {
      await apiPost(`/api/manifests/${selectedId}/client`, {
        clientId: selectedClientId,
        platformId: selectedPlatformId,
      });
      await apiDownload(`/api/records/${selectedId}/report.xlsx`, 'Reporte_General.xlsx');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al generar el reporte.');
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Record search */}
      <form onSubmit={handleSearch} className="flex gap-2">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          <Input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Buscar registro por MAWB o cliente"
            className="pl-10"
          />
        </div>
        <Button type="submit" disabled={searchLoading}>
          Buscar
        </Button>
      </form>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm font-medium text-red-700">
          {error}
        </div>
      )}

      {records.length > 0 && (
        <ul className="divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
          {records.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => handleSelect(r)}
                className={`flex w-full items-center justify-between px-4 py-3 text-left text-sm transition-colors hover:bg-slate-50 ${
                  selectedId === r.id ? 'bg-navy-50 font-semibold text-navy-800' : ''
                }`}
              >
                <span>
                  <span className="font-semibold text-slate-800">{r.mawbReference}</span>
                  <span className="text-slate-500"> — {r.clientName}</span>
                </span>
                <span className="ml-2 shrink-0 text-xs text-slate-400">{r.createdAt}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {selectedId && (
        <div className="rounded-lg border border-navy-200 bg-navy-50/40 px-4 py-2.5 text-sm font-medium text-navy-800">
          Registro seleccionado: <span className="font-semibold">{selectedLabel}</span>
        </div>
      )}

      {/* Cliente y plataforma */}
      <Card className="p-6 shadow-sm space-y-5">
        <h2 className="text-sm font-bold text-slate-800">Cliente y plataforma</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Cliente">
            <SearchSelect
              value={selectedClientId}
              onChange={handleClientChange}
              options={clientOptions}
              placeholder="Selecciona un cliente…"
            />
          </Field>
          <Field label="Plataforma">
            <SearchSelect
              value={selectedPlatformId}
              onChange={setSelectedPlatformId}
              options={platformOptions}
              placeholder={selectedClientId ? 'Selecciona una plataforma…' : 'Elige un cliente primero'}
              disabled={!selectedClientId}
            />
          </Field>
        </div>
      </Card>

      {/* Datos del Remitente */}
      <Card className="p-6 shadow-sm space-y-5">
        <h2 className="text-sm font-bold text-slate-800">Datos del Remitente</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Nombre completo / denominación o razón social" htmlFor="remitente-nombre">
            <Input
              id="remitente-nombre"
              type="text"
              value={nombreCompleto}
              onChange={(e) => setNombreCompleto(e.target.value)}
              placeholder="Nombre o razón social"
            />
          </Field>
          <Field label="Id fiscal" htmlFor="remitente-id-fiscal">
            <Input
              id="remitente-id-fiscal"
              type="text"
              value={idFiscal}
              onChange={(e) => setIdFiscal(e.target.value)}
              placeholder="RFC / Tax ID"
            />
          </Field>
          <div className="sm:col-span-2">
            <Field label="Domicilio" htmlFor="remitente-domicilio">
              <Input
                id="remitente-domicilio"
                type="text"
                value={domicilio}
                onChange={(e) => setDomicilio(e.target.value)}
                placeholder="Dirección completa"
              />
            </Field>
          </div>
          <Field label="Teléfono" htmlFor="remitente-telefono">
            <Input
              id="remitente-telefono"
              type="tel"
              value={telefono}
              onChange={(e) => setTelefono(e.target.value)}
              placeholder="+52 55 0000 0000"
            />
          </Field>
          <Field label="Correo electrónico" htmlFor="remitente-correo">
            <Input
              id="remitente-correo"
              type="email"
              value={correoRemitente}
              onChange={(e) => setCorreoRemitente(e.target.value)}
              placeholder="correo@ejemplo.com"
            />
          </Field>
        </div>
      </Card>

      {/* Datos de la Plataforma */}
      <Card className="p-6 shadow-sm space-y-5">
        <h2 className="text-sm font-bold text-slate-800">Datos de la Plataforma</h2>
        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="Nombre comercial" htmlFor="plataforma-nombre-comercial">
            <Input
              id="plataforma-nombre-comercial"
              type="text"
              value={nombreComercial}
              onChange={(e) => setNombreComercial(e.target.value)}
              placeholder="Nombre comercial"
            />
          </Field>
          <Field label="País de origen" htmlFor="plataforma-pais">
            <Input
              id="plataforma-pais"
              type="text"
              value={paisOrigen}
              onChange={(e) => setPaisOrigen(e.target.value)}
              placeholder="México, China, EUA…"
            />
          </Field>
          <Field label="Denominación o razón social" htmlFor="plataforma-denominacion">
            <Input
              id="plataforma-denominacion"
              type="text"
              value={denominacionPlataforma}
              onChange={(e) => setDenominacionPlataforma(e.target.value)}
              placeholder="Razón social"
            />
          </Field>
          <Field label="Correo electrónico" htmlFor="plataforma-correo">
            <Input
              id="plataforma-correo"
              type="email"
              value={correoPlataforma}
              onChange={(e) => setCorreoPlataforma(e.target.value)}
              placeholder="correo@plataforma.com"
            />
          </Field>
        </div>
      </Card>

      {/* Generate report action */}
      <div className="flex items-center gap-3">
        <Button
          type="button"
          disabled={!selectedId || downloading}
          onClick={handleGenerateReport}
        >
          <Download className="h-4 w-4" />
          {downloading ? 'Generando…' : 'Generar Reporte'}
        </Button>
        {!selectedId && (
          <p className="text-xs text-slate-500">Selecciona un registro para habilitar la descarga.</p>
        )}
      </div>
    </div>
  );
}
