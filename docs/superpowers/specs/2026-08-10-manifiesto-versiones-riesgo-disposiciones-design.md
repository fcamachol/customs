# Diseño: manifiesto versionado y disposición de hallazgos

**Fecha:** 2026-08-10 · **Estado:** propuesta para aprobación · **Alcance:** server + shared + client

---

## 0. Un defecto verificado que reencuadra el requisito

El producto pidió "poder mandar un manifiesto nuevo con el mismo MAWB que sustituya al anterior". Podría pensarse que hoy eso "ocurre implícitamente vía resend-attach + re-promoción". **Eso no es cierto.** En `server/src/services/manifiestoIngest.ts`, la rama de attach nunca escribe el parse nuevo:

```ts
if (existing.rows.length) { manifestId = existing.rows[0].id; attached = true; }   // parsed.rows NO se usa
else { /* única rama que inserta manifest_staging_rows a partir de parsed.rows */ }
...
const promovidas = await promoteStagedRows(manifestId);   // lee las filas VIEJAS de staging
```

`parsed.rows` sólo se usa dentro de la rama de inserción. En un reenvío con el manifiesto **corregido**, el sistema archiva el adjunto, vuelve a promover las filas originales, marca `risk_stale`, recorre el riesgo sobre los datos viejos y reporta `adjuntado` con `counts` del archivo nuevo. El comentario del módulo afirma lo contrario ("un resend con manifiesto corregido hace lo correcto"). Tampoco se actualizan `manifests.file_content_hash` ni `source_file_id`, así que la cabecera sigue describiendo el primer archivo.

Y por la vía UI, `POST /api/manifests` responde 409 antes de persistir nada: no hay corrección posible en absoluto.

Conclusión: la capacidad (a) **no existe hoy, ni bien ni mal**. No estamos añadiendo trazabilidad a una corrección que ya funciona; estamos construyendo la corrección, y la trazabilidad es la forma en que la construimos. Eso hace que la opción "más barata" (dejar el refresh in-place y sólo anexar un snapshot) no sea la más barata: hay que escribir el camino de datos de todos modos.

---

## 1. La forma de la respuesta: dos sustantivos, ambos prestados

| Necesidad | Sustantivo nuevo | Patrón del que se copia |
|---|---|---|
| (a) Manifiesto nuevo con el mismo MAWB | `manifiesto_versiones` | `prealertas` (versión n+1 sobre el mismo caso, filas viejas intactas, `estado='rechazada'` + `motivo_rechazo`) |
| (b) Disponer banderas roja/amarilla | `riesgo_disposiciones` | `operacion_eventos` (append-only) + `override=true` con `motivo` obligatorio + `renovado_de_convenio_id` (sucesión) |

Cero cambios de FK. Cero relajación de constraints únicas. El color efectivo se materializa exactamente como `operaciones.hold_activo` (`server/src/services/holdActivo.ts`): una función absoluta que le pregunta a la tabla qué es verdad, nunca incrementa ni alterna.

---

## 2. Decisión 1 — Se versiona el DOCUMENTO y la capa bronce; el oro queda en estado actual

### Alternativas descartadas

**(i) Versionar la fila `manifests` (nueva fila por corrección, `UNIQUE (mawb, version)`).** Exige tirar `manifests_mawb_reference_uq`, que es el poka-yoke sobre el que se apoya todo lo demás: `operaciones.mawb` también es UNIQUE, así que hoy *un MAWB = un manifiesto = un caso*. Habría que repuntar `pedimentos.manifest_id`, `operaciones.manifest_id`, `monthly_history.manifest_id`, `pedimento_scans` y responder una pregunta que no tiene buena respuesta: ¿a qué versión pertenece un pedimento ya `cargado`? Radio de explosión máximo a cambio de una verdad que no necesitamos (el agregado "manifiesto" no cambia de identidad cuando se corrige su contenido; es el mismo embarque).

**(ii) Versionar el conjunto de líneas en oro (`shipments.version_id` + puntero de versión vigente).** Cada consumidor de `shipments` —`dashboard.ts`, `consolidated.ts`, `records.ts`, `reportData.ts`, `riesgo_requerimientos`— tendría que aprender qué es una versión y filtrar por la vigente. Es el mismo radio de explosión que (i) sin la ventaja: la historia línea a línea **ya existe** en `manifest_staging_rows`, que guarda el parse completo con sus errores y advertencias.

**(iii) In-place + snapshot inmutable en un evento.** Se descarta porque el snapshot sería un blob no consultable, y porque de todas formas hay que escribir la ruta de re-staging (§0).

### Lo elegido

- **`manifests`** sigue siendo una fila por MAWB, con su UNIQUE global intacta. Su cabecera (`source_file_id`, `file_content_hash`, `source_header`) siempre describe **el documento vigente**; la historia vive en la tabla de versiones. Gana una columna `version_vigente`.
- **`manifest_staging_rows`** gana `version`. La unique pasa de `(manifest_id, idempotency_key)` a `(manifest_id, version, idempotency_key)`. Las filas viejas **nunca se tocan**. Esto entrega historia línea a línea, ya cifrada, con sus `errors`/`warnings`, **sin tabla nueva de líneas**.
- **`shipments`** (oro) sigue siendo estado actual: upsert por `(manifest_id, idempotency_key)` y **borrado duro** de las líneas que la versión nueva retira. Ningún consumidor aprende nada nuevo. Precedente de casa: el borrado de pedimento es borrado duro + snapshot completo en `audit_log`; aquí ni siquiera perdemos el dato, porque la versión anterior lo conserva en bronce.
- **`manifiesto_versiones`** es el documento: quién lo mandó, con qué archivo, con qué hash, con qué motivo, qué cambió, y si se aplicó o se rechazó.

### El diff no puede compararse en SQL sobre `data`

`server/src/crypto/fieldCrypto.ts` usa AES-256-GCM con **IV aleatorio por campo**: dos cifrados del mismo nombre son bytes distintos. Comparar `data` jsonb marcaría todas las líneas como modificadas, siempre.

Por eso `manifest_staging_rows` gana también **`row_hash`**: sha256 canónico del shipment **en claro, calculado en el parse, antes de cifrar**. Nunca hay que descifrar para diferenciar, el hash no contiene PII, y el diff es un `FULL OUTER JOIN` trivial entre dos versiones. `manifiesto_versiones.line_set_hash` = sha256 sobre el conjunto ordenado de `idempotency_key:row_hash` — la huella del documento como conjunto de líneas.

### Dos pasos, porque un humano quiere ver el diff antes de aplicarlo

```
POST /api/manifests/:id/versiones   (multipart)  → parsea, escribe staging v(n), calcula diff, NO aplica
POST /api/manifests/:id/promote     (body motivo) → aplica la versión staged más alta
```

