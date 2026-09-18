import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as XLSX from 'xlsx';
import { validateManifest } from '../parsing/validateManifest';
import { scoreManifest } from './classify';

describe('enhanced engine on the 501-row golden manifest', () => {
  const path = resolve(__dirname, '../parsing/__fixtures__/MANIFEST_TEST.xlsx');
  const wb = XLSX.read(readFileSync(path), { type: 'buffer' });
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '', blankrows: false });
  const header = (aoa[0] as unknown[]).map((h) => String(h ?? '').trim());
  const r = validateManifest(header, aoa.slice(1), 'GOLDEN');
  const ships = r.rows.filter((row) => row.status !== 'error').map((row) => row.shipment);

  it('no longer over-fires: rojo is 3-12%, verde is a meaningful majority', () => {
    const scored = scoreManifest(ships, {});
    const n = scored.length;
    const pct = (b: string) => scored.filter((s) => s.band === b).length / n;
    expect(pct('rojo')).toBeGreaterThanOrEqual(0.03);
    expect(pct('rojo')).toBeLessThanOrEqual(0.12);
    expect(pct('verde')).toBeGreaterThan(0.4); // repeat buyers are no longer all amarillo
  });

  it('la señal de descripción genérica casi no toca este manifiesto — y lo poco que toca, lo toca bien', () => {
    // Guarda de precisión, no de recall. Este fixture es e-commerce chino con descripciones
    // razonables ("Auriculares inalámbricos Para comunicación"), así que una señal bien calibrada
    // debe callarse en casi todas. Si un cambio al catálogo la hiciera disparar en decenas de
    // filas, se estaría barriendo medio manifiesto a la cola de revisión y este número lo delata.
    const scored = scoreManifest(ships, {});
    const conSenal = scored.filter((s) => s.reasons.some((r) => r.signalId === 'descripcion_generica'));
    expect(conSenal).toHaveLength(1);
    // La única: nombra el material y no el producto. Es un acierto, no un falso positivo.
    expect(conSenal[0].shipment.description).toContain('Plástico de cristal');
    expect(conSenal[0].reasons.find((r) => r.signalId === 'descripcion_generica')?.evidence?.veredicto)
      .toBe('solo_material');
  });

  it('every row carries reasons-array, 0-100 score, and a ruleset hash', () => {
    const scored = scoreManifest(ships, {});
    expect(scored[0].ruleset_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof scored[0].score).toBe('number');
    expect(Array.isArray(scored[0].reasons)).toBe(true);
  });
});
