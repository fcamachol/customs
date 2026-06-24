import { useState } from 'react';
import { apiPost } from '../api';
import { Modal, Button, Field, Input, SearchSelect } from './ui';
import { ANAM_COUNTRY_OPTIONS } from '../../shared/parsing/catalogs';
import type { ClientPlatform } from './AddClientModal';

const EMPTY: ClientPlatform = {
  commercialName: '', countryOfOrigin: '', legalName: '', email: '', url: '',
};

/** Create a platform for an existing client. Linked to `clientId`. */
export function AddPlatformModal({ open, clientId, clientName, onClose, onCreated }: {
  open: boolean;
  clientId: string;
  clientName?: string;
  onClose: () => void;
  onCreated: (platform: ClientPlatform) => void;
}) {
  const [form, setForm] = useState<ClientPlatform>(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof ClientPlatform>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function close() {
    setForm(EMPTY);
    setError(null);
    onClose();
  }

  async function submit() {
    if (!clientId) { setError('Selecciona un cliente primero.'); return; }
    if (!form.commercialName?.trim()) { setError('El nombre comercial es requerido.'); return; }
    setSaving(true);
    setError(null);
    try {
      const created = await apiPost<ClientPlatform>(`/api/catalogs/clients/${clientId}/platforms`, {
        commercialName: form.commercialName?.trim(),
        countryOfOrigin: form.countryOfOrigin?.trim(),
        legalName: form.legalName?.trim(),
        email: form.email?.trim(),
        url: form.url?.trim(),
      });
      setForm(EMPTY);
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear la plataforma.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title={clientName ? `Nueva plataforma — ${clientName}` : 'Nueva plataforma'}>
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre comercial" htmlFor="p-commercial">
          <Input id="p-commercial" value={form.commercialName ?? ''} onChange={(e) => set('commercialName', e.target.value)} />
        </Field>
        <Field label="País de origen" htmlFor="p-country">
          <SearchSelect
            id="p-country"
            value={form.countryOfOrigin ?? ''}
            onChange={(v) => set('countryOfOrigin', v)}
            options={ANAM_COUNTRY_OPTIONS}
            placeholder="País de origen"
          />
        </Field>
        <Field label="Razón social" htmlFor="p-legal">
          <Input id="p-legal" value={form.legalName ?? ''} onChange={(e) => set('legalName', e.target.value)} />
        </Field>
        <Field label="Correo" htmlFor="p-email">
          <Input id="p-email" type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="URL" htmlFor="p-url">
          <Input id="p-url" value={form.url ?? ''} onChange={(e) => set('url', e.target.value)} />
        </Field>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" type="button" onClick={close}>Cancelar</Button>
        <Button type="button" onClick={submit} disabled={saving}>Guardar plataforma</Button>
      </div>
    </Modal>
  );
}