`promote` sigue existiendo y sigue haciendo lo que hacía para v1 (`RegistroView` no cambia); ahora exige `motivo` cuando la versión ≥ 2. La vía prealerta hace ambos pasos en una llamada, desatendida, con un motivo generado por el sistema (`"Reenvío de prealerta v3 (<messageId>)"`) — decir de dónde vino es un motivo honesto; un motivo vacío no lo sería.

### `aplicarVersion` — el algoritmo, en un solo lugar

Nuevo `server/src/services/manifiestoVersiones.ts`, llamado por la ruta y por `manifiestoIngest.ts` (que así queda arreglado por construcción):

1. `SELECT ... FROM manifests WHERE id=$1 FOR UPDATE`.
2. **Compuerta de bloqueo**: si algún `pedimentos.sub_status = 'cargado'` (`computeLock`) → la versión se inserta con `estado='rechazada'`, `motivo_rechazo='pedimento_cargado'`, evento `MANIFIESTO_VERSION_RECHAZADA`, audit, HTTP 409. **El documento no se descarta**: queda archivado y el rechazo queda en el expediente. (Espejo exacto de `prealertas.estado='rechazada'` + `motivo_rechazo`.)
3. **Compuerta de no-op**: si `line_set_hash` coincide con el de la versión vigente → `{ status: 'sin_cambios' }`, no se crea versión. Esto es lo que mantiene idempotente la reentrega de un webhook.
4. Upsert de oro con **anulación completa** de las columnas del motor (`risk_score, risk_color, risk_incidences, risk_reasons, ruleset_hash, risk_insufficient_data, risk_color_efectivo, risk_score_efectivo, risk_disposiciones`). Nota: el upsert actual olvida anular `risk_reasons` y `ruleset_hash`, dejando razones que describen datos que ya no existen. Se corrige aquí.
5. **Bajas**: `DELETE FROM shipments WHERE manifest_id=$1 AND idempotency_key <> ALL($2)`. Las claves borradas van al `diff` de la versión y al payload del evento.
6. `UPDATE manifests SET version_vigente=n, ingestion_status='promoted', risk_stale=true, source_file_id=…, file_content_hash=…, source_header=…`.
7. Fuera de la transacción: evento `MANIFIESTO_VERSIONADO` + `recordAudit` (con `before` = {versión anterior, `line_set_hash`, counts} — *el before se audita, no sólo el after*).
8. `runRiskForManifest` → materializar efectivo → `estado_documental` según el resumen **efectivo** → evento `RIESGO_EVALUADO` con `manifiestoVersion` en el payload.
9. `syncOperacionGuias` de nuevo. Las guías que desaparecen **no se borran** (pueden estar `retenida` o cubiertas por un pedimento); se listan en el payload como `guiasRetiradas`.
10. Requerimientos abiertos cuyos hallazgos citados ya no disparan: se listan como `requerimientosSinHallazgoVigente`. **Nunca se cancelan solos** — cancelar es un acto humano con motivo, y ya existe el endpoint.

---

## 3. Decisión 2 — `riesgo_disposiciones`: el humano afirma, el motor no se toca

### Identidad de un hallazgo

Hoy una bandera no tiene identidad: es un elemento de `shipments.risk_reasons` (`{signalId, points, weight, detail, evidence?, forcesBand?}`). La disposición se ancla en:

- **la línea**: `shipment_id` (FK `ON DELETE SET NULL`) **más** `manifest_id` + `idempotency_key` desnormalizados. Misma razón que `operacion_eventos.operacion_mawb`: que una línea retirada por una corrección no borre la afirmación de un humano.
- **el hallazgo**: `hallazgo_hash` = sha256 sobre una **proyección** del ReasonCode, no sobre el ReasonCode entero.

### La proyección: identidad sí, magnitud no

Las evidencias del motor se parten en dos clases:

| Clase | Campos | ¿Entra al hash? |
|---|---|---|
| Identidad — *qué* coincidió | `matched`, `source`, `program`, `id` | **Sí** |
| Magnitud — *cuánto* | `quantity`, `value`, `entityTotal`, `cap`, `distinctConsignees`, `monthlyCount` | No |

Si se hashea la magnitud, una disposición sobre "5 importaciones este mes" se evapora sola al llegar la sexta: ruido puro. Si no se hashea la identidad, una disposición sobre `pirateria: Nike` cubriría en silencio un golpe posterior sobre `Rolex`, o una disposición sobre una entrada OFAC cubriría una entrada EU distinta — que es exactamente lo que un auditor va a preguntar. La proyección vive en un solo mapa exportado `HUELLA_EVIDENCIA: Record<SignalId, string[]>` en `shared/risk`, con su `HUELLA_VERSION` dentro del hash, para que un cambio futuro de criterio sea visible en el dato y no sólo en el diff de git.

La fila guarda además **`hallazgo jsonb` con el ReasonCode íntegro** (magnitud incluida), igual que `riesgo_requerimientos.reason_codes` cita al motor verbatim: la huella sirve para el arrastre; la cita sirve para el auditor.

### Estados y efecto

| `estado` | Significado | Efecto en el color efectivo | Requisito extra |
|---|---|---|---|
| `falso_positivo` | el motor se equivocó | suprime el hallazgo | `motivo` |
| `mitigado` | el hallazgo era real y está resuelto | suprime el hallazgo | `motivo` + (`evidencia_file_id` **o** `requerimiento_id`), por CHECK |
| `confirmado` | el humano le da la razón al motor | **ninguno** | `motivo` |

`confirmado` existe porque "alguien miró esto y está de acuerdo" es un hecho, y porque insertar un `confirmado` es también la forma natural de **retractar** una disposición previa sin borrar nada: la tabla es append-only y gana la última fila por clave. `supersede_a` (auto-FK, patrón `renovado_de_convenio_id`) deja la cadena legible.

### Arrastre y caducidad tras un recálculo

La aplicabilidad **no se escribe nunca**: se evalúa en el momento de materializar, contra las razones que el motor acaba de producir. Una disposición aplica si y sólo si:

1. existe una razón vigente con el mismo `(signalId, hallazgo_hash)`; **y**
2. si esa razón es `forcesBand:'rojo'` (`denied_party`, `prohibidos`, `pirateria`), además `ruleset_hash` coincide con el de la corrida vigente.

La asimetría de (2) es deliberada y es la regla que un auditor respeta: cuando cambia la lista de sancionados, cambia `ruleset_hash`, y una afirmación hecha contra la lista anterior no puede seguir tapando un golpe contra la nueva. Para las señales graduadas, un cambio de ruleset no anula la disposición pero la marca `revalidacion_pendiente` en la lectura (ámbar), porque invalidar cientos de disposiciones cada vez que un admin ajusta un umbral sería castigo sin delito.

Una corrección de manifiesto que cambia el dato hace caducar la disposición **sola**, sin ninguna escritura: la razón nueva tiene otra huella (si cambió lo que coincidió) o simplemente ya no dispara.

### Color efectivo — materializado, nunca sobreescrito

```
efectivo = scoreRow(razones \ suprimidas, { weights, bands, insufficientData })
```

