import type { MigrationBuilder } from 'node-pg-migrate';

/**
 * `manifiesto_versiones` — el manifiesto corregido, con expediente (diseño 2026-08-10, §2 y §6).
 *
 * QUÉ ARREGLA. El producto pidió "mandar un manifiesto nuevo con el mismo MAWB que sustituya al
 * anterior". Eso hoy NO existe: por la vía UI `POST /api/manifests` responde 409 antes de persistir
 * nada, y por la vía prealerta `services/manifiestoIngest.ts` archiva el adjunto, ignora el parse
 * nuevo (`parsed.rows` sólo se usa en la rama de inserción) y vuelve a promover las filas VIEJAS de
 * staging. Un cliente que corrige su manifiesto recibe hoy "adjuntado" y sus datos siguen siendo los
 * de la primera entrega. Esta migración es el sustrato de la corrección; la trazabilidad no es un
 * extra que se le añade, es la forma en que se construye.
 *
 * POR QUÉ NO SE VERSIONA LA FILA `manifests`. Versionar la cabecera obligaría a tirar
 * `manifests_mawb_reference_uq`, que es el poka-yoke sobre el que se apoya todo lo demás: hoy
 * `operaciones.mawb` también es UNIQUE, así que *un MAWB = un manifiesto = un caso*. Habría que
 * repuntar `pedimentos.manifest_id`, `operaciones.manifest_id`, `monthly_history.manifest_id` y
 * `pedimento_scans`, y responder una pregunta sin buena respuesta: ¿a qué versión pertenece un
 * pedimento ya `cargado`? El agregado "manifiesto" no cambia de identidad cuando se corrige su
 * contenido — es el mismo embarque. Lo que cambia es el DOCUMENTO, y para el documento es para lo
 * que hay tabla.
 *
 * POR QUÉ TAMPOCO SE VERSIONA EL ORO. `shipments` sigue siendo estado actual, con upsert por
 * `(manifest_id, idempotency_key)` y borrado duro de las líneas que la versión nueva retira. Si el
 * oro llevara versión, cada consumidor (`dashboard.ts`, `records.ts`, `consolidated.ts`,
 * `reportData.ts`, `riesgo_requerimientos`) tendría que aprender qué es una versión y filtrar por la
 * vigente. Y no haría falta: la historia línea a línea YA existe en `manifest_staging_rows`, que
 * guarda el parse completo con sus `errors` y `warnings`. Por eso la capa bronce gana `version` y sus
 * filas viejas no se tocan nunca — historia línea a línea, ya cifrada, sin una tabla nueva de líneas.
 *
 * `row_hash` ES LA PIEZA QUE HACE POSIBLE EL DIFF. `crypto/fieldCrypto.ts` cifra con AES-256-GCM e
 * IV ALEATORIO POR CAMPO: dos cifrados del mismo nombre son bytes distintos. Comparar la columna
 * `data` jsonb entre dos versiones marcaría TODAS las líneas como modificadas, siempre. `row_hash`
 * es el sha256 canónico del shipment EN CLARO, calculado en el parse antes de cifrar: nunca hay que
 * descifrar para diferenciar, el hash no contiene PII, y el diff es un join trivial entre dos
 * versiones. `manifiesto_versiones.line_set_hash` es el mismo criterio un nivel arriba — sha256 del
 * conjunto ordenado de `idempotency_key:row_hash` — y es lo que hace idempotente la reentrega de un
 * webhook: si la huella coincide, no se crea versión.
 *
 * `estado='rechazada'` + `motivo_rechazo` ES ESPEJO EXACTO DE `prealertas`. Cuando hay un pedimento
 * `cargado` la versión NO se descarta: se inserta rechazada, con su archivo y su hash, y ENTONCES se
 * responde 409. El documento que mandó el cliente queda archivado y el rechazo queda en el
 * expediente. Descartarlo en la puerta dejaría al cliente diciendo "yo lo mandé" y al sistema sin
 * nada que enseñar.
 *
 * `motivo` OBLIGATORIO DESDE LA v2, por CHECK y no por convención de código. La v1 es la carga
 * original y no sustituye nada, así que exigirle un motivo sería ruido; de la v2 en adelante alguien
 * está reemplazando datos que ya se usaron para calificar riesgo, y "por qué" es la única pregunta
 * que un auditor va a hacer. Las rechazadas quedan exentas: su motivo es `motivo_rechazo`, y exigir
 * los dos convertiría el registro del rechazo en un fallo de constraint.
 *
 * DEMO-RESET NO NECESITA CAMBIO. `manifiesto_versiones` cuelga de `manifests` con CASCADE y
 * `routes/admin.ts` ejecuta `DELETE FROM manifests`, así que se limpia sola. Se dice explícitamente
 * porque la OTRA lista de ese archivo, `TABLAS_OPERACIONES`, usa `TRUNCATE` SIN `CASCADE` y con
 * nombres explícitos: una tabla nueva que colgara de esa superficie y no estuviera listada haría
 * fallar el statement por nombre. Ésta no cuelga de ahí, y por eso no se lista. Lo mismo aplica a
 * `test/helpers/db.ts`, cuyo TRUNCATE sí lleva CASCADE.
 */
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.createTable('manifiesto_versiones', {
    id: { type: 'uuid', primaryKey: true, default: pgm.func('gen_random_uuid()') },
    manifest_id: { type: 'uuid', notNull: true, references: 'manifests', onDelete: 'CASCADE' },
    /** 1 es la carga original; n es la n-ésima entrega del documento para ese mismo MAWB. */
    version: { type: 'integer', notNull: true },
    /**
     * `staged` es "parseada y diffeada, todavía no aplicada" — el paso que existe porque un humano
     * quiere ver el diff antes de reemplazar el oro. La vía prealerta atraviesa los dos pasos en una
     * sola llamada, desatendida, pero deja las dos filas de estado igual de legibles.
     */
    estado: {
      type: 'text',
      notNull: true,
      default: 'staged',
      check: "estado IN ('staged','aplicada','rechazada')",
    },
    /** De dónde vino el documento. La distinción importa: una la firma un usuario, la otra un robot. */
    origen: {
      type: 'text',
      notNull: true,
      check: "origen IN ('carga_manual','prealerta')",
    },
    /** Obligatorio desde la v2 — ver el CHECK abajo. */
    motivo: { type: 'text' },
    /** Por qué no se aplicó. Hoy sólo `pedimento_cargado`; sin CHECK, para no cerrar el vocabulario. */
    motivo_rechazo: { type: 'text' },

    /**
     * El archivo tal como llegó. SET NULL y no CASCADE: perder el blob no puede borrar el hecho de
     * que hubo una versión — misma disciplina que `riesgo_requerimientos.evidencia_file_id`.
     */
    source_file_id: { type: 'uuid', references: 'files', onDelete: 'SET NULL' },
    file_content_hash: { type: 'text' },
    /** La fila de encabezados de ESE archivo, que puede diferir entre entregas del mismo cliente. */
    source_header: { type: 'jsonb' },
    /**
     * sha256 sobre el conjunto ordenado de `idempotency_key:row_hash`. NULL sólo en las v1
     * retro-llenadas por esta migración (ver la nota del retro-llenado). La compuerta de no-op trata
     * NULL como "desconocido → crear versión", que falla del lado seguro.
     */
    line_set_hash: { type: 'text' },
    /** `{total, valid, warning, error}` del parse — lo que el documento traía, no lo que se promovió. */
    counts: { type: 'jsonb', notNull: true, default: '{}' },
    /** `{altas:[key], bajas:[key], modificadas:[key], sinCambio:n}`. Sólo claves y conteos: nunca PII. */
    diff: { type: 'jsonb' },
    aplicada_at: { type: 'timestamptz' },
    /** NULL cuando la aplicó el sistema (vía prealerta) — la misma señal que usa `recordAudit`. */
    created_by: { type: 'uuid', references: 'users', onDelete: 'SET NULL' },
    created_at: { type: 'timestamptz', notNull: true, default: pgm.func('now()') },
  });

  pgm.addConstraint('manifiesto_versiones', 'manifiesto_versiones_uq', {
    unique: ['manifest_id', 'version'],
  });
  pgm.addConstraint('manifiesto_versiones', 'manifiesto_versiones_motivo_check', {
    check: "version = 1 OR estado = 'rechazada' OR (motivo IS NOT NULL AND btrim(motivo) <> '')",
  });
  /**
   * DESC porque toda lectura interesante es "la última": la compuerta de no-op busca la vigente y la
   * pantalla del auditor lista de la más reciente hacia atrás.
   */
  pgm.createIndex('manifiesto_versiones', [{ name: 'manifest_id' }, { name: 'version', sort: 'DESC' }], {
    name: 'manifiesto_versiones_manifest_version_idx',
  });

  /**
   * La cabecera sigue describiendo el DOCUMENTO VIGENTE (`source_file_id`, `file_content_hash`,
   * `source_header`); este puntero dice cuál es. Default 1 con NOT NULL para que el código anterior a
   * esta fase siga siendo correcto sin tocarlo: todo manifiesto existente está en su v1.
   */
  pgm.addColumns('manifests', {
    version_vigente: { type: 'integer', notNull: true, default: 1 },
  });

  pgm.addColumns('manifest_staging_rows', {
    version: { type: 'integer', notNull: true, default: 1 },
    /** sha256 del shipment EN CLARO, calculado en el parse antes de `encryptShipmentPii`. */
    row_hash: { type: 'text' },
  });
  /**
   * La unique se amplía, no se relaja: `(manifest_id, version, idempotency_key)` sigue impidiendo dos
   * filas con la misma clave DENTRO de una versión, que es la invariante que la vieja protegía. Para
   * las filas existentes (todas v1) el conjunto de pares aceptados es idéntico al de antes.
   */
  pgm.dropConstraint('manifest_staging_rows', 'manifest_staging_rows_idem_uq');
  pgm.addConstraint('manifest_staging_rows', 'manifest_staging_rows_idem_uq', {
    unique: ['manifest_id', 'version', 'idempotency_key'],
  });
  pgm.createIndex('manifest_staging_rows', ['manifest_id', 'version']);

  /**
   * EL COLOR ANTERIOR DE UNA LÍNEA CORREGIDA (ajuste posterior del diseño; va aquí y no en la
   * migración B porque es de versionado, no de disposiciones).
   *
   * Para una disposición humana el "antes" convive en la fila (`risk_color` del motor frente al
   * efectivo). Para una CORRECCIÓN de manifiesto no: aplicar una versión anula las columnas del motor
   * y vuelve a correr el riesgo, así que el color que la línea tenía en la versión anterior se
   * perdería. El bronce retiene el DATO, no su calificación.
   *
   * El acarreo ocurre dentro del mismo `ON CONFLICT ... DO UPDATE` que hoy borra el dato, sin lectura
   * extra: ahí `shipments.risk_color` es todavía la fila vieja y `EXCLUDED` la nueva. Al final de la
   * corrida de riesgo, un solo UPDATE anula los tres donde el color recalculado coincide con el
   * viejo. Regla resultante para la UI: si `risk_color_anterior` no es NULL, hubo cambio y hay algo
   * que enseñar — ningún consumidor compara nada. Es UNA generación de historia en la fila; la
   * historia completa sigue reconstruible desde bronce + eventos.
   */
  pgm.addColumns('shipments', {
    risk_color_anterior: { type: 'text' },
    risk_score_anterior: { type: 'integer' },
    /** De qué versión venía ese color, para que el tag pueda decir "v2 → v3" y no sólo "cambió". */
    risk_version_anterior: { type: 'integer' },
  });

  /**
   * RETRO-LLENADO. Una fila v1 por manifiesto existente, para que `version_vigente = 1` no apunte al
   * vacío y la pantalla del auditor no tenga un agujero en todo lo anterior a esta fase.
   *
   * `line_set_hash` y `row_hash` quedan NULL A PROPÓSITO: son hashes de texto EN CLARO y esta
   * migración NO descifra PII para calcularlos. Descifrar un manifiesto entero dentro de una
   * migración —con la llave del proceso, escribiendo el resultado derivado en una columna nueva— es
   * exactamente el tipo de cosa que RNF-03/08 existen para impedir. El coste es conocido y acotado:
   * la primera corrección sobre un manifiesto viejo no puede probar que es idéntica, así que crea
   * versión y la aplica. Falla del lado seguro.
   *
   * `estado` se deriva de `ingestion_status` en vez de fijarse en `aplicada` para todos: un
   * manifiesto que sigue en `staged` nunca promovió nada, y llamar "aplicada" a su v1 sería escribir
   * un hecho falso en la primera fila del expediente. `aplicada_at` es `created_at` — una
   * aproximación, porque el instante real de la promoción sólo existe en `audit_log`, y no vale la
   * pena correr esa búsqueda aquí; el audit sigue siendo la fuente exacta.
   *
   * `origen` se deduce de `created_by`: la vía prealerta inserta el manifiesto con `created_by` NULL
   * (`services/manifiestoIngest.ts`) y la vía UI siempre estampa al usuario que subió el archivo
   * (`routes/manifests.ts`). Es una heurística, exacta para todo lo que el código actual escribió.
   */
  pgm.sql(`
    INSERT INTO manifiesto_versiones
      (manifest_id, version, estado, origen, source_file_id, file_content_hash, source_header,
       counts, aplicada_at, created_by, created_at)
    SELECT m.id,
           1,
           CASE WHEN m.ingestion_status = 'promoted' THEN 'aplicada' ELSE 'staged' END,
           CASE WHEN m.created_by IS NULL THEN 'prealerta' ELSE 'carga_manual' END,
           m.source_file_id,
           m.file_content_hash,
           m.source_header,
           c.counts,
           CASE WHEN m.ingestion_status = 'promoted' THEN m.created_at END,
           m.created_by,
           m.created_at
      FROM manifests m
      LEFT JOIN LATERAL (
        SELECT jsonb_build_object(
                 'total',   count(*),
                 'valid',   count(*) FILTER (WHERE r.status = 'valid'),
                 'warning', count(*) FILTER (WHERE r.status = 'warning'),
                 'error',   count(*) FILTER (WHERE r.status = 'error')
               ) AS counts
          FROM manifest_staging_rows r
         WHERE r.manifest_id = m.id
      ) c ON true
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('shipments', [
    'risk_color_anterior',
    'risk_score_anterior',
    'risk_version_anterior',
  ]);
  pgm.dropIndex('manifest_staging_rows', ['manifest_id', 'version']);
  pgm.dropConstraint('manifest_staging_rows', 'manifest_staging_rows_idem_uq');
  pgm.addConstraint('manifest_staging_rows', 'manifest_staging_rows_idem_uq', {
    unique: ['manifest_id', 'idempotency_key'],
  });
  pgm.dropColumns('manifest_staging_rows', ['version', 'row_hash']);
  pgm.dropColumns('manifests', ['version_vigente']);
  pgm.dropTable('manifiesto_versiones');
}
