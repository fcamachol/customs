# T1 Risk-Analysis Platform — Design Spec

**Date:** 2026-06-16
**Status:** Approved (design) — pending spec review
**Author:** Fernando Camacho Lombardo (with Claude)

## 1. Purpose & Direction

Reshape the existing client-side "T1 Pedimento" app into a **risk-analysis-first
platform** ("Capital Centennials"–style) for a Mexican courier/mensajería company
processing consolidated T1 imports. The **risk triage (Verde/Amarillo/Rojo) is the
core product**; the existing RGCE compliance/tax/pedimento engine becomes a
downstream module.

The product must achieve **full government compliance**: a complete, transmissible
pedimento, real prevalidation, immutable audit trail, RFC/CURP validation, and an
`autoridad` (authority) access role.

This design covers **full coverage of all four reference documents**:
- `Analisis de Riesgo.pdf` — the UI/workflow spec (6 sections, traffic-light model).
- `Risk analysis 17 feb '25.xlsx` — the real 8-signal risk-scoring engine.
- `LayOut_sistema.xlsx` — the mandated 34-column flat data layout.
- `Pedimento.pdf` — a real 240-page T1 pedimento (field fidelity benchmark).

## 2. Architecture

- **Frontend:** keep current React 19 + Vite + TypeScript SPA.
- **Backend:** our own **Express + TypeScript REST API** (same repo, self-hosted).
- **Database:** **PostgreSQL** (self-hosted).
- **File storage:** our own disk/volume — manifests, ingested pedimento PDFs
  (40–80 MB), generated Excel reports.
- **No third-party BaaS.** All infrastructure owned and self-hosted for data
  sovereignty / government compliance.
- Repo becomes a monorepo: `client/` (current `src/`), `server/` (new API),
  `shared/` (types reused by both, evolved from current `src/types/t1.ts`).

### Government-compliance pillars (cross-cutting)
1. **Audit trail** — every consequential action (login, import, risk run, edit,
   pedimento generation, export) logged with `userId`, timestamp, action,
   before/after snapshot. Append-only; queryable by `autoridad`.
2. **Full pedimento fidelity** — generated pedimento + SAAI M3 layout carry all
   legally required fields so the output is transmissible and prevalidatable.
3. **Data integrity & retention** — RFC/CURP validation, FK integrity, configurable
   retention. Import never silently drops columns.
4. **Auth & roles** — real login; `capturista` / `admin` / `autoridad` gate features
   and data visibility.

## 3. Sub-Systems (build order)

### 3.1 Backend foundation *(blocks everything)*
- Express API scaffold, PostgreSQL schema + migrations.
- Auth: login (Usuario/Contraseña), hashed credentials, sessions/JWT, role
  middleware (`capturista`/`admin`/`autoridad`).
- Audit-log service (append-only table + middleware).
- File-storage service (local volume, content-addressed, size limits for 80 MB PDFs).
- Replace the current client-only `T1Context` state with API-backed persistence;
  keep a thin client store for UI state.

### 3.2 Data model & ingestion
Expand the data model to the full `LayOut_sistema` 34-column schema:
- **Core (1–16):** No. registro T1, patente, no. pedimento, descripción, fracción,
  cantidad, unidad, valor aduana, moneda, país procedencia, **fecha de arribo**,
  guía, tasa, RRNA, **aduana entrada** + **aduana despacho** (split — currently one
  field `aduanaSeccion`).
- **Consignatario (17–25):** nombre, RFC, **CURP**, **ID fiscal extranjero**,
  **NSS**, **pasaporte**, domicilio, teléfono, correo. (Today: only name + RFC +
  unused optional address.)
- **Remitente / sender (26–30):** nombre, id fiscal, domicilio, teléfono, correo.
  *(Entirely new.)*
- **Plataforma / platform (31–34):** nombre comercial, país origen, razón social,
  correo. *(Entirely new.)*

Ingestion:
- Harden `fileParser` ("any Excel"): add header synonyms for sender/platform/CURP/
  passport/arrival-date; handle multi-line address cells, country-prefixed phones,
  lowercase country codes (`cn`). Nothing silently dropped.
- Large pedimento-PDF ingestion (40–80 MB) attached to a record (Seguimiento Paso 3).
  PDF parsing handled server-side.

### 3.3 Risk-triage engine *(the new core)*
Per-package 8 binary signals → sum 0–8 → classification:
**`<2 = Verde`, `2–3 = Amarillo`, `≥4 = Rojo`** (matching the spreadsheet).

| # | Signal | Logic | Incidence text |
|---|--------|-------|----------------|
| 1 | Valida ID | ID length 13 (RFC) or 18 (CURP), else flag | "Falta RFC/CURP" |
| 2 | Cantidad | quantity > 10 | "Demasiados productos" |
| 3 | Monto | value < $1 **or** > $2,500 | "Valor declarado incorrecto" |
| 4 | Consignatarios | consignee name appears > 1× | "Varios paquetes por consignatario" |
| 5 | Direcciones | address appears > 1× | "Misma dirección de entrega" |
| 6 | Artículos Prohibidos | RRNA keyword match | "Artículos prohibidos" |
| 7 | Piratería | brand-list match (Adidas, Nike, Bimba y Lola, Gucci, Samsung, Apple, Louis Vuitton, Dolce & Gabbana, Ray Ban, …) | "Piratería" |
| 8 | Valida BBDD | consignee found in monthly-history store | "Varias importaciones en el mes" |

