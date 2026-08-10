import { describe, expect, it } from 'vitest';
import { TIPOS_EVENTO } from './estados';
import {
  ACCIONES_AUTOMATICAS,
  EVENTO_POR_ACCION,
  REPLAN_RULESET,
  REPLAN_RULESET_HASH,
  REPLAN_RULESET_VERSION,
  TIPOS_ACCION,
  claveAccion,
  contingenciaPorHold,
  demoraHoras,
  esAutomatica,
  evaluarContingencias,
  planeacionTrasContingencia,
  type AccionPropuesta,
  type EstadoOperativo,
} from './replan';

/**
 * The contingency engine (PRD-02 §8.8, CT-1…CT-7).
 *
 * What these tests defend is the difference between the paper process and this one. Each case below
 * is a way money was lost or a shipment went quiet:
 *
 *   - CT-1: a fourteen-hour delay with a truck already contracted. The truck must be REASSIGNED, not
 *     cancelled (D10) — a cancelled truck is still billed, a reassigned one only changes tarifa.
 *   - CT-7 is never automatic. It changes a price, so a human confirms it with a logged motivo
 *     (D6/R20). If this ever flipped to `automatica` the platform would be committing spend on its
 *     own, which is the one thing nobody in the meeting asked for.
 *   - The engine must not stutter: the tick re-evaluates every few minutes and the ledger is
 *     append-only, so identical facts must produce identical fingerprints.
 *   - Absence of evidence is not evidence: no guías (manifest not ingested yet) must NOT exclude a
 *     healthy caso, and an unknown ETA must not manufacture a delay.
 */

const AHORA = '2026-08-10T18:00:00.000Z';

function estado(over: Partial<EstadoOperativo> = {}): EstadoOperativo {
  return {
    ahora: AHORA,
    operacion: {
      id: 'op-1',
      mawb: '160-05930216',
      etapa: 'en_vuelo',
      estadoPlaneacion: 'planeada',
      estadoDocumental: 'cotejado',
      etaPais: '2026-08-10T22:00:00.000Z',
      discrepancias: [],
      ...(over.operacion ?? {}),
    },
    vuelo: over.vuelo ?? null,
    holds: over.holds ?? [],
    retenciones: over.retenciones ?? [],
    guias: over.guias ?? [],
    despachos: over.despachos ?? [],
    candidatas: over.candidatas ?? [],
    ...(over.ahora ? { ahora: over.ahora } : {}),
  } as EstadoOperativo;
}

function tipos(acciones: AccionPropuesta[]): string[] {
  return acciones.map((a) => `${a.contingencia}:${a.tipo}`);
}

function de(acciones: AccionPropuesta[], tipo: AccionPropuesta['tipo']): AccionPropuesta[] {
  return acciones.filter((a) => a.tipo === tipo);
}

const vueloOk = {
  numeroVuelo: 'CI5218',
  estado: 'en_ruta',
  etaProgramado: '2026-08-10T22:00:00.000Z',
  etaEstimado: '2026-08-10T22:20:00.000Z',
  arriboReal: null,
  destinoIata: 'NLU',
};

describe('ruleset', () => {
  it('is version-stamped and hashed, like the risk engine', () => {
    expect(REPLAN_RULESET_VERSION).toBe('2026-08a');
    expect(REPLAN_RULESET.version).toBe(REPLAN_RULESET_VERSION);
    expect(REPLAN_RULESET_HASH).toMatch(/^[0-9a-f]{64}$/);
  });

  it('never lets the engine spend money by itself (D6/R20)', () => {
    expect(ACCIONES_AUTOMATICAS).not.toContain('reasignar_despacho');
    expect(esAutomatica({ tipo: 'reasignar_despacho' } as AccionPropuesta)).toBe(false);
    for (const t of ACCIONES_AUTOMATICAS) {
      expect(esAutomatica({ tipo: t } as AccionPropuesta)).toBe(true);
    }
  });

  it('maps every action onto a ledger event that actually exists', () => {
    for (const t of TIPOS_ACCION) {
      const evento = EVENTO_POR_ACCION[t];
      expect(evento).toBeTruthy();
      expect(TIPOS_EVENTO).toContain(evento);
    }
  });
});