Se reutiliza `scoreRow` de `shared/risk/scorecard.ts` tal cual: determinista, ya probado, y reproducible por un tercero. Para que la banda `gris` siga saliendo bien cuando se suprime un forzado-rojo sobre una fila con datos insuficientes, `riskService` persiste el booleano que hoy calcula y tira: **`shipments.risk_insufficient_data`**.

`materializarRiesgoEfectivo(q, {shipmentId | manifestId})` escribe `risk_color_efectivo`, `risk_score_efectivo` y `risk_disposiciones jsonb` (el resumen aplicado, para que las lecturas no hagan join por fila). **NULL significa "sin disposición, manda el motor"**, así que todos los consumidores pasan a `COALESCE(s.risk_color_efectivo, s.risk_color)` y nada más:

- `server/src/routes/dashboard.ts` (distribución)
- `server/src/routes/records.ts` (filtro por color)
- `server/src/routes/consolidated.ts` (`Valida`)
- `server/src/services/reportData.ts` (pantalla + xlsx)

**Deriva de configuración.** El efectivo se recalcula con la config fresca. Si el `ruleset_hash` fresco no coincide con el almacenado en la fila, no se inventa un run nuevo: se marca `manifests.risk_stale = true` y la escritura de disposición responde 409 ("vuelva a correr el análisis antes de disponer"). Reutiliza el concepto de rancio que ya existe y ya tiene banner ámbar, en vez de inventar una tabla de corridas.

---

## 4. Decisión 3 — Cómo se tocan las dos rutas

- Corregir el manifiesto **re-corre el riesgo** y las disposiciones caducan o se arrastran solas (§3). No hay código de reconciliación.
- Disponer una bandera **jamás** escribe `risk_score`, `risk_color`, `risk_incidences`, `risk_reasons` ni `ruleset_hash`. Invariante verificable con un test que compara esas cinco columnas byte a byte antes y después de una disposición.
- **La máquina de estados pasa a leer efectivo**: en `server/src/services/prealertaIngest.ts`, `conHallazgos = risk.summary.validarEnPrevio > 0` pasa a `risk.summaryEfectivo.validarEnPrevio > 0`. `runRiskForManifest` devuelve **ambos** resúmenes. `riesgo_con_hallazgos` / `riesgo_ok`, los requerimientos y el congelamiento CT-4 se colgarán del efectivo; el crudo se conserva íntegro en la fila y en el artefacto.
- **El artefacto `Analisis_de_Riesgo.xlsx` gana dos columnas**: `Resultado` sigue siendo la palabra del motor, y se añaden `Disposición` y `Motivo de disposición`. Un documento que cambia su columna `Resultado` porque alguien afirmó algo es un documento que miente; uno que pone las dos cosas lado a lado es el expediente.

---

## 5. La historia frente a la autoridad

Cuatro preguntas, cuatro respuestas de una sola fuente:

| Pregunta | Dónde se responde |
|---|---|
| ¿Qué dijo el sistema? | `shipments.risk_*` + `ruleset_hash`, inmutables por (versión de datos, ruleset). Reproducible: mismo ruleset sobre las líneas bronce de esa versión → mismo resultado. |
| ¿Qué afirmó un humano, y por qué? | `riesgo_disposiciones`, append-only por trigger, `motivo` NOT NULL con CHECK de no-vacío, `created_by`, evidencia opcional. |
| ¿Qué datos cambiaron? | `manifiesto_versiones` (documento, archivo, hash, motivo, diff) + `manifest_staging_rows` retenidas por versión (línea a línea). |
| ¿En qué orden? | `operacion_eventos` + `audit_log` encadenado por hash, y un solo `GET /api/audit/verify` los cubre a ambos. |

---

## 6. DDL

### Migración A — `1700005600000_manifiesto_versiones.ts`

```sql
CREATE TABLE manifiesto_versiones (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id       uuid NOT NULL REFERENCES manifests ON DELETE CASCADE,
  version           integer NOT NULL,
  estado            text NOT NULL DEFAULT 'staged'
                    CHECK (estado IN ('staged','aplicada','rechazada')),
  origen            text NOT NULL
                    CHECK (origen IN ('carga_manual','prealerta')),
  motivo            text,           -- obligatorio desde la v2 (CHECK abajo)
  motivo_rechazo    text,
  source_file_id    uuid REFERENCES files ON DELETE SET NULL,
  file_content_hash text,
  source_header     jsonb,
  line_set_hash     text,           -- NULL sólo en las v1 retro-llenadas (ver nota)
  counts            jsonb NOT NULL DEFAULT '{}',
  diff              jsonb,          -- {altas:[key], bajas:[key], modificadas:[key], sinCambio:n}
  aplicada_at       timestamptz,
  created_by        uuid REFERENCES users ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE manifiesto_versiones
  ADD CONSTRAINT manifiesto_versiones_uq UNIQUE (manifest_id, version),
  ADD CONSTRAINT manifiesto_versiones_motivo_check
    CHECK (version = 1 OR estado = 'rechazada'
           OR (motivo IS NOT NULL AND btrim(motivo) <> ''));
CREATE INDEX ON manifiesto_versiones (manifest_id, version DESC);

ALTER TABLE manifests ADD COLUMN version_vigente integer NOT NULL DEFAULT 1;

ALTER TABLE manifest_staging_rows
  ADD COLUMN version  integer NOT NULL DEFAULT 1,
  ADD COLUMN row_hash text;                       -- sha256 del shipment EN CLARO
ALTER TABLE manifest_staging_rows DROP CONSTRAINT manifest_staging_rows_idem_uq;
ALTER TABLE manifest_staging_rows
  ADD CONSTRAINT manifest_staging_rows_idem_uq UNIQUE (manifest_id, version, idempotency_key);
CREATE INDEX ON manifest_staging_rows (manifest_id, version);
```

Retro-llenado: una fila `manifiesto_versiones` v1 `estado='aplicada'` por cada manifiesto existente, copiando `source_file_id`, `file_content_hash`, `source_header` de la cabecera y los `counts` desde staging. `line_set_hash` y `row_hash` quedan **NULL a propósito**: son hashes de texto en claro y la migración no descifra PII para calcularlos. La compuerta de no-op trata NULL como "desconocido → siempre crear versión", que falla del lado seguro.

### Migración B — `1700005700000_riesgo_disposiciones.ts`

