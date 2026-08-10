import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { UNIDADES_TARIFA } from '../../../shared/operaciones/facturacion';

/**
 * Same contract as `opsEstadosParity`: the billing vocabularies exist twice — as TypeScript arrays
 * the app prices with, and spelled out inline in the CHECK constraints of the migration (migrations
 * stay dependency-free by house convention). A drift here means the app happily computes a line the
 * database then rejects, on a path that only fires at month end.
 *
 * `unidad` appears in TWO tables on purpose — the rate card and the invoice line — and both are
 * checked, because a line whose unit the rate card cannot express is a price nobody agreed to.
 */
const MIGRACION = join(__dirname, '../../migrations/1700005300000_facturacion.ts');

function checkValues(source: string, column: string, ocurrencia = 0): string[] {
  const re = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`, 'gs');
  const matches = [...source.matchAll(re)];
  if (matches.length <= ocurrencia) throw new Error(`no CHECK #${ocurrencia} found for column ${column}`);
  return [...matches[ocurrencia][1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('facturación vocabularies match their migration CHECK constraints', () => {
  const source = readFileSync(MIGRACION, 'utf8');

  it('client_tarifas.unidad', () => {
    expect(checkValues(source, 'unidad', 0)).toEqual([...UNIDADES_TARIFA]);
  });

  it('factura_partidas.unidad', () => {
    expect(checkValues(source, 'unidad', 1)).toEqual([...UNIDADES_TARIFA]);
  });

  it('a factura is either a proforma or a CFDI — nothing in between claims to be fiscal', () => {
    expect(checkValues(source, 'tipo')).toEqual(['proforma', 'cfdi']);
  });
});
