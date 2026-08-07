# El caso de prueba de capacidades completas (`server/scripts/demoE2e.ts`)

Un script ejecutable y auto-verificable que crea un caso realista, lo camina por todas las
capacidades del Sistema de Operaciones aseverando cada paso, e imprime un **scorecard** numerado.
Sale con código `0` sólo si todas las aserciones **requeridas** pasaron.

No es una prueba unitaria: corre contra un despliegue real, por HTTP, con las mismas credenciales y
los mismos roles que usa una persona. Lo que demuestra es que las capacidades existen **en
producción**, no que las funciones compilan.

---

## Cómo se corre

```bash
DEMO_HOST=https://…                     \
DEMO_USER=capturista DEMO_PASS=…        \
AGORA_BASE_URL=https://agoracore.…      \
AGORA_ACCOUNT_ID=9                      \
AGORA_API_ACCESS_TOKEN=…                \
AGORA_PREALERTAS_INBOX_ID=21            \
OPS_TICK_TOKEN=…                        \
AGORA_WEBHOOK_SIGNING_SECRET=…          \
npx tsx server/scripts/demoE2e.ts
```

o, desde `server/`, `npm run demo:e2e`.

Toda la configuración va por entorno; **el archivo no contiene ningún secreto**. `DEMO_HOST` trae
como default la URL de producción en Coolify; el resto no tiene default cuando es un secreto.

Dos variables opcionales que valen la pena conocer:

| variable | para qué |
|---|---|
| `DEMO_POLL_TIMEOUT_MS` | cuánto esperar a que el caso aterrice (default `90000`) |
| `DEMO_OPERACION_ID` | *escape hatch*: reanuda los pasos 3–8 sobre un caso **que ya existe**, sin tocar AGORA. Útil cuando lo que hay que volver a probar es el recorrido de campo. Con él, las aserciones de contenido del ingest se reportan como informativas: describen ese caso, no lo que el script habría enviado. |

`tsc` no cubre `server/scripts` (el `include` de `server/tsconfig.json` es `src`, `migrations`,
`test`), así que el script se verifica aparte:

```bash
npx tsc --noEmit --target ES2022 --module ESNext --moduleResolution Bundler \
        --strict --esModuleInterop --skipLibCheck --types node \
        server/scripts/demoE2e.ts
```

---

## Qué prueba, línea por línea

Cada línea del scorecard nombra el requisito del PRD que demuestra.

| # | capacidad | requisito |
|---|---|---|
| 1 | Prealerta creada **en AGORA**: contacto → conversación → mensaje con dos adjuntos alojados en AGORA (`data_url` verificados) | R1 |
| 2 | El caso aterriza en customs y se puede leer por `GET /api/operaciones` | R1, N1 |
| 3 | La guía máster se reconoce **por forma** (no por etiqueta) y se usa como clave del caso | R2 |
| 4 | Cartones / piezas / peso extraídos **con su procedencia** (`64 CTNS / 2914 PCS / 542.86 KGS`) | R2 |
| 5 | Los **dos puntos de ancho completo** (`：`, U+FF1A) sobreviven: ETD y ETA quedan poblados y ordenados | R2 |
| 6 | Los dos adjuntos se **descargan de vuelta desde AGORA**, se hashean (sha256 de 64 hex) y se escanean: AWB `clean`, manifiesto `unscannable` | R3, Adenda A R-A |
| 7 | El manifiesto adjunto entra al pipeline de manifiestos (`manifestId` asignado) | R3 |
| 8 | **La bandera roja plantada se enciende**: PA-02 como `error`, porque el CSV declara 35 piezas contra las 2914 del correo | R5 / PA-02 |
| 9 | Lo **no evaluable se reporta**: PA-01 y PA-03 salen `informativa` (el manifiesto de la demo no trae `bulto` ni peso), que es distinto de "coincide" | R5 / PA-01, PA-03 |
| 10 | Un vuelo **no verificable se reporta, nunca se silencia**: PA-10 como `advertencia` | R5 / PA-10 |
| 11 | Remitente que no resuelve a un cliente: PA-08, y el caso **se crea igual** | R6 / PA-08 |
| 12 | El **riesgo corre solo** al llegar la prealerta (`estadoDocumental` en `riesgo_ok`/`riesgo_con_hallazgos`) | R4, R5 |
| 13 | El **barrido de reconciliación** responde (`POST /api/ops/tick`) | N2 |
| 14 | La bitácora append-only trae la cadena del ingest: `PREALERTA_RECIBIDA → COTEJO_EJECUTADO → RIESGO_EVALUADO` | N1 |
| 15 | `CARGA_DISPONIBLE`: el hecho que el almacén nunca avisa queda con hora | R11 |
| 16 | **Idempotencia en vivo**: repetir el mismo botón devuelve `200 {noop:true}` — la cola de reintentos no puede tartamudear la bitácora | N4 |
| 17 | `INGRESO_PATIO` es un hecho de bitácora puro: **no mueve `etapa`** | R30 |
| 18 | `INGRESO_ADUANA` con cita: la **demora contra la cita** se calcula y se guarda (`demoraMin ≈ 10`) | R30 |
| 19 | `INICIO_CARGA` es lo único que asevera que la carga se mueve | R31 |
| 20 | Evidencia fotográfica **hasheada** y ligada al evento, con el mismo hash en la bitácora | R32 / D5 |
| 21 | `FIN_CARGA`: otro hecho de bitácora puro | R31 |
| 22 | `MODULACION` capturada 5 minutos tarde: **`ocurrido_at ≠ registrado_at`** en el ledger — el celular está prohibido en el semáforo, así que la captura tardía es entrada CORRECTA | R33 |
| 23 | `SALIDA_ROJO`: el **tiempo en reconocimiento se mide** (`tiempoEnRojoMin ≥ 5`), no se estima | R35 |
| 24 | **Monotonía en vivo**: `INICIO_CARGA` desde `en_transito` es `409` con `etapaActual` — el avance físico no regresa | R34 |
| 25 | Estado final coherente: `etapa=en_transito`, `semaforo=red`, `disponible_at`/`modulacion_at`/`salida_rojo_at` sellados | R30–R35 |
| 26 | **Reparse**: un caso ya guardado se puede sanar con el parser vigente, sin re-clavarlo en otra guía | R2 |

