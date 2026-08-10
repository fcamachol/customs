# Plan Completo — Sistema de Operaciones T1

**Un solo documento con todo el plan:** qué se prometió, qué está construido y desplegado, qué
falta, en qué orden, quién lo bloquea, y cómo se demuestra.

**Estado:** 2026-08-10 (commits `78da50f..684849f`) · producción `customs-v2` en `main` ·
repo `fercamachol/customs`. Todo el backlog de código de este documento está cerrado; lo que
queda pendiente es exclusivamente: infraestructura de usuario (volumen persistente, #39b),
credenciales de terceros que activan integraciones ya construidas (SMTP, evolution-api,
Cincel), rotación de secretos (#37), la unificación de convenios (diseñada, no construida) y
un lote de vistas de frontend todavía sin montar sobre APIs que ya existen. Ver §3–§5.
**Documentos hermanos** (no duplicar, este los resume): `docs/HANDOFF.md` (guía de continuación
operativa), `docs/PRD_sistema_operaciones.md` (spec maestra + transcripción + códigos de requisito),
`docs/PRD_sistema_operaciones_agora.md` (frontera de integración con AGORA), `docs/DEMO_E2E.md`
(qué prueba el runner). Este archivo es el índice vivo; ante conflicto, `HANDOFF.md` manda para
convenciones y `PRD_*` para el alcance.

---

## 0. Cómo leer esto

| Sección | Para quién |
|---|---|
| 1 Objetivo · 2 Arquitectura | Dirección — qué es y cómo encaja |
| 3 Estado por requisito | Todos — el marcador contra lo prometido en la junta |
| 4 Roadmap | Equipo — qué sigue, en qué orden, por qué |
| 5 Bloqueadores | Alfonso/Luis — lo que sólo ustedes destraban |
| 6 Disciplinas · 7 Convenciones | Ingeniería — reglas que no se rompen |
| 8 Demo · 9 Riesgos · 10 Preguntas abiertas | Todos |

Convención de códigos: `R#` requisitos, `PA-##` reglas de cotejo (banderas rojas), `CT-#`
contingencias, `D#` decisiones de la junta, `Q#` preguntas abiertas. Definidos en `PRD_*`.

---

## 1. Objetivo

Desarrollar el **sistema de operaciones** con **trazabilidad logística y financiera total** de las
liberaciones de carga T1, tal como lo pidió ANAM: la industria opera en Excel (manipulable), y lo
que la autoridad audita es que nada se pueda mover sin dejar rastro. El principio rector de Fernando:
**eliminar la decisión humana donde se pueda, y hacer inmutable todo lo demás** — "antes lo metían en
Excel; ahora es meterlo en un sistema donde no le puedas mover".

Dos sistemas en un repo:
- **PRD-01 · Análisis de Riesgo** — ya en producción antes de este esfuerzo.
- **PRD-02 · Sistema de Operaciones** — construido 6–10 ago 2026, este plan.

---

## 2. Arquitectura en seis líneas

1. **AGORA** (`agoracore.humansoftware.mx`, fork de Chatwoot; cuenta 9 "Aduanas", inbox 21
   `ops@capitalc.com.mx`) es el **transporte**: recibe el correo del cliente y lleva nuestras
   respuestas. **Nunca** es el sistema de registro (incinera el correo a 30 días; sus tablas son
   mutables).
2. **Este repo** es el registro: cada artefacto copiado a `files` con sha256, cada hecho en
   `operacion_eventos` (append-only por trigger) + `audit_log`, **una sola cadena de hash**
   verificable en `GET /api/audit/verify`.
3. AGORA → aduanas por **webhook firmado con HMAC** (`POST /api/prealertas/inbound`); aduanas →
   AGORA por su REST API. El **espejo** replica los eventos significativos como notas privadas en la
   conversación — el equipo ve el tracking donde ya trabaja, sin que AGORA sea la verdad.
4. Un **tick** (`POST /api/ops/tick`) corre las fases periódicas: seguimiento de vuelo (FlightAware
   AeroAPI primario, ADS-B de respaldo) y el barrido de reconciliación por webhooks perdidos. No hay
   scheduler en proceso, a propósito — lo dispara una tarea programada de Coolify.
5. Tres ejes de estado ortogonales por caso: `etapa` (física, monótona), `estado_documental`,
   `estado_planeacion`. Un **hold** inhibe la planeación, nunca la etapa física.
6. El **cotejo** compara lo declarado contra lo observado y levanta banderas rojas deterministas y
   versionadas; nunca las decide un LLM.

---

## 3. Estado por requisito (el marcador)

Leyenda: ✅ vivo en producción · 🟡 parcial · ⛔ bloqueado por el usuario · 📋 backlog

### Etapa 1–2 · Prealerta

| Req | Qué pidió la junta | Estado |
|---|---|---|
| R1, P1 | Cada correo del robot = un caso, automático | ✅ ingesta por webhook firmado |
| R2, R4 | Extracción de campos (guía, ruta, vuelo, ETD/ETA, bultos/piezas/peso) | ✅ parser determinista `2026-08c` |
| R3 | Dos adjuntos (AWB + manifiesto) archivados | ✅ copiados, hasheados, escaneados |
| R6, D2 | Reenvío con misma guía = actualización, no caso nuevo | ✅ versionado de prealerta |
| — | El formato REAL del cliente (dos puntos de ancho completo, `//`, meses en español, valor-antes-de-unidad) | ✅ golden tests con los asuntos reales |
| — | "Captura manual de 10 registros" (lo que pidieron como formulario) | ✅ **hecho innecesario** — el correo ES la captura |

### Etapa 3 · Seguimiento a vuelo

| Req | | Estado |
|---|---|---|
| R8, R9 | Estatus de vuelo automático contra "la BBDD de vuelos" | ✅ **FlightAware AeroAPI** — ETD/ETA/arribo reales, cancelación, desvío |
| — | Avance de etapa por hechos del vuelo (`en_vuelo`→`arribado`) | ✅ derivado, monótono |
| R12 | Cambios de ETA/demora en tiempo real | ✅ eventos `VUELO_DEMORADO`/`CANCELADO`/`ARRIBO` |
| Q3/#35 | Cobertura oceánica trans-Pacífico (Aireon) | ⛔ requiere alta con FlightAware |

### Etapa 4 · Despacho / cadena física (app del tramitador)

| Req | | Estado |
|---|---|---|
| R11 | Disponibilidad de carga (el almacén no avisa: sólo el tramitador presencial) | ✅ botón en Campo |
| R30 | Patio regulador + ingreso a aduana, hora citada vs real (`demoraMin`) | ✅ |
| R31, R32, D5 | Inicio/fin de carga **con foto** hasheada | ✅ evidencia sha256 ligada al evento |
| R33 | Modulación con **captura diferida** (sin celular en el semáforo): `ocurrido_at ≠ registrado_at` | ✅ |
| R34, D16 | Semáforo **green/red en inglés** (el cliente lo ve) | ✅ |
| R35 | Salida de rojo + **tiempo en rojo** (KPI) | ✅ `tiempoEnRojoMin` calculado |
| R36, D14 | Arribo estimado (tráfico) vs arribo real | ✅ `shared/operaciones/eta.ts` calcula el estimado determinista del último tramo (aduana→domicilio); `POST /api/despachos/:id/arribo` graba `arribo_real` y nunca toca `eta_calculado` — la comparación vive en `shared/operaciones/leadTimes.ts` (#29/#32) |
| R21–R29 | Catálogo transportistas/unidades/CAAT/placas, pedimento asignado, tipo-unidad-antes-de-línea (D7) | ✅ #29 — `transportistas.ts`/`despachos.ts`/`catalogs.ts`, migraciones `transportistas_catalogos`/`despachos`/`plan_publicaciones` |

### Banderas rojas · cotejo (R5)

| Regla | Qué detecta | Estado |
|---|---|---|
| PA-01/02/03 | Bultos/piezas/peso del correo ≠ manifiesto | ✅ |
| PA-04/05 | Vuelo/ruta y ETA inconsistentes con el itinerario real | ✅ (real con AeroAPI) |
| PA-07 | Guía casa duplicada en otra operación abierta | ✅ |
| PA-08 | Remitente que no resuelve a ningún cliente | ✅ |
| PA-10 | Vuelo no verificable — se reporta, nunca se silencia | ✅ |
| PA-06 | Piezas totales vs suma por caja | ⛔ no evaluable con el modelo actual (documentado) |
| PA-09 | Consignado a otra agencia (falta CSA) | 📋 requiere la patente consignataria, que hoy ningún artefacto declara |

### Riesgo, holds, contingencias

| Req | | Estado |
|---|---|---|
| — | Riesgo automático al llegar la prealerta | ✅ corre solo; `estado_documental` avanza |
| R18, D13 | Requerimiento al cliente con **plazo duro** (vuelo + descarga) | ✅ #23 — tabla + plazo + barrido de vencimiento en el tick; el reloj sólo corre contra quien sí fue avisado |
| CT-3/4/5/6 | Holds (CSA, riesgo, auditoría de autoridad global) y retención parcial de pallet | ✅ tablas + endpoints + materialización |
| CT-1/2/7 | Motor de contingencias (replaneación automática, reasignación anti-flete-en-falso) | ✅ #26 — `shared/operaciones/replan.ts` ruleset `2026-08a` con hash; ejecuta solo excluir/reprogramar/hold/suspender/notificar y **propone** la reasignación con override registrado. Integrado (684849f): CT-7 ya lee `despachos` reales y nombra el viaje concreto en vez del indicio `estado_planeacion = 'asignada'`; `NOTIFICACION_REQUERIDA` se entrega de verdad tras el commit (SMTP/WhatsApp, con resultado por destinatario en `replan_acciones.payload`) en vez de sólo registrar la obligación |

### Visibilidad, reportes, financiero

| Req | | Estado |
|---|---|---|
| — | **Torre de Control** (tablero que se proyecta) | ✅ 3 ejes, semáforos, banderas, hold banner |
| — | **Prealertas** (caso, evidencia con hashes, bitácora) | ✅ |
| — | **Campo** (los siete botones, móvil) | ✅ |
| N1, N3 | Portal de autoridad + verificación de cadena de hash | ✅ (de PRD-01, ahora cubre logística) |
| — | Tracking completo **dentro de AGORA** (idea del ticket) | ✅ espejo como notas privadas |
| 5 (Excel) | Pre-planeación: mostrar en automático prealertas sin incidencia | ✅ backend #29 — `routes/planeacion.ts` (plan editable, `plan_publicaciones` con diffs, publicación con fan-out); 🟡 **falta montar `PlaneacionView` en el frontend** (la API existe, no hay pantalla) |
| 6 (Excel) | Reporte general por fecha/cliente, trazabilidad por MAWB | ✅ `GET /api/reportes/operativo` (#32/Fase C, `routes/reportesOperativos.ts`, una fila por guía, exporta xlsx) + `TrazabilidadView.tsx` (f2ea038, quién se llevó cada guía) además del timeline en Prealertas |
| 7 (Excel) | Dashboard (warehouse time, dispatch, transit, LT+LM) | ✅ backend — `GET /api/reportes/lead-times`, `shared/operaciones/leadTimes.ts` (`LEAD_TIME_RULESET_VERSION`, versionado y probado); 🟡 **no hay tiles en Torre de Control** — la aritmética existe, nadie la pinta todavía |
| R43–R48 | Trazabilidad financiera guía↔pieza↔factura, proforma, reporte mensual | ✅ #32 (e40d646) — `client_tarifas`, `facturas`, `factura_partidas`, `routes/facturacion.ts`, reporte mensual por cliente; el vínculo vive en el sistema, no en el CFDI (D17); 🟡 **falta `FacturacionView`** en el frontend |
| 8 (Excel) | Contratos de clientes/proveedores importables | ✅ código — `routes/convenios.ts` + `services/cincel.ts` (firma NOM-151 vía Cincel, migración `convenios`), upload+hash sin depender de Cincel; ⛔ firma real inactiva hasta que el usuario provea `CINCEL_API_KEY`/`CINCEL_WEBHOOK_SECRET`. La unificación con `transportista_convenios` (#29) está **diseñada, deliberadamente no construida** — ver la nota completa en `server/src/services/cincel.ts` (razón: vocabularios de estado distintos, `despachos.ts` ya lee `firmado`; medio-construirla dejaría convenios marcados "firmado" sin corresponsalía real) |

### Prueba y operación

| | | Estado |
|---|---|---|
| #38 | Runner E2E de capacidades completas | ✅ **27/27 en producción** (`npm --prefix server run demo:e2e`) |
| #27 | Barrido de reconciliación de webhooks perdidos | ✅ |
| #39 | **Volumen persistente para `/app/storage`** | ✅ código (b5932d4) — `routes/files.ts` responde **410 con el hash** en vez de 500 sobre un blob perdido; `npm --prefix server run recover:evidence` re-descarga adjuntos desde AGORA y sólo escribe lo que coincide con el `content_hash` guardado (dry-run por default, `--apply` para escribir, exit 0 = todo explicado/nada falló, exit 1 = hay algo para ojos humanos). ⛔ **queda la mitad de infraestructura**: el usuario debe montar el volumen en Coolify (customs-v2 → Storages → `/app/storage` → redeploy) y luego correr `recover:evidence` contra producción para restaurar lo que aún se pueda |
| #34 | Tarea programada de Coolify para el tick | ⛔ sin ella nada sondea solo (acción de usuario, 2 min) |
| #37 | Rotación de secretos expuestos en el build | ⛔ operativo, post-demo (usuario) |
| #36 | 34 fallas de test preexistentes | ✅ **cerrado** (f6c7fcf) — ambas suites en cero fallas; ver §7 para los conteos exactos verificados el 10-ago |

---

## 4. Roadmap

### Hecho — TODO el backlog de código está cerrado (commits `78da50f..684849f`, 10-ago)

Ingesta de prealerta · parser del formato real · ingesta de manifiesto → riesgo automático · cotejo
PA-01/02/03/04/05/07/08/10 · seguimiento de vuelo AeroAPI · resolución de cliente · app de campo
(7 eventos + semáforo + foto) · holds y retenciones · espejo a AGORA · barrido de reconciliación ·
Torre de Control · Prealertas · Campo · reparse · runner E2E · **#36 ambas suites en cero fallas** ·
**#39 código** (410 con hash + `recover:evidence`) · **#22 mailer** + **#23 requerimiento con plazo
duro** · **#26 motor de contingencias** · **#31 fan-out WhatsApp** · **#29 despacho y catálogos de
transporte** · **#30 POD firmado** + **#32 trazabilidad financiera** + reportes operativos/lead-times
(Fase C) · **NOM-151/Cincel** para convenios de cliente · **TrazabilidadView** · pase de integración
final (replan↔despachos reales, fan-out de `NOTIFICACION_REQUERIDA` en vivo, vocabulario compartido
de guía-despachable, orden de fases del tick probado, 410 honesto en el frontend, demo-reset limpia
las 25 tablas de ops).

Lo único que sigue abierto es lo que ninguna sesión puede cerrar sola: infraestructura de Coolify,
credenciales de terceros, rotación de secretos, una unificación de diseño deliberadamente diferida, y
un lote de vistas de frontend sobre APIs que ya funcionan. En detalle:

### A — Bloqueado en infraestructura/usuario (el código ya está)

1. **#39b Volumen persistente `/app/storage`** — el script de recuperación y el 410 honesto están
   hechos (`b5932d4`); falta que el usuario monte el volumen en Coolify (customs-v2 → Storages →
   `/app/storage` → redeploy) y que una sesión corra `npm --prefix server run recover:evidence`
   (dry-run primero, luego `-- --apply`) contra producción para restaurar lo recuperable.
2. **#34 Tarea programada** del tick — sigue siendo 100% acción de usuario (Coolify Scheduled Tasks);
   nada en el código puede sustituirla, por diseño (no hay scheduler en proceso).
3. **#37 Rotación de secretos** — operativo, post-demo; ninguna sesión de código lo resuelve.

### B — Bloqueado en credenciales de terceros (integraciones ya construidas, "config-gated")

4. **#22 SMTP saliente** — `services/mailer.ts` completo, con reintento en el tick; degrada a
   `omitido` sin credenciales, nunca falla una ruta. Falta la app password de `ops@capitalc.com.mx`.
5. **#31 WhatsApp (evolution-api)** — `services/whatsapp.ts`/`whatsappFanout.ts` completos, segundo
   canal + roster interno de dirección. Falta `EVOLUTION_API_URL`/`EVOLUTION_API_KEY`/
   `EVOLUTION_INSTANCE`.
6. **NOM-151 (Cincel)** — `services/cincel.ts` + `routes/convenios.ts` completos, upload+hash
   funciona sin Cincel. Falta `CINCEL_API_KEY` y `CINCEL_WEBHOOK_SECRET` para que la firma real corra
   (el webhook falla cerrado — 503 — sin el secret, misma postura que AGORA).
7. **#35 Aireon** (ADS-B trans-Pacífico) — correo a FlightAware pidiendo el alta; posición oceánica
   sigue oscura mientras tanto, itinerario/arribos ya funcionan por otras vías.

### C — Diseñado, deliberadamente no construido

8. **Unificación `convenios` ↔ `transportista_convenios`** — la nota completa vive en
   `server/src/services/cincel.ts` (líneas ~30–91): vocabularios de estado distintos
   (`firmada` vs `firmado`), sin columnas de seguimiento de despacho en la tabla del transportista,
   sin llave de correlación única para el webhook, firmante de naturaleza distinta. Medio-construirla
   dejaría convenios marcados "firmado" por el solo hecho de haberse solicitado — exactamente la
   disciplina que este módulo existe para impedir.

### D — Backend listo, falta la vista de frontend

9. **`PlaneacionView`** — `routes/planeacion.ts` (plan editable, `plan_publicaciones` con diffs) no
   tiene pantalla montada en `src/App.tsx`/`src/nav.ts`.
10. **`DespachosView`** — igual, sobre `routes/despachos.ts`.
11. **`EntregasView`** — POD y confirmación de entrega (`routes/pods.ts`) sin vista propia.
12. **`FacturacionView`** — `routes/facturacion.ts` (client_tarifas, facturas, reporte mensual) sin
    vista propia.
13. **Tiles de lead-time en Torre de Control** — `GET /api/reportes/lead-times` y
    `shared/operaciones/leadTimes.ts` calculan warehouse/dispatch/transit/LT+LM; nada los pinta en
    `TorreControlView.tsx` todavía.

### E — Estructuralmente bloqueado o deliberadamente ausente (no es backlog, es un hecho del modelo)

14. **PA-09** (CSA) — no evaluable: requiere la patente consignataria, que ningún artefacto que
    recibimos hoy declara. El motor de contingencias y los holds YA reaccionan si algún día llega a
    dispararse (`replan.ts`, `holds.ts` lo referencian), pero la regla del cotejo nunca lo produce.
15. **#34/#35** — ver A.2 y B.7; no son ausencias de diseño, son acciones fuera del repo.

---

## 5. Bloqueadores del usuario (lo que sólo ustedes destraban)

| # | Acción | Impacto | Tiempo |
|---|---|---|---|
| **39** | Coolify → customs-v2 → Storages → volumen en `/app/storage` → redeploy; luego una sesión corre `npm --prefix server run recover:evidence -- --apply` | **La evidencia se borra en cada deploy sin esto** | 2 min + una sesión |
| 34 | Coolify → Scheduled Tasks → `*/5 * * * *` → `curl -sS -m 120 -X POST -H "x-ops-token: $OPS_TICK_TOKEN" http://localhost:4000/api/ops/tick` | Nada sondea solo | 2 min |
| 22 | App password de `ops@capitalc.com.mx` → SMTP Gmail en el inbox 21 (o `SMTP_ADDRESS` en AGORA) | Bloquea todo aviso al cliente (R18, R19) | 10 min |
| 31 | `EVOLUTION_API_URL`/`EVOLUTION_API_KEY`/`EVOLUTION_INSTANCE` en Coolify (evolution-api ya corre en el proyecto) | Bloquea el segundo canal (WhatsApp) y el aviso interno de dirección | 10 min |
| — | Cincel: cuenta + `CINCEL_API_KEY` + `CINCEL_WEBHOOK_SECRET` en Coolify | Bloquea la firma NOM-151 real de convenios (el upload+hash ya funciona sin ella) | según alta con Cincel |
| — | `RAILS_INBOUND_EMAIL_PASSWORD` en AGORA (Easypanel) | Abre el relay: camino de correo 100% real para el demo | 5 min |
| 35 | Email a FlightAware pidiendo Aireon (trans-Pacífico, HKG-NLU) | Posición oceánica en vivo | correo |
| 37 | Rotar token AGORA, secret del webhook, OPS_TICK_TOKEN, passwords semilla, key AeroAPI | Higiene post-demo | 15 min |

---

## 6. Disciplinas no negociables (romperlas rompe la tesis del producto)

1. **Evidencia antes de procesar** (R-A): la ingesta archiva + escanea + hashea ANTES de crear/avanzar
   el caso. Si falla el archivado, 5xx y que el emisor reintente.
2. **Reglas deterministas y versionadas**: parser, cotejo y riesgo son reproducibles a demanda.
   **Ningún LLM decide un valor autoritativo.** La procedencia (`forma/etiqueta/tabla/inferido_*`)
   viaja con cada campo; un valor inferido nunca se presenta como declaración del cliente.
3. **La bitácora no tartamudea ni miente**: repetir un evento es noop, la etapa nunca regresa,
   `ocurrido_at ≠ registrado_at`, y `operacion_eventos` es append-only por trigger — lo que además
   hace **indeleble** cualquier caso ya registrado (probado por test; no "arreglar").
4. **Semáforo literal `green`/`red`** en todos lados (D16, lo ve el cliente).
5. **recordAudit() después del commit**, nunca dentro.
6. **No verificable ≠ verificado**: lo que no se puede comprobar se dice (PA-10, "no evaluable").

## 7. Convenciones de la casa (resumen; detalle en HANDOFF §5)

- Migraciones `node-pg-migrate`, slots +100000, uuid PK, `text`+CHECK (no enums), hijos CASCADE.
- Rutas: `requireAuth → requireRole → validate(zod) → try/catch(next)`; JSON camelCase por alias SQL.
- Frontend sin router: `Section` en `nav.ts`, montado en `App.tsx`; `apiGet/apiPost/apiUpload`.
- **Baselines de test: ambas suites en CERO fallas** (cerrado #36, `f6c7fcf`). Medido de nuevo el
  10-ago: root **75 archivos / 791 pruebas**, server **82 archivos / 1047 pruebas**, las dos corridas
  limpias. (Una corrida aislada mostró un timeout de 5s en un test de `replan.test.ts` bajo carga
  concurrente completa; se confirmó no reproducible — pasa solo y pasa en una segunda corrida
  completa — así que no es una falla real, es contención de la máquina local.) El baseline viejo de
  "31 fallas/5 archivos root, 3/1 server" ya no aplica: no perseguir cero de nuevo si algo lo rompe,
  perseguirlo — cero es ahora el piso.
- Push a `fercamachol/customs`: `gh auth switch --user fercamachol` antes, revertir después.

## 8. Demo (guión de 12 min — detalle completo abajo)

1. **Prealertas** `16005930216` — el correo real se volvió caso solo; adjuntos con SHA-256;
   banderas en español.
2. **Torre de Control** — vuelo verificado contra FlightAware; avanzó a `arribado` solo.
3. **Campo** `16039293994` — los 7 botones; modulación **red** con captura diferida; foto hasheada;
   tiempo en rojo.
4. **Autoridad** — verificación de cadena de hash en verde; *"un caso con historia no se puede borrar
   ni con acceso a la base — lo probamos."*
5. **AGORA conversación 14** — el tracking espejado donde trabaja el equipo.

Plan B si algo no carga: `npm --prefix server run demo:e2e` corre las pruebas en vivo contra
producción (scorecard de PRD-02 núcleo: prealerta/vuelo/campo/cotejo/holds/espejo — **no incluye
todavía** #29/#30/#32/NOM-151 como pasos puntuados; `docs/DEMO_E2E.md` sigue describiendo el alcance
original, es la brecha de documentación más honesta que queda).
**No demostrar:** envío de correo al cliente (falta SMTP), WhatsApp (falta evolution-api), firma
NOM-151 real (falta Cincel), ni "sondea solo" (falta la tarea de Coolify).
**Descarga de evidencia**: el código ya responde 410 honesto en vez de 500 sobre un blob perdido, y
`recover:evidence` puede restaurar lo verificable — pero **sin el volumen montado (#39) cada
redeploy vuelve a perder los bytes nuevos**, así que la garantía real de "se puede bajar" sigue
pendiente de la acción de infraestructura.

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Evidencia efímera (#39)** | Código ya hecho: 410 honesto + `recover:evidence` verificable por hash. Falta el volumen persistente (usuario) — sin él el script sólo cura lo ya perdido, no evita perder lo próximo |
| SMTP ausente bloquea R18 con consecuencia legal (detener carga a quien nunca fue avisado) | No arrancar el reloj sin confirmación de envío; escalar a WhatsApp; categoría visible en Torre |
| AGORA en el camino crítico | Barrido de reconciliación recupera; degrada a carga manual del manifiesto |
| Cobertura ADS-B trans-Pacífico | Aireon (#35); mientras, itinerario/arribos ya funcionan, sólo la posición oceánica queda oscura |
| Formato de prealerta distinto por cliente | Vocabulario por cliente vía `client_header_mappings`; el parser es tolerante y reporta huecos |
| Secretos expuestos en el build | Rotación #37 post-demo |

## 10. Preguntas abiertas para Luis / Alfonso

- **Q1/Q4** confirmado en parte con los correos reales; falta el diccionario de datos formal.
- **Discrepancia real** en `160-05930216`: declara 64/2914/542.86, el manifiesto suma 134/7732/2711.78
  — ¿granularidad del xlsx o declaración corta? (El sistema la marcó correctamente.)
- **`CX3186`** no existe en FlightAware — ¿referencia interna o typo?
- ¿A veces llegan los documentos en un correo **posterior** con la misma guía? (cambia la ingesta)
- Q6 plantilla de POD (código usa un layout provisional, dicho en voz alta — `routes/pods.ts`) ·
  Q7 contrato+tarifas transportista, Q8 direcciones de entrega, Q9 precio por pieza por cliente — el
  **mecanismo ya existe** (`transportista_convenios`/tarifas, `client_direcciones`, `client_tarifas`
  de #29/#32) y sólo falta que Alfonso/Luis carguen los datos reales · Q12 cuál interfaz de autoridad
  primero.

---

*Fin. Para continuar desde cualquier sesión (local o claude.ai/code web): abrir el repo y decir
"lee docs/HANDOFF.md y continúa el backlog". No queda backlog de código sin depender de una acción
externa (§4) — el primer ítem para una sesión nueva es correr `recover:evidence` contra producción
en cuanto el usuario confirme el volumen montado (#39), y montar las vistas de frontend de la
sección D si se decide que valen la pena antes de tener credenciales reales que mostrar en ellas.*