```sql
ALTER TABLE shipments
  ADD COLUMN risk_insufficient_data boolean,
  ADD COLUMN risk_color_efectivo    text,
  ADD COLUMN risk_score_efectivo    integer,
  ADD COLUMN risk_disposiciones     jsonb;

CREATE TABLE riesgo_disposiciones (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  manifest_id        uuid NOT NULL REFERENCES manifests ON DELETE CASCADE,
  shipment_id        uuid REFERENCES shipments ON DELETE SET NULL,
  idempotency_key    text NOT NULL,          -- identidad durable de la línea
  manifiesto_version integer NOT NULL,
  signal_id          text NOT NULL,
  hallazgo_hash      text NOT NULL,
  hallazgo           jsonb NOT NULL,         -- el ReasonCode verbatim
  ruleset_version    text,
  ruleset_hash       text NOT NULL,
  estado             text NOT NULL
                     CHECK (estado IN ('falso_positivo','mitigado','confirmado')),
  motivo             text NOT NULL,
  evidencia_file_id  uuid REFERENCES files ON DELETE SET NULL,
  requerimiento_id   uuid REFERENCES riesgo_requerimientos ON DELETE SET NULL,
  supersede_a        uuid REFERENCES riesgo_disposiciones ON DELETE SET NULL,
  created_by         uuid REFERENCES users ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE riesgo_disposiciones
  ADD CONSTRAINT riesgo_disposiciones_motivo_check CHECK (btrim(motivo) <> ''),
  ADD CONSTRAINT riesgo_disposiciones_mitigado_check
    CHECK (estado <> 'mitigado'
           OR evidencia_file_id IS NOT NULL OR requerimiento_id IS NOT NULL);
CREATE INDEX ON riesgo_disposiciones (shipment_id, signal_id, hallazgo_hash, created_at DESC);
CREATE INDEX ON riesgo_disposiciones (manifest_id);
-- append-only, misma función-trigger que audit_log / operacion_eventos
```

`demo-reset` no requiere cambios: ambas tablas cuelgan de `manifests` con CASCADE y el reset ejecuta `DELETE FROM manifests`. Vale la pena decirlo explícitamente en el comentario de la migración, porque `TABLAS_OPERACIONES` usa `TRUNCATE` sin CASCADE y ahí sí una tabla nueva no listada rompe.

---

## 7. Endpoints

| Método y ruta | Rol | Qué hace |
|---|---|---|
| `POST /api/manifests/:id/versiones` (multipart: `file`) | admin, capturista | Parsea, escribe staging v(n) `estado='staged'`, calcula el diff contra la vigente. **No aplica.** 409 si hay pedimento `cargado` (y deja la versión `rechazada` registrada); `{status:'sin_cambios'}` si el `line_set_hash` coincide. |
| `POST /api/manifests/:id/promote` (body: `motivo`) | admin, capturista | *(existente, ahora consciente de versiones)* Aplica la versión staged más alta. `motivo` obligatorio desde la v2. Dispara riesgo + efectivo + eventos. |
| `GET /api/manifests/:id/versiones` | cualquiera con acceso al manifiesto, **incluida `autoridad`** | Lista de versiones: versión, estado, quién, cuándo, motivo, counts, diff, `sourceFileId`. Es la pantalla del auditor. |
| `GET /api/manifests/:id/staging?version=n` | admin, capturista | *(existente)* Ahora acepta versión; por defecto la vigente. |
| `POST /api/manifests/:id/riesgo/disposiciones` | según §9 | `{shipmentId, signalId, estado, motivo, evidenciaFileId?, requerimientoId?}`. El servidor **calcula `hallazgo_hash` desde la razón almacenada**, nunca desde el cuerpo. 409 si esa señal no dispara hoy en esa línea; 409 si `risk_stale`. Materializa el efectivo y responde con el color crudo y el efectivo. |
| `GET /api/manifests/:id/riesgo/disposiciones` | lectura amplia (incl. `autoridad`) | Historial completo, incluidas las superseded y las caducadas, con `aplicable: boolean` y `revalidacionPendiente: boolean` calculados. |

`POST /api/manifests` conserva el 409 por MAWB duplicado (crear una segunda fila debe seguir siendo imposible) y añade `puedeSustituir: true` junto al `manifestId` que ya devuelve, para que la UI ofrezca "Sustituir" en un clic.

---

## 8. Vocabulario de eventos y auditoría

`TIPOS_EVENTO` en `shared/operaciones/estados.ts` gana tres:

- `MANIFIESTO_VERSIONADO` — payload: `{manifestId, version, origen, motivo, counts, diff, lineSetHash, guiasRetiradas, requerimientosSinHallazgoVigente}`
- `MANIFIESTO_VERSION_RECHAZADA` — payload: `{manifestId, version, motivoRechazo, pedimentosCargados}`
- `RIESGO_HALLAZGO_DISPUESTO` — payload: `{shipmentId, guia, signalId, estado, motivo, colorCrudo, colorEfectivo, disposicionId, supersedeA}`

**De paso, honestidad del vocabulario**: `REQUERIMIENTO_EMITIDO`, `REQUERIMIENTO_RESUELTO`, `REQUERIMIENTO_CANCELADO` y `REQUERIMIENTO_VENCIDO` ya se escriben en `operacion_eventos` desde `routes/riesgoRequerimientos.ts` y `services/requerimientosService.ts` pero **no están en la lista**. La columna `tipo` no tiene CHECK, así que nadie se enteró. Se añaden en la misma migración de vocabulario.

`recordAudit` (acciones): `MANIFIESTO_VERSIONADO` (entity `manifest`, con `before` de la versión anterior), `MANIFIESTO_VERSION_RECHAZADA`, `RIESGO_DISPOSICION` (entity `shipment`). Los payloads llevan **claves de idempotencia y hashes, nunca valores de PII**: el diff es una vista derivable de dos versiones retenidas, no una afirmación aparte.

Un manifiesto sin `operaciones` asociada (carga manual) escribe sólo auditoría; el evento requiere caso y el ledger no debe llenarse de filas huérfanas.

---

## 9. Matriz de roles

Regla, en una frase: **el rol que hace falta para tapar un hallazgo es el mismo que hace falta para editar la lista que lo produjo.**

| Acción | capturista | admin | super_admin | autoridad | tramitador |
|---|---|---|---|---|---|
| Subir versión sustitutiva / aplicarla | ✔ | ✔ | ✔ | — | — |
| Ver versiones y diffs | ✔ | ✔ | ✔ | **✔** | — |
| `confirmado` (no suprime nada) | ✔ | ✔ | ✔ | — | — |
| Suprimir hallazgo en fila cruda **amarilla** | ✔ | ✔ | ✔ | — | — |
| Suprimir hallazgo en fila cruda **roja** (no forzada) | — | ✔ | ✔ | — | — |
| Suprimir `prohibidos` / `pirateria` (forzados) | — | ✔ | ✔ | — | — |
| Suprimir `denied_party` (forzado) | — | — | **✔** | — | — |
| Ver disposiciones y motivos | ✔ | ✔ | ✔ | **✔** | — |

`denied_party` es super_admin porque `denied_parties` ya es la única clave de config restringida a super_admin "para prevenir manipulación" (`catalogs.ts`, `SUPER_ADMIN_CONFIG_KEYS`). Si sólo el super admin puede tocar la lista de sancionados, sólo el super admin puede declarar falso positivo un golpe contra ella. `tramitador` queda fuera con la misma frase que ya usa `riesgoRequerimientos.ts`: el rol de campo reporta hechos, no impone ni levanta obligaciones.