describe('etapas cerradas', () => {
  it('does not replan cargo already on the truck or a finished caso', () => {
    for (const etapa of ['en_transito', 'entregado', 'cerrada', 'cancelada'] as const) {
      const acciones = evaluarContingencias(
        estado({
          operacion: { ...estado().operacion, etapa, estadoPlaneacion: 'asignada' },
          vuelo: { ...vueloOk, estado: 'cancelado' },
        }),
      );
      expect(acciones).toEqual([]);
    }
  });
});

describe('CT-1 · vuelo', () => {
  it('a cancelled flight excludes, notifies almacén and cliente, and does NOT invent a new date', () => {
    const acciones = evaluarContingencias(
      estado({ vuelo: { ...vueloOk, estado: 'cancelado', etaEstimado: null } }),
    );
    expect(tipos(acciones)).toContain('CT-1:excluir_del_plan');
    expect(de(acciones, 'reprogramar')).toHaveLength(0);
    const destinatarios = de(acciones, 'notificar').map((a) => (a as any).destinatario);
    expect(destinatarios).toEqual(expect.arrayContaining(['almacen', 'cliente']));
    expect(de(acciones, 'notificar').every((a) => (a as any).plantilla === 'vuelo_cancelado')).toBe(true);
  });

  it('a 14-hour delay reprograms to the new calendar date and pulls the caso from today', () => {
    const acciones = evaluarContingencias(
      estado({
        vuelo: {
          ...vueloOk,
          estado: 'demorado',
          etaProgramado: '2026-08-10T22:00:00.000Z',
          etaEstimado: '2026-08-11T12:00:00.000Z',
        },
      }),
    );
    const repro = de(acciones, 'reprogramar')[0] as any;
    expect(repro.nuevaFecha).toBe('2026-08-11');
    expect(repro.ejecucion).toBe('automatica');
    expect(tipos(acciones)).toContain('CT-1:excluir_del_plan');
  });

  it('does not reprogram when the delay stays inside the same day', () => {
    const acciones = evaluarContingencias(
      estado({
        vuelo: {
          ...vueloOk,
          estado: 'demorado',
          etaProgramado: '2026-08-10T06:00:00.000Z',
          etaEstimado: '2026-08-10T16:00:00.000Z',
        },
      }),
    );
    // Still CT-1 — ten hours is out of today's dispatch window — but the date did not move.
    expect(tipos(acciones)).toContain('CT-1:excluir_del_plan');
    expect(de(acciones, 'reprogramar')).toHaveLength(0);
  });

  it('a delay under the tolerance is not a contingency', () => {
    const acciones = evaluarContingencias(estado({ vuelo: vueloOk }));
    expect(acciones).toEqual([]);
  });

  it('an unknown ETA never manufactures a delay', () => {
    const acciones = evaluarContingencias(
      estado({
        operacion: { ...estado().operacion, etaPais: null },
        vuelo: { ...vueloOk, etaProgramado: null, etaEstimado: null },
      }),
    );
    expect(demoraHoras({ ...vueloOk, etaProgramado: null, etaEstimado: null }, null)).toBeNull();
    expect(acciones).toEqual([]);
  });

  it('falls back to the declared eta_pais when the feed has no schedule', () => {
    const d = demoraHoras(
      { ...vueloOk, etaProgramado: null, etaEstimado: '2026-08-11T04:00:00.000Z' },
      '2026-08-10T22:00:00.000Z',
    );
    expect(d).toBe(6);
  });

  it('only warns the transportista when a unit is actually committed', () => {
    const base = { vuelo: { ...vueloOk, estado: 'cancelado' } };
    const sinUnidad = evaluarContingencias(estado(base));
    expect(de(sinUnidad, 'notificar').map((a) => (a as any).destinatario)).not.toContain('transportista');

    const conUnidad = evaluarContingencias(
      estado({
        ...base,
        despachos: [{ id: 'd-1', estado: 'confirmado', fechaOperacion: '2026-08-10', destinoIata: 'NLU' }],
      }),
    );
    expect(de(conUnidad, 'notificar').map((a) => (a as any).destinatario)).toContain('transportista');
  });

  it('leaves a caso with no plan alone except for the notifications', () => {
    const acciones = evaluarContingencias(
      estado({
        operacion: { ...estado().operacion, estadoPlaneacion: 'sin_plan' },
        vuelo: { ...vueloOk, estado: 'cancelado' },
      }),
    );
    expect(de(acciones, 'excluir_del_plan')).toHaveLength(0);
    expect(de(acciones, 'notificar').length).toBeGreaterThan(0);
  });
});