---

## Los tres caminos de entrega — y un límite real de AGORA

El script escalona la entrega y **el scorecard dice cuál fue**, porque los tres son capacidades
distintas:

- **A · Webhook de AGORA.** La vía normal: AGORA emite `message_created`, lo firma con HMAC, customs
  lo verifica y baja los adjuntos con su propio token. Ventana: el primer 40 % del presupuesto.
- **B · Barrido de reconciliación.** `POST /api/ops/tick`. La red que atrapa un webhook perdido —
  porque el webhook es una notificación, no una garantía. Ventana: 40 %–70 %.
- **C · Webhook firmado por el script.** Ventana: 70 %–100 %. Requiere
  `AGORA_WEBHOOK_SIGNING_SECRET`; sin él se omite.

**Por qué existe el camino C** (verificado contra producción el 7-ago-2026, no supuesto):

```
POST /api/v1/accounts/9/conversations/8/messages  (multipart, message_type=incoming)
→ 422 {"error":"Incoming messages are only allowed in Api inboxes"}
```

La API de aplicación de Chatwoot/AGORA **no permite crear mensajes entrantes en un inbox de correo**
(`Channel::Email`). Y sin `message_type: 'incoming'` el mensaje no se procesa por ninguno de los dos
caminos reales, con razón: tanto `prealertaIngest` como `agoraSweep` filtran por entrante, porque un
saliente es nuestra propia respuesta volviendo por el mismo webhook y tratarla como prealerta crearía
operaciones fantasma.

Los únicos caminos que producen un entrante **de verdad** en el inbox vigilado son:

1. **Un correo real**, que AGORA levanta por IMAP (`ops@capitalc.com.mx`, proveedor Google). Es el
   camino de producción y funciona: los casos que ya viven en la base llegaron así. Pero mandar el
   correo desde el script necesita credenciales SMTP que no existen — el inbox tiene
   `smtp_address` vacío y `provider: google` (OAuth), y es la misma razón por la que R18/R19 están
   bloqueados.
2. **El relay de ActionMailbox** de AGORA (`POST /rails/action_mailbox/relay/inbound_emails`). La
   ruta existe pero responde `500`: el ingress está configurado como `:relay` y la contraseña
   (`RAILS_INBOUND_EMAIL_PASSWORD`) no está puesta en AGORA. Si se configura, el script podría mandar
   un RFC822 crudo y el camino sería **enteramente real**, incluida la dedupe por `Message-ID`. Es la
   mejora recomendada para esta demo.
3. **El webhook firmado** — el camino C.

El camino C **no es un atajo al ingest**: firma el mismo `message_created`, con los `data_url` reales
de los adjuntos que acaban de subirse a AGORA. Customs sigue verificando el HMAC y la frescura de la
firma, sigue aplicando la idempotencia por `X-Agora-Event-Id`, y sigue **bajando la evidencia desde
AGORA** con su propio `api_access_token`. Lo único que cambia es quién apretó enviar. Cuando AGORA
gane el relay de correo (o la demo se corra desde un buzón real), el camino A vuelve a ser el
protagonista y el script no necesita cambios: ya lo intenta primero.

---

## Qué NO cubre todavía

Deliberadamente fuera de alcance, para que el scorecard no dé una cobertura que no existe:

- **Notificaciones salientes al cliente (R18, R19)** — el requerimiento de riesgo con plazo duro y
  los avisos de cambio de plan. Bloqueados por SMTP: no hay transporte de correo configurado ni en
  customs ni en el inbox de AGORA.
- **Despacho, POD y firma electrónica** — la mitad de salida del ciclo.
- **Holds / retenciones** (`hold_activo`, retención parcial por guía casa).
- **PA-04, PA-05, PA-07, PA-09.** PA-04/PA-05 necesitan un vuelo real, y la demo usa a propósito un
  vuelo inexistente para ser reproducible a cualquier hora (por eso lo que se demuestra es PA-10).
  PA-07 necesita una segunda operación abierta con la misma guía casa. PA-09 no está implementada:
  requiere la patente consignataria, que ningún artefacto que recibimos hoy declara.
- **Modulación en verde.** El recorrido va por el rojo, que es el camino largo (incluye
  `SALIDA_ROJO` y el KPI de tiempo en reconocimiento).

## Limpieza

**El caso de la demo se queda en la base, a propósito**: es dato de demostración realista, con su
evidencia, su bitácora y su cadena de hashes intactas. Cada corrida genera una **guía máster nueva**
(`160-` + 8 dígitos del timestamp), así que no colisiona con la anterior ni la versiona.

Para borrarlo hay que ser honesto sobre el alcance de lo que existe: `POST /api/admin/demo-reset`
(sólo con `DEMO_MODE`) limpia manifiestos y archivos, **pero hoy no borra `operaciones`**. Los casos
de demo se acumulan hasta que alguien los quite a mano o hasta que el reset se amplíe. El script
tampoco borra nada en AGORA: el contacto `robot.demo@shein.example` se reutiliza entre corridas y
cada corrida deja una conversación nueva en el inbox de prealertas.