---

## 10. UI — superficie mínima

1. **`RiskResultTable`** (`src/components/RiskResultTable.tsx`)
   - `Resultado` renderiza el **efectivo** con `StatusPill`; debajo, en `text-xs text-slate-500`, `motor: rojo` cuando difieren. La palabra del motor nunca desaparece de la pantalla.
   - Columna nueva **`Disposición`**: badge ámbar con el mismo lenguaje que el badge de Override (`Falso positivo` · `Mitigado` · `Confirmado`), y `Revalidar` en ámbar cuando hay `revalidacionPendiente`.
   - Acción por fila **Disponer** → formulario en línea de dos pasos (sin modal anidado, como el borrado de pedimento en el wizard): lista las señales que dispararon con su `detail`, radio de estado, `motivo` obligatorio, adjunto opcional. Botón deshabilitado si el rol no alcanza, con el motivo del bloqueo escrito.
2. **`RiskPanel` / `ReportTabs`** — se conserva el banner ámbar de rancio; se añade en la cabecera `Manifiesto v3 · ver versiones`, que despliega la lista (versión, fecha, quién, motivo, altas/bajas/modificadas, descarga del archivo fuente). Es también la pantalla que `autoridad` abre.
3. **`RegistroView`** — al recibir 409 por MAWB duplicado, en vez de un error muerto: "Ya existe un manifiesto para esta guía. **¿Sustituirlo?**" → pide motivo → `POST /versiones` → muestra el diff (altas/bajas/modificadas) → `promote` → re-corre riesgo y muestra el resumen nuevo.
4. **Requerimientos**: se mantienen **ortogonales**. El backend completo sin UI sigue sin UI en este alcance; lo único que se toca es que la disposición `mitigado` puede citar un `requerimientoId` existente. Una fase 5 opcional le pone pantalla, pero no está en la ruta crítica de esta entrega y mezclarla la duplicaría de tamaño.

---

## 11. Orden de migración y despliegue

1. **A** (`manifiesto_versiones` + staging versionada + `version_vigente`) — retrocompatible: el código viejo sigue funcionando con `version` default 1 y la unique nueva es un superset de la vieja para v1.
2. Despliegue del código de la Fase 1 (versiones). A partir de aquí la vía prealerta deja de descartar correcciones.
3. **B** (`riesgo_disposiciones` + columnas efectivas). Retrocompatible: todo NULL = manda el motor; `COALESCE` da exactamente el comportamiento de hoy.
4. Despliegue Fases 2–3, luego 4. No hace falta backfill de `risk_insufficient_data`: queda NULL hasta la siguiente corrida, y NULL se trata como `false` salvo que la banda cruda sea `gris`, en cuyo caso se infiere `true` (una línea, comentada).

Sin ventana de inactividad, sin migración de datos costosa, sin dos caminos de código conviviendo.

---

## 12. Plan por fases (dimensionadas para delegar)

**Fase 1 — Manifiesto versionado (server).** Migración A. Nuevo `server/src/services/manifiestoVersiones.ts` con `aplicarVersion` + cálculo de `row_hash`/`line_set_hash`/diff. `routes/manifests.ts`: `POST /versiones`, `GET /versiones`, `promote` consciente de versión y motivo, `GET /staging?version=`. `services/manifiestoIngest.ts` reescrito para delegar (arregla §0). Eventos + auditoría + vocabulario. Tests: corrección aplicada de verdad, bajas borradas, reenvío idéntico = no-op, pedimento `cargado` = 409 con versión rechazada registrada, historia bronce intacta.

**Fase 2 — Riesgo efectivo (shared + server).** Migración B (columnas de `shipments`). `shared/risk/efectivo.ts`: `hallazgoHash`, `HUELLA_EVIDENCIA`, `evaluarDisposiciones`, `colorEfectivo` (sobre `scoreRow`), todo puro y probado sin DB. `server/src/services/riesgoEfectivo.ts` con `materializarRiesgoEfectivo`. `riskService` persiste `risk_insufficient_data`, materializa y devuelve `summary` + `summaryEfectivo`. Los cuatro consumidores pasan a `COALESCE`. `prealertaIngest` usa el efectivo para `estado_documental`.

**Fase 3 — API de disposiciones (server).** Tabla + trigger append-only. `routes/riesgoDisposiciones.ts` (POST/GET), esquemas de validación, compuertas de rol, 409 por señal inexistente y por rancio, eventos + auditoría, enlace opcional a requerimiento. Test central: una disposición deja las cinco columnas del motor byte a byte idénticas.

**Fase 4 — UI.** Columna y formulario de disposición en `RiskResultTable`, badges, panel de versiones en `ReportTabs`, flujo de sustitución en `RegistroView`, tipos en `shared/types/reports.ts` (`RiskScreenRow` gana `resultadoEfectivo`, `disposicion`, `revalidacionPendiente`; `RiskBundle` gana `version` y `summaryEfectivo`).

**Fase 5 (opcional, fuera de la ruta crítica).** Pantalla mínima de `riesgo_requerimientos` colgada del panel de riesgo (emitir / resolver / cancelar), que le da cara a un backend completo que hoy no la tiene.

Dependencias: 1 → 2 → 3 → 4. La 5 sólo depende de la 4.

---

## 13. Riesgos y preguntas abiertas

- **Retención de bronce.** Un manifiesto de 20 000 líneas con cinco versiones son 100 000 filas de staging. Es dato de retención fiscal y el índice es `(manifest_id, version)`, así que consulta barata; una política de archivado es decisión del archivo, no de este diseño.
- **Pedimento capturado (no `cargado`) cuyas guías cubiertas desaparecen en la versión nueva.** Se avisa (payload `guiasRetiradas` + advertencia en la respuesta) pero **no se bloquea**: el pedimento sigue siendo editable y la maquinaria de cobertura/reconciliación ya lo va a señalar. Si el producto prefiere bloquear, es un `if` en la compuerta 2 — pero bloquear aquí obligaría a borrar el pedimento para aceptar una corrección legítima del cliente.
- **`autoridad` sólo lee.** Confirmar con producto que no debe poder disponer nada; el diseño asume que su valor es ser el testigo, no el actor.
- **`HUELLA_EVIDENCIA`** es la única pieza de juicio nuevo del diseño (qué cuenta como "el mismo hallazgo"). Está aislada en un mapa con versión propia justamente para poder cambiar de opinión sin reescribir nada.

---

## 14. Addendum verificado

**El defecto de §0 además no tiene cobertura de test.** `server/test/services/prealertaIngest.test.ts:489` siembra una fila vacía de `manifests` y sólo afirma que existe una fila y que `operaciones.manifest_id` no es null — nunca verifica que alguna línea se haya ingestado. Con esa semilla, `promoteStagedRows` promueve cero filas y el test pasa igual. La Fase 1 debe reescribir ese test para contar líneas de `shipments`, no filas de `manifests`.

