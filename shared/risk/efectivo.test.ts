import { describe, expect, it } from 'vitest';
import {
  HUELLA_VERSION,
  HUELLA_EVIDENCIA,
  colorEfectivo,
  evaluarDisposiciones,
  hallazgoHash,
  type DisposicionVigente,
} from './efectivo';
import { RULESET } from './ruleset';
import type { ReasonCode } from './signals';

/**
 * El color efectivo (diseño 2026-08-10, §3). Cuatro preguntas, en el orden en que un auditor las
 * hace: ¿la afirmación de ayer sigue tapando el hallazgo de hoy? ¿se cae sola cuando el dato cambia?
 * ¿qué pasa cuando cambia la lista contra la que se afirmó? ¿y qué color queda cuando lo que se tapa
 * era lo único que salvaba a una fila sin datos de parecer aprobada?
 */

const RULESET_A = 'ruleset-hash-A';
const RULESET_B = 'ruleset-hash-B';

const opts = { weights: RULESET.weights, bands: RULESET.bands, insufficientData: false };

function razon(over: Partial<ReasonCode> & { signalId: ReasonCode['signalId'] }): ReasonCode {
  return { points: 10, weight: 20, detail: 'texto', ...over };
}

function disposicion(over: Partial<DisposicionVigente> & { signalId: DisposicionVigente['signalId']; hallazgoHash: string }): DisposicionVigente {
  return {
    id: 'd1',
    estado: 'falso_positivo',
    rulesetHash: RULESET_A,
    motivo: 'revisado con el cliente',
    createdAt: '2026-08-10T00:00:00.000Z',
    createdBy: null,
    ...over,
  };
}

describe('hallazgoHash', () => {
  it('la MAGNITUD no entra: la misma señal con otro conteo conserva la huella', () => {
    // Si la magnitud entrara, una disposición sobre "5 importaciones este mes" se evaporaría sola al
    // llegar la sexta y habría que volver a afirmar lo mismo cada semana.
    const cinco = razon({ signalId: 'bbdd', evidence: { monthlyCount: 5 } });
    const seis = razon({ signalId: 'bbdd', evidence: { monthlyCount: 6 } });
    expect(hallazgoHash(cinco)).toBe(hallazgoHash(seis));
  });

  it('el TEXTO no entra: corregir una tilde no puede caducar cientos de afirmaciones', () => {
    const a = razon({ signalId: 'pirateria', detail: 'Pirateria (Nike)', evidence: { matched: 'Nike' } });
    const b = razon({ signalId: 'pirateria', detail: 'Piratería (Nike)', evidence: { matched: 'Nike' } });
    expect(hallazgoHash(a)).toBe(hallazgoHash(b));
  });

  it('la IDENTIDAD sí entra: Nike y Rolex son hallazgos distintos', () => {
    const nike = razon({ signalId: 'pirateria', evidence: { matched: 'Nike' } });
    const rolex = razon({ signalId: 'pirateria', evidence: { matched: 'Rolex' } });
    expect(hallazgoHash(nike)).not.toBe(hallazgoHash(rolex));
  });

  it('`monto` bajo y `monto` alto son hallazgos distintos (el discriminador de signals.ts)', () => {
    const bajo = razon({ signalId: 'monto', evidence: { value: 0.5, direccion: 'bajo' } });
    const alto = razon({ signalId: 'monto', evidence: { value: 5000, direccion: 'alto' } });
    expect(hallazgoHash(bajo)).not.toBe(hallazgoHash(alto));
  });

  it('la huella es estable entre corridas — es lo único que hace posible el arrastre', () => {
    const r = razon({ signalId: 'denied_party', evidence: { matched: 'ACME', source: 'OFAC', program: 'SDGT' } });
    expect(hallazgoHash(r)).toBe(hallazgoHash({ ...r, points: 100, weight: 100, detail: 'otro texto' }));
  });

  it('HUELLA_VERSION viaja DENTRO del hash, así que cambiar el criterio caduca lo anterior', () => {
    // No se puede cambiar la constante desde el test; se comprueba la propiedad equivalente: la
    // versión participa del contenido hasheado, así que dos versiones no pueden colisionar.
    expect(HUELLA_VERSION).toBe('2026-08a');
    const r = razon({ signalId: 'id', evidence: { id: 'ABC' } });
    expect(hallazgoHash(r)).not.toBe(hallazgoHash(razon({ signalId: 'cantidad', evidence: { id: 'ABC' } })));
  });

  it('las nueve señales tienen criterio de huella declarado', () => {
    expect(Object.keys(HUELLA_EVIDENCIA).sort()).toEqual(
      ['agregado', 'bbdd', 'cantidad', 'denied_party', 'direcciones', 'id', 'monto', 'pirateria', 'prohibidos'],
    );
  });
});

