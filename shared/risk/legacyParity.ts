// shared/risk/legacyParity.ts
import type { Shipment } from '../types/shipment';
import { PIRACY_BRANDS, PROHIBITED_KEYWORDS } from './lists';

export interface LegacyRow {
  resultado: 'Verde' | 'Amarillo' | 'Rojo';
  suma: number;
  incidences: string[];
}

const norm = (s: string): string =>
  (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
const idLen = (id: string): number => (id ?? '').replace(/\s+/g, '').length;
const search = (desc: string, terms: string[]): boolean => {
  const d = norm(desc);
  return terms.some((t) => d.includes(norm(t)));
};

/** Faithful reproduction of the client Excel risk logic (8 equal-weight signals, <2/2-3/>=4 bands). */
export function scoreLegacyParity(shipments: Shipment[], monthlyDbNames: Set<string>): LegacyRow[] {
  const nameCount = new Map<string, number>();
  const addrCount = new Map<string, number>();
  for (const s of shipments) {
    const n = norm(s.consignee.name);
    const a = norm(s.consignee.address ?? '');
    nameCount.set(n, (nameCount.get(n) ?? 0) + 1);
    if (a) addrCount.set(a, (addrCount.get(a) ?? 0) + 1);
  }
  return shipments.map((s) => {
    const idRaw = (s.consignee.curp ?? s.consignee.rfc ?? '');
    const len = idLen(idRaw);
    const n = norm(s.consignee.name);
    const a = norm(s.consignee.address ?? '');
    const inc: string[] = [];
    let suma = 0;
    const fire = (cond: boolean, label: string) => { if (cond) { suma += 1; inc.push(label); } };

    fire(!(len === 13 || len === 18), 'Falta RFC/CURP');
    fire(s.quantity > 10, 'Demasiados productos');
    fire(s.customsValueUsd < 1 || s.customsValueUsd > 2500, 'Valor declarado incorrecto');
    fire((nameCount.get(n) ?? 0) !== 1, 'Varios paquetes por consignatario');
    fire(!!a && (addrCount.get(a) ?? 0) !== 1, 'Misma dirección de entrega');
    fire(search(s.description, PROHIBITED_KEYWORDS), 'Articulos prohibidos');
    fire(search(s.description, PIRACY_BRANDS), 'Piratería');
    fire(monthlyDbNames.has(n), 'Varias importaciones en el mes');

    const resultado = suma < 2 ? 'Verde' : suma < 4 ? 'Amarillo' : 'Rojo';
    return { resultado, suma, incidences: inc };
  });
}
