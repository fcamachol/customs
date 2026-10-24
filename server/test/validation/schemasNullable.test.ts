import { describe, expect, it } from 'vitest';
import { unidadUpdateBody, clientDireccionUpdateBody } from '../../src/validation/schemas';

/**
 * `null` BORRA, AUSENTE NO TOCA — la distinción que estas rutas con forma de PATCH necesitan.
 *
 * Las rutas de unidad y de dirección aplican cada campo con `if (b.x !== undefined)`. Con los
 * helpers `textoOpcional`/`fechaOpcional`, un `null` del cliente se pliega a `undefined` y la ruta
 * lo lee como "no toques este campo": la pantalla diría que guardó y el valor viejo se quedaría en
 * la base. Es el peor modo de fallar, porque es silencioso.
 *
 * Por eso ambos esquemas de UPDATE se escriben a mano con variantes nullable en lugar de derivarse
 * con `.partial()` del esquema de creación, donde plegar '' a ausente sí es lo correcto.
 */
describe('esquemas de UPDATE — el null tiene que sobrevivir a la validación', () => {
  describe('unidadUpdateBody (vigencias de una unidad de flota)', () => {
    it('deja pasar null para BORRAR una vigencia mal capturada', () => {
      const r = unidadUpdateBody.parse({ vigenciaSeguro: null });
      expect(r.vigenciaSeguro).toBeNull();
      expect('vigenciaSeguro' in r).toBe(true);
    });

    it("trata '' igual que null: vaciar el campo en el formulario es borrarlo", () => {
      expect(unidadUpdateBody.parse({ vigenciaVerificacion: '' }).vigenciaVerificacion).toBeNull();
    });

    it('un campo AUSENTE queda ausente, para que la ruta no lo toque', () => {
      const r = unidadUpdateBody.parse({ placas: 'ABC1234' });
      expect(r.vigenciaSeguro).toBeUndefined();
      expect('vigenciaSeguro' in r).toBe(false);
    });

    it('sigue aceptando una fecha real y normalizando las placas', () => {
      const r = unidadUpdateBody.parse({ placas: 'abc-12-34', vigenciaSeguro: '2027-12-31' });
      expect(r.placas).toBe('ABC1234');
      expect(r.vigenciaSeguro).toBe('2027-12-31');
    });

    it('el número económico también se puede borrar', () => {
      expect(unidadUpdateBody.parse({ numeroEconomico: '' }).numeroEconomico).toBeNull();
    });

    it('rechaza un tipo de unidad fuera del glosario', () => {
      expect(() => unidadUpdateBody.parse({ tipoUnidad: 'trailer' })).toThrow();
    });
  });

  describe('clientDireccionUpdateBody (dirección de entrega)', () => {
    it('deja pasar null para borrar el horario o el contacto', () => {
      const r = clientDireccionUpdateBody.parse({ horario: null, contactoTelefono: '' });
      expect(r.horario).toBeNull();
      expect(r.contactoTelefono).toBeNull();
    });

    it('un campo ausente no viaja', () => {
      const r = clientDireccionUpdateBody.parse({ ciudad: 'Monterrey' });
      expect(r.ciudad).toBe('Monterrey');
      expect('horario' in r).toBe(false);
    });

    /**
     * El alias NO es borrable: es la etiqueta con la que la planeación elige el destino, y una
     * dirección sin alias no es una dirección corregida, es una que nadie puede escoger.
     */
    it('el alias no se puede vaciar', () => {
      expect(() => clientDireccionUpdateBody.parse({ alias: '' })).toThrow();
    });

    it('acepta reactivar sin tocar ningún otro campo', () => {
      const r = clientDireccionUpdateBody.parse({ activo: true });
      expect(r.activo).toBe(true);
      expect(Object.keys(r)).toEqual(['activo']);
    });
  });
});
