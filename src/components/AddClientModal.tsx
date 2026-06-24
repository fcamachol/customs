import { useState } from 'react';
import { apiPost } from '../api';
import { Modal, Button, Field, Input } from './ui';

export interface ClientPlatform {
  id?: string;
  commercialName?: string;
  countryOfOrigin?: string;
  legalName?: string;
  email?: string;
}

export interface Client {
  id: string;
  name: string;
  tax_id?: string;
  address?: string;
  phone?: string;
  email?: string;
  website?: string;
  /** Single platform shape kept for the create form; the API returns the full list below. */
  platform?: ClientPlatform;
  platforms?: ClientPlatform[];
}

const EMPTY = {
  name: '', tax_id: '', address: '', phone: '', email: '', website: '',
};

export function AddClientModal({ open, onClose, onCreated }: {
  open: boolean;
  onClose: () => void;
  onCreated: (client: Client) => void;
}) {
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function set<K extends keyof typeof EMPTY>(key: K, value: string) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function close() {
    setForm(EMPTY);
    setError(null);
    onClose();
  }

  async function submit() {
    if (!form.name.trim()) { setError('El nombre es requerido.'); return; }
    setSaving(true);
    setError(null);
    try {
      const created = await apiPost<Client>('/api/catalogs/clients', {
        name: form.name.trim(),
        tax_id: form.tax_id.trim(),
        address: form.address.trim(),
        phone: form.phone.trim(),
        email: form.email.trim(),
        website: form.website.trim(),
      });
      setForm(EMPTY);
      onCreated(created);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error al crear el cliente.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal open={open} onClose={close} title="Nuevo cliente">
      {error && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm font-medium text-red-700">
          {error}
        </div>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Nombre / razón social" htmlFor="c-name">
          <Input id="c-name" value={form.name} onChange={(e) => set('name', e.target.value)} />
        </Field>
        <Field label="Id fiscal (RFC)" htmlFor="c-tax">
          <Input id="c-tax" value={form.tax_id} onChange={(e) => set('tax_id', e.target.value)} />
        </Field>
        <Field label="Domicilio" htmlFor="c-addr">
          <Input id="c-addr" value={form.address} onChange={(e) => set('address', e.target.value)} />
        </Field>
        <Field label="Teléfono" htmlFor="c-phone">
          <Input id="c-phone" value={form.phone} onChange={(e) => set('phone', e.target.value)} />
        </Field>
        <Field label="Correo" htmlFor="c-email">
          <Input id="c-email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)} />
        </Field>
        <Field label="Sitio web" htmlFor="c-website">
          <Input id="c-website" value={form.website} onChange={(e) => set('website', e.target.value)} />
        </Field>
      </div>
      <p className="mt-3 text-xs text-slate-500">
        Las plataformas se agregan al abrir el cliente, una vez creado.
      </p>
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" type="button" onClick={close}>Cancelar</Button>
        <Button type="button" onClick={submit} disabled={saving}>Guardar cliente</Button>
      </div>
    </Modal>
  );
}
