import { useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ShieldQuestion } from 'lucide-react';
import { apiGet } from '../api';
import { Card } from './ui';

/**
 * PanelRrna — regulaciones y restricciones no arancelarias de un manifiesto.
 *
 * El catálogo (`shared/rrna/catalogo.ts`) existía completo en el repo —diez categorías con su
 * autoridad y su fundamento en la RGCE 3.7.5-E— y no lo leía ni una línea de código.
 *
 * TODO EN ESTA PANTALLA ESTÁ DISEÑADO PARA QUE NO SE LEA COMO UN VEREDICTO, porque no lo es: la
 * coincidencia es por palabra clave y sobre el manifiesto de prueba cerca de la mitad son falsos
 * positivos ("Pistola de limpieza" cae en armas). De ahí tres decisiones:
 *
 *  - El aviso va ARRIBA, no en letra chica al pie.
 *  - Cada coincidencia muestra EL TÉRMINO que la disparó. Sin eso, descartar un falso positivo
 *    obliga a abrir la guía; con él se descarta de un vistazo, que es la diferencia entre una
 *    columna que se usa y una que se ignora.
 *  - Los colores son neutros. Pintarlo de rojo lo volvería un semáforo paralelo al de riesgo,
 *    con autoridad que esta heurística no tiene.
 */

interface Coincidencia {
  categoria: string;
  label: string;
  autoridad: string;
  descripcion: string;
  termino: string;
}

interface FilaRrna {
  shipmentId: string;
  guia: string | null;
  descripcion: string | null;
  hsCode: string | null;
  valorDeclarado: number | null;
  rrnaNoteDeclarada: string | null;
  coincidencias: Coincidencia[];
}

interface RespuestaRrna {
  analizadas: number;
  marcadas: number;
  porCategoria: Record<string, number>;
  aviso: string;
  filas: FilaRrna[];
}

export function PanelRrna({ manifestId }: { manifestId: string }) {
  const [data, setData] = useState<RespuestaRrna | null>(null);
  const [abierto, setAbierto] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let vivo = true;
    apiGet<RespuestaRrna>(`/api/manifests/${manifestId}/rrna`)
      .then((r) => { if (vivo) setData(r); })
      .catch(() => { if (vivo) setError(true); });
    return () => { vivo = false; };
  }, [manifestId]);

  // Sin coincidencias no se dibuja nada. Un panel que dice "0 hallazgos" en cada manifiesto
  // entrena a quien lo ve a saltárselo, y entonces no sirve el día que sí trae algo.
  if (error || !data || data.marcadas === 0) return null;

  return (
    <Card className="p-5">
      <button
        type="button"
        onClick={() => setAbierto((v) => !v)}
        className="flex w-full items-center gap-2 text-left"
      >
        {abierto ? <ChevronDown className="h-4 w-4 text-slate-400" /> : <ChevronRight className="h-4 w-4 text-slate-400" />}
        <ShieldQuestion className="h-4 w-4 text-slate-500" />
        <span className="text-sm font-bold text-slate-800">
          Posibles regulaciones no arancelarias
        </span>
        <span className="text-xs tabular-nums text-slate-500">
          {data.marcadas} de {data.analizadas} guías
        </span>
      </button>

      {abierto && (
        <div className="mt-4 space-y-4">
          <div className="flex items-start gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
            <span>{data.aviso}</span>
          </div>

          <div className="flex flex-wrap gap-2">
            {Object.entries(data.porCategoria).map(([cat, n]) => (
              <span key={cat} className="rounded-full bg-slate-100 px-2.5 py-1 text-[11px] font-medium text-slate-600">
                {cat} <span className="tabular-nums text-slate-400">{n}</span>
              </span>
            ))}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-[10px] font-bold uppercase tracking-wide text-slate-400">
                  <th className="py-2 pr-3 text-left">Guía</th>
                  <th className="py-2 pr-3 text-left">Descripción</th>
                  <th className="py-2 pr-3 text-left">Posible regulación</th>
                  <th className="py-2 pr-3 text-left">Declarado por el remitente</th>
                </tr>
              </thead>
              <tbody>
                {data.filas.map((f) => (
                  <tr key={f.shipmentId} className="border-b border-slate-100 align-top last:border-0">
                    <td className="py-2 pr-3 font-mono text-xs text-slate-600">{f.guia ?? '—'}</td>
                    <td className="max-w-[24rem] py-2 pr-3 text-slate-700">{f.descripcion ?? '—'}</td>
                    <td className="py-2 pr-3">
                      {f.coincidencias.length === 0 ? (
                        <span className="text-xs text-slate-400">—</span>
                      ) : (
                        <div className="space-y-1">
                          {f.coincidencias.map((c) => (
                            <div key={c.categoria} className="text-xs">
                              <span className="font-semibold text-slate-700">{c.label}</span>
                              <span className="ml-1.5 text-slate-500">{c.autoridad}</span>
                              {/* El término que disparó: sin esto no se puede descartar un falso
                                  positivo sin abrir la guía. */}
                              <span className="ml-1.5 text-slate-400">
                                por «<span className="font-mono">{c.termino}</span>»
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-xs text-slate-600">
                      {f.rrnaNoteDeclarada ?? <span className="text-slate-300">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Card>
  );
}