describe('CT-2 · guía no transmitida', () => {
  it('notifies the client but keeps the caso in the plan while other guías can ship', () => {
    const acciones = evaluarContingencias(
      estado({
        guias: [
          { id: 'g1', guiaNorm: 'ABC123', estado: 'no_transmitida' },
          { id: 'g2', guiaNorm: 'DEF456', estado: 'declarada' },
        ],
      }),
    );
    expect(tipos(acciones)).toContain('CT-2:notificar');
    expect(de(acciones, 'excluir_del_plan')).toHaveLength(0);
    expect((de(acciones, 'notificar')[0] as any).motivo).toContain('ABC123');
  });

  it('excludes the caso when nothing left on it can be dispatched', () => {
    const acciones = evaluarContingencias(
      estado({
        guias: [
          { id: 'g1', guiaNorm: 'ABC123', estado: 'no_transmitida' },
          { id: 'g2', guiaNorm: 'DEF456', estado: 'retenida' },
        ],
      }),
    );
    expect(tipos(acciones)).toContain('CT-2:excluir_del_plan');
  });

  it('a caso with no guías yet is not excluded — the manifest simply has not arrived', () => {
    const acciones = evaluarContingencias(estado({ guias: [] }));
    expect(acciones).toEqual([]);
  });
});

describe('CT-3 · CSA', () => {
  it('opens the csa hold and asks the client for the cesión when PA-09 fires', () => {
    const acciones = evaluarContingencias(
      estado({ operacion: { ...estado().operacion, discrepancias: ['PA-01', 'PA-09'] } }),
    );
    const hold = de(acciones, 'abrir_hold')[0] as any;
    expect(hold.tipoHold).toBe('csa');
    expect(hold.alcance).toBe('operacion');
    expect(hold.ejecucion).toBe('automatica');
    expect(de(acciones, 'notificar').map((a) => (a as any).plantilla)).toContain('solicitud_csa');
  });

  it('does not open a second hold when one is already open', () => {
    const acciones = evaluarContingencias(
      estado({
        operacion: { ...estado().operacion, discrepancias: ['PA-09'] },
        holds: [
          { id: 'h1', tipo: 'csa', alcance: 'operacion', operacionGuiaId: null, motivo: 'falta CSA' },
        ],
      }),
    );
    expect(de(acciones, 'abrir_hold')).toHaveLength(0);
    // …but the caso still leaves the plan because the hold is active.
    expect(tipos(acciones)).toContain('CT-3:excluir_del_plan');
  });
});

describe('CT-4 · requerimiento de riesgo vencido', () => {
  it('opens the riesgo hold and escalates to cliente and dirección', () => {
    const acciones = evaluarContingencias(
      estado({ operacion: { ...estado().operacion, estadoDocumental: 'riesgo_vencido' } }),
    );
    expect((de(acciones, 'abrir_hold')[0] as any).tipoHold).toBe('riesgo');
    const dest = de(acciones, 'notificar').map((a) => (a as any).destinatario);
    expect(dest).toEqual(expect.arrayContaining(['cliente', 'direccion']));
  });
});