**Bugs menores que este trabajo arregla de paso:**
- El upsert de promoción no anula `risk_reasons` ni `ruleset_hash` (quedan razones que describen datos que ya no existen).
- `file_content_hash` / `source_file_id` no se actualizan al adjuntar un reenvío.
- Cuatro tipos de evento `REQUERIMIENTO_*` se escriben sin estar en `TIPOS_EVENTO` (la columna `tipo` no tiene CHECK, por eso nadie se enteró).

**Verificaciones previas a codificar:**
1. Contar cuántos manifiestos tienen hoy algún pedimento `cargado` — determina si la compuerta de bloqueo muerde en producción desde el día uno.
2. Buscar en `operacion_eventos` los `MANIFIESTO_ADJUNTADO` con más de un adjunto por MAWB: son correcciones que el sistema descartó en silencio y que probablemente haya que reprocesar tras la Fase 1.
3. Medir `runRiskForManifest` sobre manifiestos grandes: hace un `UPDATE` por fila en bucle (`riskService.ts:87-92`); con 20 000 líneas son 20 000 round-trips. Si duele, la corrección es `UPDATE ... FROM unnest()` — optimización aparte, no debe colarse en estas fases.

**Decisión de producto adicional:** confirmar que existe un super_admin operativamente disponible antes de restringirle `denied_party`; si no hay uno a las 3 a.m., la regla se convierte en bloqueo.

---

## 15. Paquete de ejecución (órdenes de trabajo para agentes de implementación)

**Orden:** 1 → 2 → 3 → 4, estrictamente. Cada fase es desplegable sola y retrocompatible. Nada de trabajo en paralelo entre fases: la 2 necesita `manifiesto_version` de la 1, la 3 necesita el materializador de la 2, la 4 necesita los tipos de la 3.

**Antes de la fase 1**, tres consultas de sólo lectura contra la base real:

```sql
-- 1. ¿Va a morder la compuerta de bloqueo desde el día uno?
SELECT count(*) FROM (SELECT manifest_id FROM pedimentos
  WHERE sub_status='cargado' GROUP BY manifest_id) t;

-- 2. Correcciones que el sistema ya tiró en silencio (reprocesar tras la fase 1)
SELECT entity_id, count(*) FROM audit_log
  WHERE action='MANIFIESTO_ADJUNTADO' GROUP BY entity_id HAVING count(*) > 1;

-- 3. Tamaño real del recálculo por versión
SELECT max(n) FROM (SELECT manifest_id, count(*) n FROM shipments GROUP BY manifest_id) t;
```

Si (3) pasa de unos miles, `riskService.ts:87-92` hace un `UPDATE` por fila en bucle y cada versión aplicada lo dispara. La corrección es `UPDATE ... FROM unnest()`, pero va **fuera** de estas fases: no se mete una optimización dentro de un cambio de semántica.

### Orden de trabajo 1 — Manifiesto versionado

**Archivos:** `server/migrations/1700005600000_manifiesto_versiones.ts` (nuevo) · `server/src/services/manifiestoVersiones.ts` (nuevo) · `server/src/routes/manifests.ts` · `server/src/services/manifiestoIngest.ts` · `shared/operaciones/estados.ts` · `server/src/validation/schemas.ts` · `server/test/services/manifiestoVersiones.test.ts` (nuevo) · `server/test/services/prealertaIngest.test.ts`

**Las cuatro trampas, por orden de probabilidad de tropiezo:**

1. `row_hash` se calcula sobre el shipment **en claro, antes de `encryptShipmentPii`**. `fieldCrypto` usa IV aleatorio por campo: comparar `data` jsonb marca todo como modificado, siempre.
2. El upsert de oro debe anular **las cinco** columnas del motor, no las tres de hoy. `risk_reasons` y `ruleset_hash` sobreviven al refresh actual y quedan describiendo datos que ya no existen.
3. La compuerta de pedimento `cargado` **inserta la versión con `estado='rechazada'` y luego devuelve 409**. No es un early-return: el documento del cliente queda archivado y el rechazo en el expediente. Espejo de `prealertas.motivo_rechazo`.
4. Las bajas se borran de `shipments` (`DELETE ... WHERE idempotency_key <> ALL($2)`), pero las `operacion_guias` correspondientes **no**: pueden estar `retenida` o cubiertas por un pedimento. Van al payload como `guiasRetiradas`.

**Criterios de salida (tests que deben existir y fallar antes del cambio):**
- Un reenvío con líneas corregidas cambia `shipments` de verdad. Este test es la razón de ser de la fase.
- Reenvío byte-idéntico → `sin_cambios`, cero versiones nuevas (idempotencia de webhook).
- Pedimento `cargado` → 409 **y** fila `manifiesto_versiones` con `estado='rechazada'`.
- Tras aplicar v2, las filas bronce de v1 siguen ahí, intactas, con sus `errors`/`warnings`.
- Corregir `prealertaIngest.test.ts:489`: hoy siembra un manifiesto vacío y afirma que existe una fila. Debe afirmar que las líneas se ingirieron.

### Orden de trabajo 2 — Riesgo efectivo

**Archivos:** `server/migrations/1700005700000_riesgo_disposiciones.ts` (sólo las columnas de `shipments` en esta fase) · `shared/risk/efectivo.ts` (nuevo) · `server/src/services/riesgoEfectivo.ts` (nuevo) · `server/src/services/riskService.ts` · `server/src/routes/dashboard.ts` · `server/src/routes/records.ts` · `server/src/routes/consolidated.ts` · `server/src/services/reportData.ts` · `server/src/services/prealertaIngest.ts`

**Trampas:**

1. `shared/risk` **no importa `node:crypto`** por convención de casa — salvo `hash.ts`, que ya lo hace. `hallazgoHash` va en `hash.ts` o al lado, reutilizando su `canonical`. No hay PII en la huella.
2. `colorEfectivo` **envuelve** `scoreRow`, no lo reimplementa ni lo modifica. Si hay que tocar `scorecard.ts`, algo salió mal.
3. `risk_insufficient_data` sin backfill: NULL se trata como `false` salvo que la banda cruda sea `gris`, y ahí se infiere `true`. Una línea, comentada — es exactamente el caso en que suprimir un forzado-rojo debe devolver `gris` y no `verde`.
4. `NULL` en `risk_color_efectivo` significa "sin disposición, manda el motor". Todo consumidor usa `COALESCE`. Ninguno aprende qué es una disposición.

**Criterio de salida:** sin ninguna disposición en la base, las cuatro superficies (dashboard, records, consolidated, reportData) devuelven exactamente lo mismo que antes del cambio. Test de igualdad byte a byte contra el fixture actual.

### Orden de trabajo 3 — API de disposiciones

