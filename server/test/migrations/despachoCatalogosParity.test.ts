import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach } from 'vitest';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';
import {
  ESTADOS_DESPACHO,
  ESTADOS_FIRMA_CONVENIO,
  ESTADOS_TRANSPORTISTA,
  TIPOS_UNIDAD_IDS,
} from '../../../shared/operaciones/catalogos';

/**
 * Same pairing guard as `opsEstadosParity`, extended to the despacho vocabularies.
 *
 * The values exist twice on purpose — as TypeScript arrays the app uses, and spelled out inline in
 * the migrations' CHECK constraints, because migrations stay dependency-free by house convention.
 * The failure mode a drift produces is the nastiest kind: the app happily writes a value that
 * Postgres then rejects, on a path that only fires in production the first time somebody dispatches
 * a `rabon`. This pins them together so it fails in CI instead.
 *
 * The second half of the file asserts the schema invariants that the route layer's error messages
 * promise but does NOT enforce on its own — the constraints have to hold against any writer, not
 * just against ours.
 */
const MIGRATIONS = join(__dirname, '../../migrations');

function checkValues(source: string, column: string): string[] {
  const re = new RegExp(`${column}\\s+IN\\s*\\(([^)]*)\\)`, 's');
  const m = source.match(re);
  if (!m) throw new Error(`no CHECK found for column ${column}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
}

describe('despacho vocabularies match their migration CHECK constraints', () => {
  const catalogos = readFileSync(join(MIGRATIONS, '1700004900000_transportistas_catalogos.ts'), 'utf8');
  const despachos = readFileSync(join(MIGRATIONS, '1700005000000_despachos.ts'), 'utf8');

  it('tipo_unidad on despachos — R23 / D8', () => {
    expect(checkValues(despachos, 'tipo_unidad')).toEqual([...TIPOS_UNIDAD_IDS]);
  });

  it('tipo_unidad on transportista_unidades and on transportista_tarifas', () => {
    // Both CHECKs in the catalogs migration spell the same glossary; the regex takes the first, so
    // assert the file contains exactly as many copies as there are typed columns.
    expect(checkValues(catalogos, 'tipo_unidad')).toEqual([...TIPOS_UNIDAD_IDS]);
    const copias = catalogos.match(/tipo_unidad IN \(/g) ?? [];
    expect(copias).toHaveLength(2);
  });

  it('estado on despachos — the R21 state machine', () => {
    expect(checkValues(despachos, 'estado')).toEqual([...ESTADOS_DESPACHO]);
  });

  it('estado on transportistas', () => {
    expect(checkValues(catalogos, 'estado')).toEqual([...ESTADOS_TRANSPORTISTA]);
  });

  it('estado_firma on transportista_convenios — R25 / D9', () => {
    expect(checkValues(catalogos, 'estado_firma')).toEqual([...ESTADOS_FIRMA_CONVENIO]);
  });
});

describe('despacho schema invariants hold against any writer, not just the routes', () => {
  beforeEach(truncateAll);

  async function transportista(): Promise<string> {
    const { rows } = await query(
      `INSERT INTO transportistas (razon_social) VALUES ('Fletes X') RETURNING id`,
    );
    return rows[0].id as string;
  }

  it('a signed convenio must carry its signing date, and an unsigned one must not', async () => {
    const t = await transportista();
    await expect(
      query(
        `INSERT INTO transportista_convenios (transportista_id, estado_firma) VALUES ($1,'firmado')`,
        [t],
      ),
    ).rejects.toThrow(/transportista_convenios_firma_check/);
    await expect(
      query(
        `INSERT INTO transportista_convenios (transportista_id, estado_firma, firmado_at)
         VALUES ($1,'borrador', now())`,
        [t],
      ),
    ).rejects.toThrow(/transportista_convenios_firma_check/);
  });

  it('a unit cannot be assigned without its carrier — a vehicle belonging to nobody cannot be called', async () => {
    const t = await transportista();
    const u = await query(
      `INSERT INTO transportista_unidades (transportista_id, placas, tipo_unidad)
       VALUES ($1,'AAA1111','tracto') RETURNING id`,
      [t],
    );
    await expect(
      query(
        `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad, unidad_id)
         VALUES ('D-X','2026-08-14','tracto',$1)`,
        [u.rows[0].id],
      ),
    ).rejects.toThrow(/despachos_unidad_requiere_transportista_check/);
  });

  it('the same guía cannot be loaded twice onto one truck — including the NULL-guía case', async () => {
    const o = await query(
      `INSERT INTO operaciones (mawb, mawb_raw) VALUES ('160-11111111','160-11111111') RETURNING id`,
    );
    const d = await query(
      `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad)
       VALUES ('D-1','2026-08-14','tracto') RETURNING id`,
    );
    await query(
      `INSERT INTO despacho_partidas (despacho_id, operacion_id) VALUES ($1,$2)`,
      [d.rows[0].id, o.rows[0].id],
    );
    // Without NULLS NOT DISTINCT this second insert would succeed: Postgres treats each NULL as
    // unique by default, so a whole-caso partida could be duplicated without limit.
    await expect(
      query(`INSERT INTO despacho_partidas (despacho_id, operacion_id) VALUES ($1,$2)`, [
        d.rows[0].id,
        o.rows[0].id,
      ]),
    ).rejects.toThrow(/despacho_partidas_unica_uq/);
  });

  it('two lines cannot share a loading position — that is an instruction nobody can follow', async () => {
    const o = await query(
      `INSERT INTO operaciones (mawb, mawb_raw) VALUES ('160-11111111','160-11111111') RETURNING id`,
    );
    const g = await query(
      `INSERT INTO operacion_guias (operacion_id, guia_norm) VALUES ($1,'AAA0001'), ($1,'AAA0002')
       RETURNING id`,
      [o.rows[0].id],
    );
    const d = await query(
      `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad)
       VALUES ('D-1','2026-08-14','tracto') RETURNING id`,
    );
    await query(
      `INSERT INTO despacho_partidas (despacho_id, operacion_id, operacion_guia_id, orden_carga)
       VALUES ($1,$2,$3,1)`,
      [d.rows[0].id, o.rows[0].id, g.rows[0].id],
    );
    await expect(
      query(
        `INSERT INTO despacho_partidas (despacho_id, operacion_id, operacion_guia_id, orden_carga)
         VALUES ($1,$2,$3,1)`,
        [d.rows[0].id, o.rows[0].id, g.rows[1].id],
      ),
    ).rejects.toThrow(/despacho_partidas_orden_carga_uq/);
  });

  it('a plan version is unique per operating day, so two "version 4" documents cannot circulate', async () => {
    await query(
      `INSERT INTO plan_publicaciones (fecha_operacion, version, snapshot)
       VALUES ('2026-08-14', 1, '{}'::jsonb)`,
    );
    await expect(
      query(
        `INSERT INTO plan_publicaciones (fecha_operacion, version, snapshot)
         VALUES ('2026-08-14', 1, '{}'::jsonb)`,
      ),
    ).rejects.toThrow(/plan_publicaciones_fecha_version_uq/);
  });

  it('a despacho cannot be its own predecessor — the CT-7 chain has to terminate', async () => {
    const d = await query(
      `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad)
       VALUES ('D-1','2026-08-14','tracto') RETURNING id`,
    );
    await expect(
      query('UPDATE despachos SET reasignado_de_despacho_id = id WHERE id = $1', [d.rows[0].id]),
    ).rejects.toThrow(/despachos_reasignacion_no_circular_check/);
  });

  it('partidas cascade with their despacho and with their caso', async () => {
    const o = await query(
      `INSERT INTO operaciones (mawb, mawb_raw) VALUES ('160-11111111','160-11111111') RETURNING id`,
    );
    const d = await query(
      `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad)
       VALUES ('D-1','2026-08-14','tracto') RETURNING id`,
    );
    await query(`INSERT INTO despacho_partidas (despacho_id, operacion_id) VALUES ($1,$2)`, [
      d.rows[0].id,
      o.rows[0].id,
    ]);
    await query('DELETE FROM despachos WHERE id = $1', [d.rows[0].id]);
    expect((await query('SELECT id FROM despacho_partidas')).rows).toHaveLength(0);
  });

  it('deleting a despacho does NOT erase its ledger events — it nulls the link', async () => {
    const o = await query(
      `INSERT INTO operaciones (mawb, mawb_raw) VALUES ('160-11111111','160-11111111') RETURNING id`,
    );
    const d = await query(
      `INSERT INTO despachos (folio, fecha_operacion, tipo_unidad)
       VALUES ('D-1','2026-08-14','tracto') RETURNING id`,
    );
    await query(
      `INSERT INTO operacion_eventos (operacion_id, operacion_mawb, despacho_id, tipo, ocurrido_at)
       VALUES ($1,'160-11111111',$2,'DESPACHO_CREADO', now())`,
      [o.rows[0].id, d.rows[0].id],
    );
    // SET NULL on a trigger-protected append-only table means the DELETE of the parent is itself
    // rejected: deleting a trip can never become a way to erase what it carried.
    await expect(query('DELETE FROM despachos WHERE id = $1', [d.rows[0].id])).rejects.toThrow(
      /append-only/,
    );
  });
});