describe('holds activos · la mitad que routes/holds.ts deliberadamente no hace', () => {
  it('maps each hold type onto the contingency that owns it', () => {
    expect(contingenciaPorHold('auditoria_autoridad')).toBe('CT-6');
    expect(contingenciaPorHold('csa')).toBe('CT-3');
    expect(contingenciaPorHold('no_transmitida')).toBe('CT-2');
    expect(contingenciaPorHold('riesgo')).toBe('CT-4');
    // Documented fallback: everything else is "blocked pending the client", i.e. CT-4's shape.
    expect(contingenciaPorHold('documental')).toBe('CT-4');
    expect(contingenciaPorHold('otro')).toBe('CT-4');
  });

  it('emits one exclusion per contingency, not per hold row', () => {
    const acciones = evaluarContingencias(
      estado({
        holds: [
          { id: 'h1', tipo: 'documental', alcance: 'operacion', operacionGuiaId: null, motivo: 'falta factura' },
          { id: 'h2', tipo: 'otro', alcance: 'operacion', operacionGuiaId: null, motivo: 'pendiente' },
        ],
      }),
    );
    expect(de(acciones, 'excluir_del_plan')).toHaveLength(1);
  });

  it('always states the hold motivo in the ledger wording', () => {
    const acciones = evaluarContingencias(
      estado({
        holds: [
          { id: 'h1', tipo: 'csa', alcance: 'operacion', operacionGuiaId: null, motivo: 'consignada a otra agencia' },
        ],
      }),
    );
    expect((de(acciones, 'excluir_del_plan')[0] as any).motivo).toContain('consignada a otra agencia');
  });
});

describe('CT-5 · retenciones', () => {
  it('a partial retención only obliges a notification: the rest of the load still ships', () => {
    const acciones = evaluarContingencias(
      estado({
        retenciones: [{ id: 'r1', alcance: 'parcial', estado: 'retenida', operacionGuiaId: 'g1' }],
      }),
    );
    expect(de(acciones, 'excluir_del_plan')).toHaveLength(0);
    expect(de(acciones, 'notificar').map((a) => (a as any).plantilla)).toContain('retencion_parcial');
  });

  it('a total retención takes the caso out of the plan', () => {
    const acciones = evaluarContingencias(
      estado({ retenciones: [{ id: 'r1', alcance: 'total', estado: 'retenida', operacionGuiaId: null }] }),
    );
    expect(tipos(acciones)).toContain('CT-5:excluir_del_plan');
  });

  it('ignores retenciones already released', () => {
    const acciones = evaluarContingencias(
      estado({ retenciones: [{ id: 'r1', alcance: 'total', estado: 'liberada', operacionGuiaId: null }] }),
    );
    expect(acciones).toEqual([]);
  });
});

describe('CT-6 · hold global', () => {
  it('suspends unit requests, excludes and warns the carrier — the flete en falso guard', () => {
    const acciones = evaluarContingencias(
      estado({
        holds: [
          {
            id: 'h1',
            tipo: 'auditoria_autoridad',
            alcance: 'global',
            operacionGuiaId: null,
            motivo: 'auditoría de la autoridad en el almacén',
          },
        ],
      }),
    );
    expect(tipos(acciones)).toContain('CT-6:suspender_solicitud_unidades');
    expect(tipos(acciones)).toContain('CT-6:excluir_del_plan');
    expect(de(acciones, 'notificar').map((a) => (a as any).destinatario)).toContain('transportista');
  });

  it('suspends unit requests even for a caso that was never programmed', () => {
    const acciones = evaluarContingencias(
      estado({
        operacion: { ...estado().operacion, estadoPlaneacion: 'sin_plan' },
        holds: [
          { id: 'h1', tipo: 'auditoria_autoridad', alcance: 'global', operacionGuiaId: null, motivo: 'auditoría' },
        ],
      }),
    );
    expect(tipos(acciones)).toContain('CT-6:suspender_solicitud_unidades');
    expect(de(acciones, 'excluir_del_plan')).toHaveLength(0);
  });
});