- New signals to build: **#5 duplicate-address, #7 piracy brands, #8 repeat-importer
  (needs monthly-history store), #2 >10-qty.**
- Reconcile thresholds: **CURP length 13/18** (currently RFC-regex only — rejects valid
  CURPs); low value **`<$1`** (currently `<=0`).
- Reuse existing RRNA detector for #6; extend keywords (globo, pegamento, autoparte,
  droga, mariguana).
- Output per package: score, color, list of incidence strings.
- Summary buckets: Datos analizados / Aprobados / No identificados / Validar en previo.

### 3.4 Compliance + pedimento module *(downstream, full fidelity)*
Keep the existing RGCE rules + tax engine; close all `Pedimento.pdf` gaps so output
is government-transmissible:
- **Header:** importador fiscal block (RFC/nombre/CURP/domicilio), tipo de cambio on
  pedimento, peso bruto + total bultos aggregate, valor dólares / valor aduana /
  precio pagado, incrementables/decrementables, medios de transporte triad
  (entrada/arribo/salida), línea de captura + payment block, **COVE / acuse de valor**,
  proveedor/comprador (vinculación, incoterm, guía master), identificadores SO/CR/EM/ED,
  **pedimento-level observaciones** (mandatory RGCE/NOM legal text), full agente-aduanal
  identity (RFC agente/agencia, CURP, certificado serial, e.firma), dual fechas
  (entrada/pago).
- **Partida:** país V/C and O/D, UMC/UMT dual units, valor aduana/precio pagado/unit/
  agregado, marca/modelo/código producto, identificación comercial/VINC/MET VAL,
  NOM citations, identificadores (EP/EN/XP), and **fix the observation-format bug**:
  emit `GUIA <num> VALOR <usd> USD NOMBRE <name> RFC-CURP <rfc>` (currently
  `EM1|name|RFC:rfc` — omits guía + value).
- Prevalidador updated for the expanded fields; accept RFC **and** CURP.

### 3.5 Workflow shell & reports
The six PDF sections, with records keyed by **`MAWB – Cliente`**:
- **Login** + **Realizar Registro** (import → risk triage → traffic-light table + summary).
- **Seguimiento** — search by `MAWB – Cliente`; capture import data (tasa, fecha de
  entrada, T1/clave, agente, patente, aduana entrada/despacho, pedimento); attach
  pedimento PDF.
- **Reporte General** — client/platform catalog; "Generar Reporte" → Excel merge of
  manifest + pedimento + client data.
- **Consulta** — retrieve the 3 stored artifacts per record (Análisis XLS, Pedimento
  PDF, Reporte XLS).
- **Dashboard** — per-user performance charts + risk reports.
- **Acerca de** — static company info.

## 4. Data Flow

```
Login
  → Realizar Registro: import manifest (any Excel)
      → parse into full 34-col model
      → run risk triage  → Verde/Amarillo/Rojo table + summary buckets
  → Seguimiento: lookup by MAWB–Cliente, capture import data, attach pedimento PDF
  → Compliance + pedimento generation (full fidelity) → prevalidador
  → Reporte General: merge manifest + pedimento + client catalog → Excel
  → Consulta: retrieve 3 artifacts per record
  → Dashboard: per-user performance
Every step → audit log + persistence.
```

## 5. Testing Strategy
- **Risk engine:** unit tests per signal + classification boundaries (1/2/3/4 → color),
  validated against the real spreadsheet's expected distribution (Amarillo ~92%,
  Rojo ~5%, Verde ~2%) on sample data.
- **Ingestion:** fixture-based tests for the 34-column layout, multi-line addresses,
  lowercase country codes, sender/platform columns.
- **Pedimento fidelity:** golden-file test comparing generated SAAI M3 + field set
  against the `Pedimento.pdf` field inventory; explicit test for the observation format.
- **Prevalidador:** RFC and CURP acceptance.
- **API/auth:** role-gating and audit-log-write tests per endpoint.

## 6. Out of Scope (this milestone)
- Live SAT/ANAM network transmission (we produce transmissible artifacts; actual
  wire submission is a later integration).
- Real e.firma cryptographic signing (model the fields/serials; signing integration later).
- Mobile/responsive polish beyond functional.

## 7. Key References (current code)
`src/types/t1.ts`, `src/context/T1Context.tsx`, `src/engine/t1Compliance.ts`,
`src/engine/rrnaDetector.ts`, `src/engine/prevalidador.ts`, `src/engine/taxCalculator.ts`,
`src/constants/{rgceRules,rrnaCategories,genericHscodes}.ts`,
`src/utils/fileParser.ts`, `src/components/*`.
Source documents in `~/Downloads/`.