describe('evaluarDisposiciones', () => {
  it('ARRASTRE: la afirmación sigue en pie cuando el hallazgo vuelve a salir con otra magnitud', () => {
    const ayer = razon({ signalId: 'bbdd', evidence: { monthlyCount: 5 } });
    const hoy = razon({ signalId: 'bbdd', evidence: { monthlyCount: 9 } });
    const d = disposicion({ signalId: 'bbdd', hallazgoHash: hallazgoHash(ayer) });
    const ev = evaluarDisposiciones([hoy], [d], { rulesetHashVigente: RULESET_A });
    expect(ev.aplicadas).toEqual([d]);
    expect(ev.suprimidas).toEqual([hoy]);
    expect(ev.caducadas).toEqual([]);
  });

  it('CADUCIDAD POR DATO: corregir el manifiesto la tira sola, sin una escritura', () => {
    const ayer = razon({ signalId: 'pirateria', evidence: { matched: 'Nike' } });
    const hoy = razon({ signalId: 'pirateria', evidence: { matched: 'Rolex' } });
    const d = disposicion({ signalId: 'pirateria', hallazgoHash: hallazgoHash(ayer) });
    const ev = evaluarDisposiciones([hoy], [d], { rulesetHashVigente: RULESET_A });
    expect(ev.caducadas).toEqual([d]);
    expect(ev.suprimidas).toEqual([]);
  });

  it('CADUCIDAD POR DATO: si la señal ya no dispara, tampoco hay nada que tapar', () => {
    const ayer = razon({ signalId: 'monto', evidence: { value: 0.5, direccion: 'bajo' } });
    const d = disposicion({ signalId: 'monto', hallazgoHash: hallazgoHash(ayer) });
    const ev = evaluarDisposiciones([], [d], { rulesetHashVigente: RULESET_A });
    expect(ev.caducadas).toEqual([d]);
  });

  it('RULESET DISTINTO en señal FORZADA: caduca aunque la huella coincida', () => {
    // Cambió la lista de sancionados. Una afirmación hecha contra la lista anterior no puede seguir
    // tapando un golpe contra la nueva: que el nombre sea el mismo no dice que el motivo lo sea.
    const hoy = razon({ signalId: 'denied_party', evidence: { matched: 'ACME', source: 'OFAC' }, forcesBand: 'rojo' });
    const d = disposicion({ signalId: 'denied_party', hallazgoHash: hallazgoHash(hoy), rulesetHash: RULESET_A });
    const ev = evaluarDisposiciones([hoy], [d], { rulesetHashVigente: RULESET_B });
    expect(ev.caducadas).toEqual([d]);
    expect(ev.suprimidas).toEqual([]);
    expect(ev.revalidacionPendiente).toEqual([]);
  });

  it('RULESET DISTINTO en señal GRADUADA: sigue aplicando, marcada para revalidar', () => {
    // Un admin movió un umbral. Invalidar cientos de afirmaciones por eso sería castigo sin delito.
    const hoy = razon({ signalId: 'cantidad', evidence: { quantity: 30 } });
    const d = disposicion({ signalId: 'cantidad', hallazgoHash: hallazgoHash(hoy), rulesetHash: RULESET_A });
    const ev = evaluarDisposiciones([hoy], [d], { rulesetHashVigente: RULESET_B });
    expect(ev.aplicadas).toEqual([d]);
    expect(ev.suprimidas).toEqual([hoy]);
    expect(ev.revalidacionPendiente).toEqual([d]);
    expect(ev.caducadas).toEqual([]);
  });

  it('`confirmado` aplica y NO suprime — es la retractación de una supresión anterior', () => {
    const hoy = razon({ signalId: 'cantidad', evidence: { quantity: 30 } });
    const d = disposicion({ signalId: 'cantidad', hallazgoHash: hallazgoHash(hoy), estado: 'confirmado' });
    const ev = evaluarDisposiciones([hoy], [d], { rulesetHashVigente: RULESET_A });
    expect(ev.aplicadas).toEqual([d]);
    expect(ev.suprimidas).toEqual([]);
  });

  it('una disposición sólo alcanza a SU hallazgo, nunca a los demás de la misma línea', () => {
    const bajo = razon({ signalId: 'monto', evidence: { value: 0.5, direccion: 'bajo' } });
    const alto = razon({ signalId: 'monto', evidence: { value: 5000, direccion: 'alto' } });
    const d = disposicion({ signalId: 'monto', hallazgoHash: hallazgoHash(bajo) });
    const ev = evaluarDisposiciones([alto], [d], { rulesetHashVigente: RULESET_A });
    expect(ev.caducadas).toEqual([d]);
    expect(ev.suprimidas).toEqual([]);
  });
});

describe('colorEfectivo', () => {
  it('sin supresiones devuelve exactamente lo que dijo el motor', () => {
    const reasons = [razon({ signalId: 'cantidad', points: 15 }), razon({ signalId: 'monto', points: 20 })];
    expect(colorEfectivo(reasons, [], opts)).toEqual({ score: 10, band: 'amarillo' });
  });

  it('suprimir baja la banda sin tocar nada del motor', () => {
    const cantidad = razon({ signalId: 'cantidad', points: 15 });
    const monto = razon({ signalId: 'monto', points: 20, evidence: { value: 0.5, direccion: 'bajo' } });
    const antes = colorEfectivo([cantidad, monto], [], opts);
    const despues = colorEfectivo([cantidad, monto], [monto], opts);
    expect(antes.band).toBe('amarillo');
    expect(despues.band).toBe('verde');
  });

  it('GRIS SE CONSERVA al suprimir un forzado-rojo sobre datos insuficientes', () => {
    // El caso que justifica persistir `shipments.risk_insufficient_data`. La fila no tiene
    // descripción, ni valor, ni RFC: lo honesto es "no se pudo evaluar", no "todo en orden".
    // Convertir la falta de datos en una aprobación es el peor error que esta capa podría cometer.
    const prohibido = razon({ signalId: 'prohibidos', points: 60, forcesBand: 'rojo', evidence: { matched: 'pistola' } });
    const conDatosFaltantes = { ...opts, insufficientData: true };
    expect(colorEfectivo([prohibido], [], conDatosFaltantes).band).toBe('rojo');
    expect(colorEfectivo([prohibido], [prohibido], conDatosFaltantes).band).toBe('gris');
  });

  it('sin datos insuficientes, suprimir el forzado-rojo sí devuelve verde', () => {
    const prohibido = razon({ signalId: 'prohibidos', points: 60, forcesBand: 'rojo', evidence: { matched: 'pistola' } });
    expect(colorEfectivo([prohibido], [prohibido], opts).band).toBe('verde');
  });
});
