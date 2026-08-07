import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ESTADOS_DOCUMENTALES,
  ESTADOS_PLANEACION,
  ETAPAS,
  ORIGENES_EVENTO,
  SEMAFOROS,
} from '../../../shared/operaciones/estados';

/**
 * The state vocabularies exist twice: as TypeScript arrays in shared/operaciones/estados.ts (used by
 * the app) and spelled out inline in the CHECK constraints of the migrations (migrations stay
 * dependency-free by house convention). A drift between the two is a nasty class of bug — the app
 * happily writes a value the database then rejects at runtime, on a path that only fires in
 * production. This test pins them together so the drift fails in CI instead.
 */
const MIGRATIONS = join(__dirname, '../../migrations');

function checkValues(source: string, column: string): string[] {
  // Matches:  <column> IN ('a','b',   'c')  across line breaks and string concatenation.
  const re = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`, 's');
  const m = source.match(re);
  if (!m) throw new Error(`no CHECK found for column ${column}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('ops state vocabularies match their migration CHECK constraints', () => {
  const operaciones = readFileSync(join(MIGRATIONS, '1700003800000_operaciones.ts'), 'utf8');
  const eventos = readFileSync(join(MIGRATIONS, '1700003900000_operacion_eventos.ts'), 'utf8');

  it('etapa', () => {
    expect(checkValues(operaciones, 'etapa')).toEqual([...ETAPAS]);
  });

  it('estado_documental', () => {
    expect(checkValues(operaciones, 'estado_documental')).toEqual([...ESTADOS_DOCUMENTALES]);
  });

  it('estado_planeacion', () => {
    expect(checkValues(operaciones, 'estado_planeacion')).toEqual([...ESTADOS_PLANEACION]);
  });

  it('semaforo stays in English for the client', () => {
    expect(checkValues(operaciones, 'semaforo')).toEqual([...SEMAFOROS]);
    expect(SEMAFOROS).not.toContain('verde');
  });

  it('origen', () => {
    expect(checkValues(eventos, 'origen')).toEqual([...ORIGENES_EVENTO]);
  });
});
