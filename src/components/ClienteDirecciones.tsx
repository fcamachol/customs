/**
 * Direcciones de entrega de un cliente (R38 / D15).
 *
 * POR QUÉ VIVE DENTRO DEL DETALLE DEL CLIENTE y no en una pantalla propia: la dirección es una
 * propiedad de la contraparte, igual que su convenio o su tarifa, y quien la da de alta es quien
 * está viendo al cliente. El planeador la consume después como destino de un despacho.
 *
 * LAS DIRECCIONES SE DESACTIVAN, NO SE BORRAN. El servidor responde el DELETE con `activo = false`
 * porque los despachos y los planes publicados la nombran: una dirección borrada dejaría un viaje
 * histórico apuntando a la nada. Por eso la acción se ofrece como «Desactivar» y la fila inactiva
 * sigue visible, con opción de reactivarla.
 */
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { MapPin, Plus } from 'lucide-react';
import { apiGet, apiPost, apiPut, apiDelete } from '../api';
import { Button, Field, Input } from './ui';

interface Direccion {
  id: string;
  alias: string;
  direccion?: string | null;
  ciudad?: string | null;
  estado?: string | null;
  cp?: string | null;
  contactoNombre?: string | null;
  contactoTelefono?: string | null;
  horario?: string | null;
  activo: boolean;
}

const VACIA = {
  alias: '', direccion: '', ciudad: '', estado: '', cp: '',
  contactoNombre: '', contactoTelefono: '', horario: '',
};

const errMsg = (e: unknown): string => (e instanceof Error ? e.message : 'Error inesperado');

