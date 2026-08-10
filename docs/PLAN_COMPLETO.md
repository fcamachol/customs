# Plan Completo — Sistema de Operaciones T1

**Un solo documento con todo el plan:** qué se prometió, qué está construido y desplegado, qué
falta, en qué orden, quién lo bloquea, y cómo se demuestra.

**Estado:** 2026-08-10 · producción `customs-v2` en `main` · repo `fercamachol/customs`
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
| R36, D14 | Arribo estimado (tráfico) vs arribo real | 📋 estimado por calcular; real capturable |
| R21–R29 | Catálogo transportistas/unidades/CAAT/placas, pedimento asignado, tipo-unidad-antes-de-línea (D7) | 📋 #29 |

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
| CT-1/2/7 | Motor de contingencias (replaneación automática, reasignación anti-flete-en-falso) | ✅ #26 — `shared/operaciones/replan.ts` ruleset `2026-08a` con hash; ejecuta solo excluir/reprogramar/hold/suspender/notificar y **propone** la reasignación con override registrado |

### Visibilidad, reportes, financiero

| Req | | Estado |
|---|---|---|
| — | **Torre de Control** (tablero que se proyecta) | ✅ 3 ejes, semáforos, banderas, hold banner |
| — | **Prealertas** (caso, evidencia con hashes, bitácora) | ✅ |
| — | **Campo** (los siete botones, móvil) | ✅ |
| N1, N3 | Portal de autoridad + verificación de cadena de hash | ✅ (de PRD-01, ahora cubre logística) |
| — | Tracking completo **dentro de AGORA** (idea del ticket) | ✅ espejo como notas privadas |
| 5 (Excel) | Pre-planeación: mostrar en automático prealertas sin incidencia | 🟡 la detección de incidencias ya vive; la planeación editable/enviable es #29 |
| 6 (Excel) | Reporte general por fecha/cliente, trazabilidad por MAWB | 🟡 trazabilidad por MAWB = timeline; el export operativo combinado es #32 |
| 7 (Excel) | Dashboard (warehouse time, dispatch, transit, LT+LM) | 🟡 KPIs vivos en Torre; las fórmulas de lead time son una vista sobre timestamps ya capturados |
| R43–R48 | Trazabilidad financiera guía↔pieza↔factura, proforma, reporte mensual | 📋 #32 |
| 8 (Excel) | Contratos de clientes/proveedores importables | 📋 diseñado con firma NOM-151 (Cincel); fase 2 |

### Prueba y operación

| | | Estado |
|---|---|---|
| #38 | Runner E2E de capacidades completas | ✅ **27/27 en producción** (`npm --prefix server run demo:e2e`) |
| #27 | Barrido de reconciliación de webhooks perdidos | ✅ |
| #39 | **Volumen persistente para `/app/storage`** | ⛔ **CRÍTICO** — sin él cada deploy borra los bytes de evidencia |
| #34 | Tarea programada de Coolify para el tick | ⛔ sin ella nada sondea solo |
| #37 | Rotación de secretos expuestos en el build | ⛔ post-demo |
| #36 | 34 fallas de test preexistentes | 📋 |

---

## 4. Roadmap

### Hecho (14 entregables, desplegados y verificados el 6–10 ago)

Ingesta de prealerta · parser del formato real · ingesta de manifiesto → riesgo automático · cotejo
PA-01/02/03/04/05/07/08/10 · seguimiento de vuelo AeroAPI · resolución de cliente · app de campo
(7 eventos + semáforo + foto) · holds y retenciones · espejo a AGORA · barrido de reconciliación ·
Torre de Control · Prealertas · Campo · reparse · runner E2E.

### Fase A — Estabilización (destraba todo lo demás; empezar aquí)

1. **#39 Volumen persistente `/app/storage`** — CRÍTICO. Usuario monta el volumen; luego un
   script re-descarga de AGORA los adjuntos perdidos verificando cada byte contra el hash guardado,
   y `routes/files.ts` responde 410 honesto en vez de 500. Protege toda la evidencia.
2. **#34 Tarea programada** del tick (usuario, 2 min). Sin esto "automático" no es autónomo.
3. **#22 SMTP saliente** — código hecho (`services/mailer.ts`, reintento en el tick); falta la **app
   password** (usuario). Sin ella el aviso no sale y #31 sigue esperando.

### Fase B — Cerrar el ciclo operativo