describe('CT-7 · reasignación anti-flete-en-falso', () => {
  const candidatas = Array.from({ length: 8 }, (_, i) => ({
    operacionId: `cand-${i}`,
    mawb: `160-0000000${i}`,
    destinoIata: 'NLU',
    razon: 'arribada y sin bloqueos',
  }));

  it('proposes — never executes — and says so in the motivo', () => {
    const acciones = evaluarContingencias(
      estado({
        vuelo: { ...vueloOk, estado: 'cancelado' },
        despachos: [{ id: 'd-1', estado: 'confirmado', fechaOperacion: '2026-08-10', destinoIata: 'NLU' }],
        candidatas,
      }),
    );
    const prop = de(acciones, 'reasignar_despacho')[0] as any;
    expect(prop.ejecucion).toBe('propuesta');
    expect(esAutomatica(prop)).toBe(false);
    expect(prop.motivo).toContain('flete en falso');
    expect(prop.despachoId).toBe('d-1');
  });

  it('caps the candidate list so a coordinator gets a short list, not a report', () => {
    const acciones = evaluarContingencias(
      estado({ vuelo: { ...vueloOk, estado: 'cancelado' }, despachos: [], candidatas, operacion: { ...estado().operacion, estadoPlaneacion: 'asignada' } }),
    );
    const prop = de(acciones, 'reasignar_despacho')[0] as any;
    expect(prop.candidatas).toHaveLength(REPLAN_RULESET.maxCandidatas);
  });

  it('still raises the proposal when it found nowhere to send the unit', () => {
    const acciones = evaluarContingencias(
      estado({
        vuelo: { ...vueloOk, estado: 'cancelado' },
        despachos: [{ id: 'd-1', estado: 'solicitado', fechaOperacion: '2026-08-10', destinoIata: 'NLU' }],
        candidatas: [],
      }),
    );
    const prop = de(acciones, 'reasignar_despacho')[0] as any;
    expect(prop.candidatas).toEqual([]);
    expect(prop.motivo).toContain('No se encontró candidata');
  });

  it('ignores units that already left or were cancelled', () => {
    const acciones = evaluarContingencias(
      estado({
        vuelo: { ...vueloOk, estado: 'cancelado' },
        operacion: { ...estado().operacion, estadoPlaneacion: 'planeada' },
        despachos: [
          { id: 'd-1', estado: 'entregado', fechaOperacion: '2026-08-10', destinoIata: 'NLU' },
          { id: 'd-2', estado: 'cancelado', fechaOperacion: '2026-08-10', destinoIata: 'NLU' },
        ],
      }),
    );
    expect(de(acciones, 'reasignar_despacho')).toHaveLength(0);
  });

  it('falls back to the `asignada` signal while the despachos table does not exist yet (#29)', () => {
    const acciones = evaluarContingencias(
      estado({
        operacion: { ...estado().operacion, estadoPlaneacion: 'asignada' },
        vuelo: { ...vueloOk, estado: 'cancelado' },
        despachos: [],
        candidatas: candidatas.slice(0, 2),
      }),
    );
    const prop = de(acciones, 'reasignar_despacho')[0] as any;
    expect(prop.despachoId).toBeNull();
    expect(prop.candidatas).toHaveLength(2);
  });

  it('does not propose anything when the caso keeps its cargo', () => {
    const acciones = evaluarContingencias(
      estado({
        operacion: { ...estado().operacion, estadoPlaneacion: 'asignada' },
        vuelo: vueloOk,
        guias: [{ id: 'g1', guiaNorm: 'ABC', estado: 'declarada' }],
        candidatas,
      }),
    );
    expect(de(acciones, 'reasignar_despacho')).toHaveLength(0);
  });

  it('fires on a freeze too: a frozen caso still has a truck waiting for it', () => {
    const acciones = evaluarContingencias(
      estado({
        operacion: { ...estado().operacion, estadoPlaneacion: 'asignada' },
        holds: [
          { id: 'h1', tipo: 'auditoria_autoridad', alcance: 'global', operacionGuiaId: null, motivo: 'auditoría' },
        ],
        candidatas: [],
      }),
    );
    expect(tipos(acciones)).toContain('CT-7:reasignar_despacho');
  });
});