export function ClienteDirecciones({ clientId, isAdmin, onToast }: {
  clientId: string;
  isAdmin: boolean;
  onToast: (msg: string) => void;
}) {
  const [direcciones, setDirecciones] = useState<Direccion[]>([]);
  const [form, setForm] = useState(VACIA);
  const [abierto, setAbierto] = useState(false);
  const [editandoId, setEditandoId] = useState<string | null>(null);
  const [guardando, setGuardando] = useState(false);

  const recargar = useCallback(() => {
    apiGet<Direccion[]>(`/api/catalogs/clients/${clientId}/direcciones`)
      .then((r) => setDirecciones(Array.isArray(r) ? r : []))
      .catch(() => setDirecciones([]));
  }, [clientId]);

  useEffect(() => { recargar(); }, [recargar]);

  /** Los opcionales vacíos se omiten en el alta y se mandan como null en la edición: crear sin dato
   *  es "no lo sé todavía", editar a vacío es "bórralo". */
  function cuerpo(parcial: boolean): Record<string, unknown> {
    const b: Record<string, unknown> = { alias: form.alias.trim() };
    for (const k of ['direccion', 'ciudad', 'estado', 'cp', 'contactoNombre', 'contactoTelefono', 'horario'] as const) {
      const v = form[k].trim();
      if (v) b[k] = v;
      else if (parcial) b[k] = null;
    }
    return b;
  }

  async function guardar(e: FormEvent) {
    e.preventDefault();
    if (!form.alias.trim()) { onToast('Error: el alias es obligatorio.'); return; }
    setGuardando(true);
    try {
      if (editandoId) {
        await apiPut(`/api/catalogs/clients/${clientId}/direcciones/${editandoId}`, cuerpo(true));
        onToast('Dirección actualizada');
      } else {
        await apiPost(`/api/catalogs/clients/${clientId}/direcciones`, cuerpo(false));
        onToast('Dirección registrada');
      }
      setForm(VACIA);
      setAbierto(false);
      setEditandoId(null);
      recargar();
    } catch (err) {
      onToast(`Error: ${errMsg(err)}`);
    } finally {
      setGuardando(false);
    }
  }

  function abrirEdicion(d: Direccion) {
    setForm({
      alias: d.alias ?? '', direccion: d.direccion ?? '', ciudad: d.ciudad ?? '',
      estado: d.estado ?? '', cp: d.cp ?? '', contactoNombre: d.contactoNombre ?? '',
      contactoTelefono: d.contactoTelefono ?? '', horario: d.horario ?? '',
    });
    setEditandoId(d.id);
    setAbierto(true);
  }

  async function desactivar(d: Direccion) {
    try {
      await apiDelete(`/api/catalogs/clients/${clientId}/direcciones/${d.id}`);
      onToast(`Dirección «${d.alias}» desactivada`);
      recargar();
    } catch (err) {
      onToast(`Error: ${errMsg(err)}`);
    }
  }

  async function reactivar(d: Direccion) {
    try {
      await apiPut(`/api/catalogs/clients/${clientId}/direcciones/${d.id}`, { activo: true });
      onToast(`Dirección «${d.alias}» reactivada`);
      recargar();
    } catch (err) {
      onToast(`Error: ${errMsg(err)}`);
    }
  }

  return (
    <section className="mb-5 border-t border-slate-200 pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-slate-500">
          <MapPin className="h-4 w-4 text-navy-700" /> Direcciones de entrega ({direcciones.length})
        </h4>
        {isAdmin && !abierto && (
          <Button variant="ghost" onClick={() => { setForm(VACIA); setEditandoId(null); setAbierto(true); }}>
            <Plus className="h-3.5 w-3.5" /> Agregar dirección
          </Button>
        )}
      </div>

      {direcciones.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-5 text-center text-sm text-slate-400">
          Sin direcciones registradas. La planeación las necesita como destino de entrega.
        </p>
      ) : (
        <ul className="mb-3 space-y-2">
          {direcciones.map((d) => (
            <li
              key={d.id}
              className={`flex items-start justify-between gap-3 rounded-lg border px-3 py-2 ${
                d.activo ? 'border-slate-200 bg-slate-50' : 'border-slate-200 bg-slate-50/60 text-slate-400'
              }`}
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-800">
                  {d.alias}{!d.activo && <span className="ml-2 text-xs font-semibold text-slate-500">· inactiva</span>}
                </p>
                <p className="truncate text-xs text-slate-500">
                  {[d.direccion, d.ciudad, d.estado, d.cp].filter(Boolean).join(' · ') || 'Sin domicilio capturado'}
                </p>
                {(d.contactoNombre || d.horario) && (
                  <p className="truncate text-xs text-slate-400">
                    {[d.contactoNombre, d.contactoTelefono, d.horario].filter(Boolean).join(' · ')}
                  </p>
                )}
              </div>
              {isAdmin && (
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={() => abrirEdicion(d)}
                    className="text-xs font-semibold text-slate-400 transition hover:text-navy-700">
                    Editar
                  </button>
                  {d.activo ? (
                    <button type="button" onClick={() => void desactivar(d)}
                      aria-label={`Desactivar la dirección ${d.alias}`}
                      className="text-xs font-semibold text-slate-400 transition hover:text-red-600">
                      Desactivar
                    </button>
                  ) : (
                    <button type="button" onClick={() => void reactivar(d)}
                      aria-label={`Reactivar la dirección ${d.alias}`}
                      className="text-xs font-semibold text-slate-400 transition hover:text-navy-700">
                      Reactivar
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {isAdmin && abierto && (
        <form onSubmit={guardar} className="grid gap-3 rounded-lg border border-slate-200 bg-white p-3 sm:grid-cols-2">
          <Field label="Alias *" htmlFor="dir-alias">
            <Input id="dir-alias" value={form.alias} onChange={(e) => setForm({ ...form, alias: e.target.value })} />
          </Field>
          <Field label="Domicilio" htmlFor="dir-dom">
            <Input id="dir-dom" value={form.direccion} onChange={(e) => setForm({ ...form, direccion: e.target.value })} />
          </Field>
          <Field label="Ciudad" htmlFor="dir-ciudad">
            <Input id="dir-ciudad" value={form.ciudad} onChange={(e) => setForm({ ...form, ciudad: e.target.value })} />
          </Field>
          <Field label="Estado" htmlFor="dir-estado">
            <Input id="dir-estado" value={form.estado} onChange={(e) => setForm({ ...form, estado: e.target.value })} />
          </Field>
          <Field label="CP" htmlFor="dir-cp">
            <Input id="dir-cp" value={form.cp} onChange={(e) => setForm({ ...form, cp: e.target.value })} />
          </Field>
          <Field label="Contacto" htmlFor="dir-cont">
            <Input id="dir-cont" value={form.contactoNombre} onChange={(e) => setForm({ ...form, contactoNombre: e.target.value })} />
          </Field>
          <Field label="Teléfono" htmlFor="dir-tel">
            <Input id="dir-tel" value={form.contactoTelefono} onChange={(e) => setForm({ ...form, contactoTelefono: e.target.value })} />
          </Field>
          <Field label="Horario de recepción" htmlFor="dir-hor">
            <Input id="dir-hor" value={form.horario} onChange={(e) => setForm({ ...form, horario: e.target.value })} />
          </Field>
          <div className="flex gap-2 sm:col-span-2">
            <Button type="submit" variant="secondary" disabled={guardando}>
              {editandoId ? 'Guardar cambios' : 'Guardar dirección'}
            </Button>
            <Button type="button" variant="ghost" disabled={guardando}
              onClick={() => { setAbierto(false); setEditandoId(null); setForm(VACIA); }}>
              Cancelar
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