4. ~~**#26 Motor de contingencias**~~ ✅ **hecho**. `shared/operaciones/replan.ts` (puro, ruleset
   `2026-08a` con hash sha256), tablas `replan_evaluaciones`/`replan_acciones` (snapshot guardado =
   decisión reproducible), rutas `POST/GET /api/operaciones/:id/replan`,
   `…/acciones/:id/confirmar|descartar` (exigen `motivo`, escriben `override = true`),
   `POST /api/operaciones/:id/guias/:guiaId/no-transmitida` (disparador de CT-2) y **fase 4 del
   tick**. Ejecuta solo excluir/reprogramar/abrir hold/suspender unidades/notificar; la reasignación
   que toca tarifa se **propone**. Una decisión se registra una sola vez por huella: la bitácora no
   tartamudea. Pendiente de #29: cuando exista `despachos`, CT-7 apuntará al viaje concreto en vez
   de al indicio `estado_planeacion = 'asignada'`; y de #22/#31 para que `NOTIFICACION_REQUERIDA`
   deje de ser sólo la obligación registrada.
5. ~~**#23 Requerimiento de riesgo con plazo duro**~~ ✅ **hecho**. Tabla `riesgo_requerimientos`,
   plazo = ETA + ventana de descarga, `services/requerimientosService.ts`, `routes/riesgoRequerimientos.ts`
   y el barrido de vencimiento como **fase 3 del tick**, que dispara CT-4 (hold de tipo `riesgo`).
   La regla que lo sostiene: el plazo **no corre contra quien nunca fue avisado** — `expirarVencidos`
   sólo toca filas con `notificado_at`, así que un SMTP sin credenciales deja el requerimiento
   visiblemente sin notificar en vez de congelar la carga de un cliente que no fue advertido.
   El código de #22 (`services/mailer.ts`) viaja con él; falta sólo la app password del usuario.
6. **#31 Fan-out de notificaciones** en cambios de plan — AGORA + WhatsApp (evolution-api ya corre).
   (Necesita #22.)

### Fase C — Despacho, entrega, financiero

7. **#29 Planeación + despacho + catálogos de transporte** — el más grande: despachos,
   despacho_partidas, plan_publicaciones con diffs, transportistas/unidades/convenios/tarifas,
   tipo-unidad-antes-de-línea (D7), orden de carga.
8. **#30 Generación de POD** — sobre #29; plantilla pendiente de Luis (Q6).
9. **#32 Trazabilidad financiera** — client_tarifas, facturas, factura_partidas, reporte mensual por
   cliente; el vínculo vive en el sistema, no en el CFDI (D17).

### Fase D — Endurecimiento

10. **#36** arreglar las 34 fallas de test preexistentes (cubren login/registro — enmascaran
    regresiones reales en los flujos que se demuestran).
11. **#37** rotar todos los secretos expuestos en la transcripción del build.
12. **#35** habilitar Aireon (ADS-B espacial) para posición trans-Pacífica.
13. Interfaces AGORA/ANAM/VUCEM/SAT timbrado T1 (fase 4, tras autorización — Q12).

---

## 5. Bloqueadores del usuario (lo que sólo ustedes destraban)

| # | Acción | Impacto | Tiempo |
|---|---|---|---|
| **39** | Coolify → customs-v2 → Storages → volumen en `/app/storage` → redeploy | **La evidencia se borra en cada deploy sin esto** | 2 min |
| 34 | Coolify → Scheduled Tasks → `*/5 * * * *` → `curl -sS -m 120 -X POST -H "x-ops-token: $OPS_TICK_TOKEN" http://localhost:4000/api/ops/tick` | Nada sondea solo | 2 min |
| 22 | App password de `ops@capitalc.com.mx` → SMTP Gmail en el inbox 21 (o `SMTP_ADDRESS` en AGORA) | Bloquea todo aviso al cliente (R18, R19) | 10 min |
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
- **Baselines de test (no perseguir, no exceder): root 31 fallas/5 archivos, server 3/1
  (dashboardData).**
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

Plan B si algo no carga: `npm --prefix server run demo:e2e` corre las 27 pruebas en vivo.
**No demostrar:** envío de correo al cliente (falta SMTP) ni "sondea solo" (falta la tarea).
**Sólo descargar evidencia del caso `16039293994`** hasta que se monte el volumen (#39).

## 9. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Evidencia efímera (#39)** | Volumen persistente + recuperación verificable desde AGORA por hash |
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
- Q6 plantilla de POD · Q7 contrato+tarifas transportista · Q8 direcciones de entrega · Q9 precio por
  pieza por cliente · Q12 cuál interfaz de autoridad primero.

---

*Fin. Para continuar desde cualquier sesión (local o claude.ai/code web): abrir el repo y decir
"lee docs/HANDOFF.md y continúa el backlog". El primer ítem es #39.*