describe('determinismo e idempotencia', () => {
  const complejo = () =>
    estado({
      operacion: {
        ...estado().operacion,
        estadoPlaneacion: 'asignada',
        estadoDocumental: 'riesgo_vencido',
        discrepancias: ['PA-09'],
      },
      vuelo: { ...vueloOk, estado: 'cancelado' },
      guias: [{ id: 'g1', guiaNorm: 'ABC', estado: 'no_transmitida' }],
      retenciones: [{ id: 'r1', alcance: 'parcial', estado: 'retenida', operacionGuiaId: 'g1' }],
      holds: [{ id: 'h1', tipo: 'csa', alcance: 'operacion', operacionGuiaId: null, motivo: 'falta CSA' }],
      candidatas: [{ operacionId: 'c1', mawb: '160-1', destinoIata: 'NLU', razon: 'arribada' }],
    });

  it('produces byte-identical output for identical facts', () => {
    const a = evaluarContingencias(complejo());
    const b = evaluarContingencias(complejo());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('emits every action exactly once, keyed by a stable fingerprint', () => {
    const acciones = evaluarContingencias(complejo());
    const claves = acciones.map(claveAccion);
    expect(new Set(claves).size).toBe(claves.length);
    expect(claves).toEqual([...claves].filter(Boolean));
  });

  it('never mutates the snapshot it was given', () => {
    const s = complejo();
    const antes = JSON.stringify(s);
    evaluarContingencias(s);
    expect(JSON.stringify(s)).toBe(antes);
  });

  it('gives every action a stated reason — a silent block is not auditable', () => {
    for (const a of evaluarContingencias(complejo())) {
      expect(a.motivo.trim().length).toBeGreaterThan(10);
      expect(a.contingencia).toMatch(/^CT-[1-7]$/);
    }
  });

  it('a second untransmitted guía is a second decision, not a repeat of the first', () => {
    const una = evaluarContingencias(
      estado({ guias: [{ id: 'g1', guiaNorm: 'AAA', estado: 'no_transmitida' }] }),
    );
    const dos = evaluarContingencias(
      estado({
        guias: [
          { id: 'g1', guiaNorm: 'AAA', estado: 'no_transmitida' },
          { id: 'g2', guiaNorm: 'BBB', estado: 'no_transmitida' },
        ],
      }),
    );
    expect(claveAccion(de(una, 'notificar')[0])).not.toBe(claveAccion(de(dos, 'notificar')[0]));
  });

  it('the fingerprint ignores volatile detail: a changed candidate list is the same decision', () => {
    const con = (n: number) =>
      evaluarContingencias(
        estado({
          operacion: { ...estado().operacion, estadoPlaneacion: 'asignada' },
          vuelo: { ...vueloOk, estado: 'cancelado' },
          candidatas: Array.from({ length: n }, (_, i) => ({
            operacionId: `c${i}`,
            mawb: `m${i}`,
            destinoIata: 'NLU',
            razon: 'x',
          })),
        }),
      );
    expect(claveAccion(de(con(1), 'reasignar_despacho')[0])).toBe(
      claveAccion(de(con(3), 'reasignar_despacho')[0]),
    );
  });

  it('a new reprogramming date is a new decision and gets its own fingerprint', () => {
    const base: AccionPropuesta = {
      tipo: 'reprogramar',
      contingencia: 'CT-1',
      operacionId: 'op-1',
      nuevaFecha: '2026-08-11',
      ejecucion: 'automatica',
      motivo: 'x',
    };
    expect(claveAccion(base)).not.toBe(claveAccion({ ...base, nuevaFecha: '2026-08-12' }));
  });
});

describe('planeacionTrasContingencia', () => {
  const excluir: AccionPropuesta[] = [
    { tipo: 'excluir_del_plan', contingencia: 'CT-1', operacionId: 'op-1', ejecucion: 'automatica', motivo: 'x' },
  ];

  it('a programmed caso is excluded; an assigned one is replanned (the state machine has no asignada→excluida edge)', () => {
    expect(planeacionTrasContingencia('planeada', excluir)).toBe('excluida');
    expect(planeacionTrasContingencia('asignada', excluir)).toBe('replanificada');
  });

  it('writes nothing when there is nothing to pull from the plan', () => {
    expect(planeacionTrasContingencia('sin_plan', excluir)).toBeNull();
    expect(planeacionTrasContingencia('cumplida', excluir)).toBeNull();
    expect(planeacionTrasContingencia('replanificada', excluir)).toBeNull();
    expect(planeacionTrasContingencia('planeada', [])).toBeNull();
  });

  it('a notification alone never moves the planning axis', () => {
    const soloAviso: AccionPropuesta[] = [
      {
        tipo: 'notificar',
        contingencia: 'CT-5',
        operacionId: 'op-1',
        destinatario: 'cliente',
        plantilla: 'retencion_parcial',
        ejecucion: 'automatica',
        motivo: 'x',
      },
    ];
    expect(planeacionTrasContingencia('planeada', soloAviso)).toBeNull();
  });
});