**Archivos:** la tabla en la migración de la fase 2 · `server/src/routes/riesgoDisposiciones.ts` (nuevo) · `server/src/app.ts` · `server/src/validation/schemas.ts` · `server/test/routes/riesgoDisposiciones.test.ts` (nuevo)

**Trampas:**

1. `hallazgo_hash` se calcula **en el servidor, desde la razón almacenada en `shipments.risk_reasons`**. Nunca desde el cuerpo de la petición. Un cliente que puede elegir la huella puede disponer un hallazgo que no existe.
2. 409 si la señal no dispara hoy en esa línea. 409 si `manifests.risk_stale`. Un humano no dispone sobre datos rancios.
3. La tabla es append-only por trigger. Retractarse es insertar `confirmado` con `supersede_a`, no borrar ni actualizar.

**Criterio de salida:** tras cualquier disposición, `risk_score`, `risk_color`, `risk_incidences`, `risk_reasons` y `ruleset_hash` quedan byte a byte idénticas. El motor no se toca nunca.

### Orden de trabajo 4 — UI

**Archivos:** `src/components/RiskResultTable.tsx` · `src/components/ReportTabs.tsx` · `src/components/RegistroView.tsx` · `shared/types/reports.ts` · `server/src/routes/reports.ts` (el bundle debe empezar a mandar `ReasonCode[]`, que hoy nunca sale al frontend)

**Trampas:**

1. El color del motor **nunca desaparece de la pantalla**. Efectivo en el `StatusPill`, `motor: rojo` en caption apagado debajo cuando difieren.
2. Confirm en línea de dos pasos, sin modal anidado: el workspace los quitó a propósito. Copiar el patrón del borrado de pedimento.
3. `reports.json` empieza a exponer `risk_reasons`, que hasta hoy nunca salió del servidor. Revisar que no arrastre PII en `evidence` — `denied_party` lleva `matched`, que puede ser un nombre. Redactar igual que el resto del bundle.

### Ajuste posterior: color anterior tras una corrección

Hueco detectado en revisión: para una **disposición**, el "antes" ya convive en la fila (`risk_color` motor vs `risk_color_efectivo`). Para una **corrección de manifiesto**, no — `aplicarVersion` anula las columnas del motor y re-corre; el color que la línea tenía en la versión anterior se pierde (el bronce retiene el dato, no su calificación).

**Arreglo (va en la migración A, no la B — es de versionado, no de disposiciones):**

```sql
ALTER TABLE shipments
  ADD COLUMN risk_color_anterior   text,
  ADD COLUMN risk_score_anterior   integer,
  ADD COLUMN risk_version_anterior integer;
```

El acarreo ocurre en el mismo upsert que hoy borra el dato, sin lectura extra — dentro del `DO UPDATE`, `shipments.risk_color` es la fila vieja y `EXCLUDED` la nueva:

```sql
ON CONFLICT (manifest_id, idempotency_key) DO UPDATE SET
  data                  = EXCLUDED.data,
  risk_color_anterior   = shipments.risk_color,
  risk_score_anterior   = shipments.risk_score,
  risk_version_anterior = $versionAnterior,
  risk_score = NULL, risk_color = NULL, risk_incidences = NULL,
  risk_reasons = NULL, ruleset_hash = NULL, risk_insufficient_data = NULL,
  risk_color_efectivo = NULL, risk_score_efectivo = NULL, risk_disposiciones = NULL
```

Al final de `runRiskForManifest`, un solo `UPDATE` anula los tres `_anterior` donde el color recalculado coincide con el viejo. Regla de UI resultante: **si `risk_color_anterior` no es NULL, hubo cambio y hay algo que enseñar** — ningún consumidor compara nada. Una sola generación de historia en la fila; la historia completa sigue reconstruible desde bronce + eventos.

**Gramática visual — dos causas distintas, dos etiquetas (nunca conflatarlas):**

| Situación | Pill | Tag | Qué muestra "el anterior" |
|---|---|---|---|
| Disposición humana | color **efectivo** | `Dispuesto` — ámbar, lenguaje Override | color del motor, señal, motivo, quién, cuándo |
| Corrección de manifiesto | color **nuevo del motor** | `v3` — neutro | `risk_color_anterior`, de qué versión, y si cambió *su* dato o el conjunto |
| Las dos | efectivo | ambos tags | historia completa de la línea |

Clic (no hover — debe funcionar en tablet) abre un popover con la historia de la línea. Matiz importante que sale gratis: una línea puede cambiar de color **sin que su propio dato cambie** (`agregado`, `direcciones`, `bbdd` son señales entre filas). El popover lo dice comparando el `row_hash` de ambas versiones: *"su dato no cambió; cambió el conjunto en la v3"*.

El artefacto `Analisis_de_Riesgo.xlsx` gana la columna `Resultado anterior` junto a las de disposición.

**Impacto en las órdenes de trabajo:**
- **Orden 1**: las tres columnas `_anterior` + el acarreo en el `ON CONFLICT`. Coste casi nulo si se hace ahora; hacerlo después obliga a inventar valores para filas ya reescritas.
- **Orden 2**: el `UPDATE` de limpieza al final de `runRiskForManifest`; `RiskScreenRow` expone `resultadoAnterior` / `versionAnterior`.
- **Orden 4**: los dos tags y el popover.

### Contratos (nada queda por derivar)

**DDL consolidada.** Migración A tal como quedó arriba, más las tres columnas `_anterior` de `shipments` (§ ajuste anterior). Migración B sin cambios.

**`shared/risk/efectivo.ts` — el módulo puro:**

```ts
export const HUELLA_VERSION = '2026-08a';

/** Campos de `evidence` que IDENTIFICAN el hallazgo. La magnitud queda fuera a propósito. */
export const HUELLA_EVIDENCIA: Record<SignalId, readonly string[]> = {
  id:           ['id'],
  monto:        ['direccion'],          // ver "único cambio al motor" abajo
  prohibidos:   ['matched'],
  pirateria:    ['matched'],
  denied_party: ['matched', 'source', 'program'],
  cantidad: [], agregado: [], direcciones: [], bbdd: [],
};

export function hallazgoHash(r: ReasonCode): string;

export interface DisposicionVigente {
  id: string; signalId: SignalId; hallazgoHash: string;
  estado: 'falso_positivo' | 'mitigado' | 'confirmado';
  rulesetHash: string; motivo: string; createdAt: string; createdBy: string | null;
}

export function evaluarDisposiciones(
  reasons: ReasonCode[],
  disposiciones: DisposicionVigente[],
  ctx: { rulesetHashVigente: string },
): {
  suprimidas: ReasonCode[];
  aplicadas: DisposicionVigente[];
  revalidacionPendiente: DisposicionVigente[];  // huella igual, ruleset distinto, señal graduada
  caducadas: DisposicionVigente[];              // sin razón vigente que las sostenga
};

export function colorEfectivo(
  reasons: ReasonCode[],
  suprimidas: ReasonCode[],
  opts: { weights: Weights; bands: Bands; insufficientData: boolean },
): { score: number; band: Band };   // envuelve scoreRow, no lo reimplementa
```

