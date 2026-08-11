import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `riesgo_disposiciones` y el COLOR EFECTIVO — el humano afirma, el motor no se toca
 * (diseño 2026-08-10, §3 y §6, migración B).
 *
 * EL PROBLEMA. Hoy una bandera roja o amarilla es definitiva: `shipments.risk_color` es lo que el
 * motor dijo y no hay forma de decir "esto es un falso positivo" o "esto ya se resolvió" sin
 * SOBREESCRIBIR la calificación. Sobreescribirla destruye la única respuesta que un auditor va a
 * pedir —*¿qué dijo el sistema?*— y deja al humano sin coartada: si el color de la fila cambió, nadie
 * puede probar que el motor había marcado algo. Por eso aquí no se edita ninguna columna del motor.
 * Se añade una CAPA: el humano afirma en una tabla aparte, y el color efectivo se MATERIALIZA a un
 * lado del crudo.
 *
 * NULL SIGNIFICA "SIN DISPOSICIÓN, MANDA EL MOTOR". Ésa es la propiedad que hace esta migración
 * retrocompatible sin doble camino de código: mientras no exista ninguna disposición, las tres
 * columnas nuevas quedan NULL y `COALESCE(risk_color_efectivo, risk_color)` devuelve exactamente lo
 * de siempre en las cuatro superficies que leen color (`routes/dashboard.ts`, `routes/records.ts`,
 * `routes/consolidated.ts`, `services/reportData.ts`). Ninguna de las cuatro aprende qué es una
 * disposición; sólo aprenden un `COALESCE`.
 *
 * `risk_insufficient_data` ES EL BOOLEANO QUE HOY SE CALCULA Y SE TIRA. `shared/risk/classify.ts` lo
 * deriva en cada corrida (sin descripción, sin valor o sin RFC/CURP) y `scoreRow` lo usa para la
 * banda `gris`; después se pierde. Sin persistirlo, recalcular el color efectivo tras suprimir un
 * hallazgo FORZADO-rojo sobre una fila incompleta devolvería `verde` —"todo en orden"— cuando la
 * verdad es `gris`, "no se pudo evaluar". Convertir la falta de datos en una aprobación es el peor
 * error posible de esta capa, y esta columna es lo único que lo impide. Sin backfill a propósito:
 * queda NULL hasta la siguiente corrida, y NULL se lee como `false` salvo que la banda cruda sea
 * `gris`, en cuyo caso se infiere `true` (una línea comentada en `services/riesgoEfectivo.ts`).
 *
 * LA IDENTIDAD DE UN HALLAZGO: `hallazgo_hash`. Una razón del motor (`ReasonCode`) no tiene id, así
 * que la disposición se ancla a una HUELLA calculada sobre una PROYECCIÓN de su `evidence`: los
 * campos que dicen QUÉ coincidió (`matched`, `source`, `program`, `id`, `direccion`) entran; los que
 * dicen CUÁNTO (`quantity`, `value`, `entityTotal`, `cap`, `distinctConsignees`, `monthlyCount`) no.
 * Si se hashea la magnitud, una disposición sobre "5 importaciones este mes" se evapora sola al
 * llegar la sexta. Si no se hashea la identidad, una disposición sobre `pirateria: Nike` taparía en
 * silencio un golpe posterior sobre `Rolex`. El criterio vive en un solo mapa —`HUELLA_EVIDENCIA` en
 * `shared/risk/efectivo.ts`, con su `HUELLA_VERSION` DENTRO del hash— para que un cambio futuro de
 * criterio sea visible en el dato y no sólo en el diff de git.
 *
 * `hallazgo jsonb` GUARDA EL `ReasonCode` ÍNTEGRO, magnitud incluida, igual que
 * `riesgo_requerimientos.reason_codes` cita al motor verbatim: la huella sirve para el ARRASTRE, la
 * cita sirve para el AUDITOR. Son dos trabajos distintos y por eso son dos columnas.
 *
 * LA APLICABILIDAD NO SE ESCRIBE NUNCA. No hay columna `aplicable` ni `caducada`: se evalúa al
 * materializar, contra las razones que el motor acaba de producir. Una corrección de manifiesto que
 * cambia el dato hace caducar la disposición SOLA, sin una sola escritura, porque la razón nueva
 * tiene otra huella o simplemente ya no dispara. Cero código de reconciliación.
 *
 * `shipment_id` ES `SET NULL` Y ADEMÁS SE DESNORMALIZAN `manifest_id` + `idempotency_key`, por la
 * misma razón que `operacion_eventos.operacion_mawb`: una línea retirada por una corrección de
 * manifiesto se BORRA del oro (§2), y borrar la afirmación de un humano porque su línea desapareció
 * dejaría el expediente mintiendo. La clave de idempotencia es la identidad durable de la línea y
 * sobrevive al borrado.
 *
 * APPEND-ONLY POR TRIGGER, misma función que `audit_log` y `operacion_eventos`. Retractarse no es
 * borrar ni actualizar: es insertar un `confirmado` con `supersede_a` apuntando a la fila anterior.
 * Gana la última fila por clave `(signal_id, hallazgo_hash)`, y la cadena queda legible — el mismo
 * patrón de sucesión que `transportista_convenios.renovado_de_convenio_id`.
 *
 * DEMO-RESET NO NECESITA CAMBIO EN LO QUE BORRA. `riesgo_disposiciones` cuelga de `manifests` con
 * CASCADE y `routes/admin.ts` ejecuta `DELETE FROM manifests`, así que se vacía sola, se pida o no la
 * superficie operativa. Sí hay que LISTARLA en `TABLAS_OPERACIONES`, y por un motivo puramente
 * estructural que conviene dejar escrito: esa lista usa `TRUNCATE` SIN `CASCADE` y con nombres
 * explícitos, y Postgres rechaza truncar una tabla referenciada por una FK a menos que la
 * referenciante vaya en el MISMO statement. Como `requerimiento_id` apunta a `riesgo_requerimientos`,
 * que sí está en esa lista, omitirla haría fallar el reset entero por nombre. `test/helpers/db.ts`
 * no necesita nada: su TRUNCATE lleva CASCADE.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('shipments', {
    /**
     * Lo que `classify.ts` ya sabía y no guardaba. NULL = fila calificada antes de esta migración;
     * ver la regla de lectura arriba. Sin default: un `false` por defecto AFIRMARÍA que los datos
     * estaban completos en filas que nunca se comprobaron.
     */
    risk_insufficient_data: { type: 'boolean' },
    /** El color tras aplicar las disposiciones vigentes. NULL = no hay ninguna; manda el motor. */
    risk_color_efectivo: { type: 'text' },
    risk_score_efectivo: { type: 'integer' },
    /**
     * El resumen de lo aplicado (qué disposiciones, qué señales quedaron suprimidas, si alguna pide
     * revalidación). Está aquí, denormalizado, para que las lecturas de lista no hagan un join por
     * fila: es dato DERIVADO y se reescribe entero en cada materialización, nunca se parchea.
     */
    risk_disposiciones: { type: 'jsonb' },
  });

  pgm.createTable('riesgo_disposiciones', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    /** La línea calificada. SET NULL: una corrección que la retire no puede borrar la afirmación. */
    shipment_id: { type: 'uuid', references: 'shipments', onDelete: 'SET NULL' },
    /** La identidad DURABLE de la línea, que sobrevive al borrado de `shipments`. */
    idempotency_key: { type: 'text', notNull: true },
    /** Sobre qué versión del manifiesto se afirmó. Una v4 no hereda el contexto de la v3. */
    manifiesto_version: { type: 'integer', notNull: true },

    signal_id: { type: 'text', notNull: true },
    /** La huella de la PROYECCIÓN de identidad del hallazgo. La calcula el servidor, nunca el cliente. */
    hallazgo_hash: { type: 'text', notNull: true },
    /** El `ReasonCode` verbatim, magnitud incluida. La cita para el auditor. */
    hallazgo: { type: 'jsonb', notNull: true },

    ruleset_version: { type: 'text' },
    /**
     * El ruleset contra el que se afirmó. notNull porque es la mitad de la regla de caducidad: una
     * afirmación hecha contra la lista de sancionados ANTERIOR no puede seguir tapando un golpe
     * contra la nueva, y sin este dato esa comprobación no se puede hacer.
     */
    ruleset_hash: { type: 'text', notNull: true },

    /**
     * `confirmado` no suprime nada y existe por dos razones: "alguien miró esto y está de acuerdo" es
     * un hecho que vale la pena registrar, y es la forma natural de RETRACTAR una disposición previa
     * en una tabla que no admite UPDATE ni DELETE.
     */
    estado: {
      type: 'text',
      notNull: true,
      check: "estado IN ('falso_positivo','mitigado','confirmado')",
    },
    /** notNull y con CHECK de no-vacío: tapar una bandera sin decir por qué no es disponer, es borrar. */
    motivo: { type: 'text', notNull: true },
    /** SET NULL: la disposición sigue en pie aunque el blob se pierda (igual que en requerimientos). */
    evidencia_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    /** El requerimiento que el cliente ya respondió, cuando el `mitigado` se apoya en uno. */
    requerimiento_id: { type: 'uuid', references: 'riesgo_requerimientos', onDelete: 'SET NULL' },
    /** La fila que ésta reemplaza. Auto-FK, patrón `renovado_de_convenio_id`. */
    supersede_a: { type: 'uuid', references: 'riesgo_disposiciones', onDelete: 'SET NULL' },

    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('riesgo_disposiciones', 'riesgo_disposiciones_motivo_check', {
    check: "btrim(motivo) <> ''",
  });
  /**
   * `mitigado` afirma que el hallazgo ERA REAL y está resuelto, así que exige un respaldo: el
   * documento que lo resuelve o el requerimiento que el cliente contestó. Por CHECK y no por
   * validación de ruta, porque una afirmación de este peso no puede depender de que todas las vías
   * de escritura futuras recuerden comprobarlo. `falso_positivo` no lo exige: ahí lo que se afirma es
   * que no había nada que resolver, y su respaldo es el `motivo`.
   */
  pgm.addConstraint('riesgo_disposiciones', 'riesgo_disposiciones_mitigado_check', {
    check: "estado <> 'mitigado' OR evidencia_file_id IS NOT NULL OR requerimiento_id IS NOT NULL",
  });

  /**
   * La lectura de la materialización: "la última disposición por (línea, señal, huella)". DESC porque
   * gana la más reciente y es lo único que la evaluación necesita leer.
   */
  pgm.createIndex(
    'riesgo_disposiciones',
    [{ name: 'shipment_id' }, { name: 'signal_id' }, { name: 'hallazgo_hash' }, { name: 'created_at', sort: 'DESC' }],
    { name: 'riesgo_disposiciones_vigente_idx' },
  );
  /** Materializar un manifiesto entero (tras una corrida de riesgo) y la pantalla del auditor. */
  pgm.createIndex('riesgo_disposiciones', 'manifest_id');

  /**
   * EL TRIGGER APPEND-ONLY, CON DOS EXCEPCIONES QUE NO SON UNA CONCESIÓN SINO EL ÚNICO MODO DE QUE
   * LAS FK DEL DISEÑO FUNCIONEN. `audit_log` y `operacion_eventos` pueden rechazar TODO UPDATE y TODO
   * DELETE porque nada apunta a ellos con CASCADE y sus referencias apenas se borran. Aquí no:
   *
   *  1. `shipments` SE BORRA DE VERDAD, y a menudo — `manifiestoVersiones.aplicarVersion` borra las
   *     líneas que una corrección retira. `ON DELETE SET NULL` ejecuta un UPDATE sobre esta tabla, y
   *     un trigger que lo rechazara haría IMPOSIBLE aplicar una corrección sobre una línea dispuesta:
   *     exactamente el caso para el que se desnormalizó `idempotency_key`. Se permite el UPDATE que
   *     sólo pone REFERENCIAS en NULL y no cambia nada más. Referencias que se pierden, sí;
   *     afirmaciones que se editan, no: cualquier cambio de `estado`, `motivo`, `hallazgo` o de una
   *     FK a un valor DISTINTO de NULL sigue reventando.
   *
   *  2. `DELETE FROM manifests` (demo-reset) arrastra estas filas por CASCADE, y el cascade emite un
   *     DELETE fila a fila que este trigger vería. Se permite sólo cuando el manifiesto padre YA no
   *     existe —que es la firma inequívoca de estar dentro del cascade— y se rechaza el borrado
   *     directo de una disposición cuyo manifiesto sigue vivo. Traducido: una disposición sólo
   *     desaparece cuando desaparece el manifiesto entero, nunca sola.
   */
  pgm.sql(`
    CREATE OR REPLACE FUNCTION riesgo_disposiciones_block_mutation() RETURNS trigger AS $$
    DECLARE anterior riesgo_disposiciones;
    BEGIN
      IF TG_OP = 'UPDATE' THEN
        anterior := OLD;
        IF NEW.shipment_id       IS NULL THEN anterior.shipment_id       := NULL; END IF;
        IF NEW.evidencia_file_id IS NULL THEN anterior.evidencia_file_id := NULL; END IF;
        IF NEW.requerimiento_id  IS NULL THEN anterior.requerimiento_id  := NULL; END IF;
        IF NEW.supersede_a       IS NULL THEN anterior.supersede_a       := NULL; END IF;
        IF NEW.created_by        IS NULL THEN anterior.created_by        := NULL; END IF;
        IF NEW IS NOT DISTINCT FROM anterior THEN RETURN NEW; END IF;
      ELSIF TG_OP = 'DELETE' THEN
        IF NOT EXISTS (SELECT 1 FROM manifests WHERE id = OLD.manifest_id) THEN RETURN OLD; END IF;
      END IF;
      RAISE EXCEPTION 'riesgo_disposiciones is append-only';
    END;
    $$ LANGUAGE plpgsql;
  `);
  pgm.sql(`
    CREATE TRIGGER riesgo_disposiciones_no_update_delete
    BEFORE UPDATE OR DELETE ON riesgo_disposiciones
    FOR EACH ROW EXECUTE FUNCTION riesgo_disposiciones_block_mutation();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TRIGGER IF EXISTS riesgo_disposiciones_no_update_delete ON riesgo_disposiciones;`);
  pgm.sql(`DROP FUNCTION IF EXISTS riesgo_disposiciones_block_mutation();`);
  pgm.dropTable('riesgo_disposiciones');
  pgm.dropColumns('shipments', [
    'risk_insufficient_data',
    'risk_color_efectivo',
    'risk_score_efectivo',
    'risk_disposiciones',
  ]);
}
