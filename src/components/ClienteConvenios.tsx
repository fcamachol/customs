import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { FileText, Upload } from 'lucide-react';
import { apiGet, apiUpload, apiDownload } from '../api';
import { Button } from './ui';

/**
 * Contratos (convenios) de un cliente.
 *
 * Pedido por Roberto el 15-sep: "hazme la carga como en transportistas del contrato, en clientes".
 * El backend ya existía completo —la tabla `convenios` lleva `client_id`, archivo, vigencia y los
 * campos de firma NOM-151— pero ninguna pantalla lo ofrecía, así que para el operador no existía.
 *
 * SE REUSA EL MODELO DE CONVENIOS, no se inventa uno paralelo. Eso da gratis la vigencia, el hash
 * del documento y el camino a la firma digital que Fernando prefiere: el mismo botón que hoy sube
 * un PDF mañana dispara Cincel sin migrar nada. Una tabla nueva para clientes habría que unificarla
 * después, que es justo la deuda que el sistema ya arrastra entre `convenios` y
 * `transportista_convenios`.
 */
interface Convenio {
  id: string;
  fileId: string | null;
  vigenciaDesde: string | null;
  vigenciaHasta: string | null;
  estadoFirma: string | null;
  firmadoAt: string | null;
}

const ESTADO_STYLE: Record<string, string> = {
  firmado: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  pendiente: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  vencido: 'bg-red-50 text-red-700 ring-red-600/20',
};

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
}

export function ClienteConvenios({ clientId, isAdmin }: { clientId: string; isAdmin: boolean }) {
  const [convenios, setConvenios] = useState<Convenio[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [form, setForm] = useState(false);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [desde, setDesde] = useState('');
  const [hasta, setHasta] = useState('');

  const recargar = useCallback(async () => {
    setCargando(true);
    try {
      const r = await apiGet<Convenio[]>(`/api/convenios?clientId=${encodeURIComponent(clientId)}`);
      // Falla cerrado ante una respuesta con forma inesperada: preferimos una lista vacía —que el
      // estado vacío explica— a que el detalle del cliente entero se caiga por un `.map` sobre algo
      // que no es arreglo. Lo cazó la suite completa, no esta prueba.
      setConvenios(Array.isArray(r) ? r : []);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudieron cargar los contratos.');
    } finally {
      setCargando(false);
    }
  }, [clientId]);

  useEffect(() => { void recargar(); }, [recargar]);

  async function subir(e: FormEvent) {
    e.preventDefault();
    if (!archivo) return;
    setSubiendo(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append('file', archivo);
      fd.append('clientId', clientId);
      if (desde) fd.append('vigenciaDesde', desde);
      if (hasta) fd.append('vigenciaHasta', hasta);
      await apiUpload('/api/convenios', fd);
      setForm(false); setArchivo(null); setDesde(''); setHasta('');
      await recargar();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cargar el contrato.');
    } finally {
      setSubiendo(false);
    }
  }

  return (
    <section className="mt-5 border-t border-slate-200 pt-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">Contratos</h4>
        {isAdmin && !form && (
          <Button variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setForm(true)}>
            <Upload className="h-3.5 w-3.5" />Cargar contrato
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>
      )}

      {form && (
        <form onSubmit={subir} className="mb-3 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
          <input
            type="file" accept="application/pdf" required
            onChange={(e) => setArchivo(e.target.files?.[0] ?? null)}
            className="block w-full text-xs text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-navy-800 file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-white"
          />
          <div className="flex flex-wrap gap-2">
            <label className="flex-1 text-[11px] text-slate-500">
              Vigencia desde
              <input type="date" value={desde} onChange={(e) => setDesde(e.target.value)}
                className="mt-0.5 block w-full rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-800" />
            </label>
            <label className="flex-1 text-[11px] text-slate-500">
              Vigencia hasta
              <input type="date" value={hasta} onChange={(e) => setHasta(e.target.value)}
                className="mt-0.5 block w-full rounded-md border border-slate-300 px-2 py-1 text-xs text-slate-800" />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" className="px-3 py-1.5 text-xs" onClick={() => setForm(false)} disabled={subiendo}>
              Cancelar
            </Button>
            <Button type="submit" className="px-3 py-1.5 text-xs" disabled={subiendo || !archivo}>
              {subiendo ? 'Cargando…' : 'Cargar'}
            </Button>
          </div>
        </form>
      )}

      {cargando && <p className="text-xs text-slate-400">Cargando…</p>}
      {!cargando && convenios.length === 0 && (
        <p className="rounded-lg border border-dashed border-slate-300 px-3 py-3 text-center text-xs text-slate-500">
          Sin contratos cargados. La autoridad puede pedirlos como parte de la trazabilidad.
        </p>
      )}

      <ul className="space-y-1.5">
        {convenios.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
            <span className="flex min-w-0 items-center gap-2">
              <FileText className="h-4 w-4 shrink-0 text-slate-400" />
              <span className="text-xs text-slate-700">
                Vigencia {fmt(c.vigenciaDesde)} — {fmt(c.vigenciaHasta)}
              </span>
            </span>
            <span className="flex shrink-0 items-center gap-2">
              {c.estadoFirma && (
                <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${
                  ESTADO_STYLE[c.estadoFirma] ?? 'bg-slate-100 text-slate-600 ring-slate-500/20'}`}>
                  {c.estadoFirma}
                </span>
              )}
              {c.fileId && (
                <button type="button"
                  onClick={() => void apiDownload(`/api/files/${c.fileId}`, `contrato-${c.id}.pdf`)}
                  className="text-[11px] font-semibold text-navy-700 hover:underline">
                  Descargar
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}