Nota de fragilidad, deliberada: la huella **no** incluye `detail`. Los textos son copy humano y se van a editar (i18n, typos); si participaran del hash, corregir una tilde caducaría cientos de afirmaciones humanas. El discriminador vive en `evidence`, no en la prosa.

**El único cambio al motor.** `shared/risk/signals.ts`, señal `monto`: hoy las dos variantes sólo se distinguen por el texto (`(muy bajo)` / `(muy alto)`). Se añade el discriminador al `evidence`:

```ts
add('monto', 1,    'Valor declarado incorrecto (muy bajo)', { value: s.customsValueUsd, direccion: 'bajo' });
add('monto', frac, 'Valor declarado incorrecto (muy alto)', { value: s.customsValueUsd, direccion: 'alto' });
```

Sin esto, disponer "el valor bajo está justificado" taparía también un valor **alto** posterior sobre la misma línea. No toca `ruleset_hash` (que cubre umbrales, pesos, bandas y listas, no la forma de la evidencia). Actualizar `shared/risk/signals.test.ts`.

**Contrato de la UI — `shared/types/reports.ts`:**

```ts
export interface RiskScreenRow {
  // ...campos actuales...
  resultado: RiskResultado;                 // EFECTIVO — lo que manda en el pill
  resultadoMotor: RiskResultado;            // crudo; sólo difiere si hay disposición
  resultadoAnterior: RiskResultado | null;  // null = sin tag de corrección
  versionAnterior: number | null;
  datoCambio: boolean;                      // true = cambió su línea; false = cambió el conjunto
  reasons: ReasonCodePublico[];             // hoy risk_reasons NUNCA sale del servidor
  disposiciones: DisposicionPublica[];
  revalidacionPendiente: boolean;
}

export interface RiskBundle {
  risk: RiskScreenRow[];
  riskStale: boolean;
  version: number;
  summary: RiskSummaryData;                 // motor
  summaryEfectivo: RiskSummaryData;
  generatedAt: string;
  contentHash: string;
}
```

`ReasonCodePublico` es `ReasonCode` **sin** `evidence.matched` en claro para `denied_party`: ese campo puede ser un nombre de persona y `reports.json` ya tiene disciplina de redacción. Se manda el `detail` (que ya lo dice de forma legible) y el hash.

**Esquemas zod nuevos (`server/src/validation/schemas.ts`):**

```ts
export const manifiestoVersionAplicarBody = z.object({
  motivo: z.string().transform(s => s.trim())
    .refine(s => s.length > 0, 'El `motivo` es obligatorio al sustituir un manifiesto.')
    .optional(),   // la ruta lo exige cuando version >= 2; opcional aquí para no romper v1
});

export const disposicionCrearBody = z.object({
  shipmentId: z.string().uuid(),
  signalId: z.enum(['id','cantidad','monto','agregado','direcciones','prohibidos','pirateria','bbdd','denied_party']),
  estado: z.enum(['falso_positivo','mitigado','confirmado']),
  motivo: z.string().transform(s => s.trim()).refine(s => s.length > 0, 'El `motivo` es obligatorio.'),
  evidenciaFileId: z.string().uuid().optional(),
  requerimientoId: z.string().uuid().optional(),
  supersedeA: z.string().uuid().optional(),
});
```

Reutilizar el `reasonCode` que ya existe donde haga falta. **No** hay campo `hallazgoHash` en el body: lo calcula el servidor desde `shipments.risk_reasons`.

**Respuestas de los endpoints:**

```
POST /:id/versiones      → 201 { version, estado:'staged', counts, diff:{altas,bajas,modificadas,sinCambio} }
                           409 { error, version, estadoVersion:'rechazada', motivoRechazo }
                           200 { status:'sin_cambios', version }
POST /:id/promote        → 200 { version, promoted, bajas, summary, summaryEfectivo, guiasRetiradas,
                                 requerimientosSinHallazgoVigente }
GET  /:id/versiones      → 200 { versiones:[{version,estado,origen,motivo,motivoRechazo,counts,diff,
                                 sourceFileId,createdBy,createdAt,aplicadaAt}], vigente }
POST /:id/riesgo/disposiciones → 201 { disposicionId, resultadoMotor, resultado, suprimidas:[signalId] }
                                 409 { error:'sin_hallazgo_vigente' | 'analisis_rancio' }
GET  /:id/riesgo/disposiciones → 200 { disposiciones:[{...,aplicable,revalidacionPendiente,caducada}] }
```

**Inventario de pruebas:**

- **Fase 1** — reenvío corregido cambia `shipments`; reenvío idéntico es no-op; pedimento `cargado` da 409 **con** fila `rechazada`; bronce de v1 intacto; `risk_color_anterior` acarreado; `prealertaIngest.test.ts:489` reescrito.
- **Fase 2** — `efectivo.test.ts` puro (arrastre por huella, caducidad por dato, ruleset distinto: caduca en forzados, marca revalidación en graduados, `gris` al suprimir un forzado sobre datos insuficientes); paridad byte a byte de las cuatro superficies sin disposiciones.
- **Fase 3** — las cinco columnas del motor intactas tras disponer; 409 por señal inexistente; 409 por rancio; `denied_party` rechazado a admin y aceptado a super_admin; retractación por `confirmado` + `supersede_a`; trigger append-only rechaza UPDATE y DELETE.
- **Fase 4** — pill con el efectivo, tag `Dispuesto` y tag `v3` por separado y juntos; popover distingue "cambió su dato" de "cambió el conjunto".

### Decisiones que no debe tomar un agente de implementación

Las cinco decisiones de producto de §13–14: bloquear o sólo avisar cuando una versión retira guías ya cubiertas; `autoridad` como testigo y no actor; si existe de verdad un super_admin disponible para desbloquear un `denied_party` de madrugada; el criterio de `HUELLA_EVIDENCIA` (identidad sí, magnitud no); y la política de retención del bronce. Ninguna bloquea la fase 1. La tercera bloquea el despliegue de la fase 3 a producción.

---

## Archivos críticos para la implementación

- `server/src/services/manifiestoIngest.ts` — contiene el defecto de §0; se convierte en cliente de `manifiestoVersiones.ts`
- `server/src/routes/manifests.ts` — `promote` consciente de versión + los dos endpoints nuevos
- `server/src/services/riskService.ts` — persiste `risk_insufficient_data`, materializa el efectivo, devuelve ambos resúmenes
- `shared/risk/scorecard.ts` — `scoreRow` es la función que el color efectivo reutiliza intacta (junto al nuevo `shared/risk/efectivo.ts`)
- `server/src/services/holdActivo.ts` — el patrón exacto que copia `materializarRiesgoEfectivo`
- `server/migrations/1700004700000_riesgo_requerimientos.ts` — la voz y la disciplina de comentario que deben seguir las dos migraciones nuevas
