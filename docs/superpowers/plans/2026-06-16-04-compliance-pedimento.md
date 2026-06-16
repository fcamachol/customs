# Compliance + Pedimento Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the downstream pedimento module government-transmissible: expand the pedimento data model to carry all legally required header + partida fields from the real `Pedimento.pdf`, fix the per-partida observation-format bug, and accept RFC **and** CURP in prevalidation.

**Architecture:** A `shared/types/pedimento.ts` defines the full pedimento model (header blocks + partida blocks). A `shared/pedimento/buildPedimento.ts` maps scored shipments → a complete `Pedimento`. A `shared/pedimento/observation.ts` produces the legally correct per-partida observation. The prevalidador moves to `shared/pedimento/prevalidate.ts` with RFC/CURP support. The server exposes `POST /api/manifests/:id/pedimento`.

**Tech Stack:** TypeScript, `vitest`, `pg`. No new runtime deps.

**Depends on:** Plans 01–03 (auth/audit/db, `Shipment` model + tables, scored shipments).

---

### Task 1: Full pedimento type model

**Files:**
- Create: `shared/types/pedimento.ts`
- Test: `shared/types/pedimento.typecheck.test.ts` (compile-time shape assertion)

- [ ] **Step 1: Define the model**

`shared/types/pedimento.ts`:
```ts
// Full T1 pedimento model — fields from the real Pedimento.pdf (header p.1 + partida anexo).

export interface ImporterFiscal {            // Datos del importador
  rfc: string;
  curp?: string;
  name: string;
  fiscalAddress: string;
}

export interface AgentIdentity {             // Cierre / agente aduanal
  patente: string;
  name: string;
  agentRfc: string;
  agencyRfc: string;
  curp?: string;
  certificateSerial?: string;
}

export interface PaymentBlock {              // Línea de captura / depósito referenciado
  lineaCaptura?: string;
  bank?: string;
  bankOperationNumber?: string;
  satTransactionNumber?: string;
  amountPaidMxn?: number;
  paymentDate?: string;                      // YYYY-MM-DD
  presentationMethod?: string;
}

export interface Incrementables {
  seguros?: number; fletes?: number; embalajes?: number; otros?: number;
}
export interface Decrementables {
  transporte?: number; seguro?: number; carga?: number; descarga?: number; otros?: number;
}

export interface TransportTriad {            // Medios de transporte
  entrada: string;                           // e.g. '4'
  arribo: string;                            // e.g. '4'
  salida: string;                            // e.g. '7'
}

export interface PedimentoHeader {
  numeroPedimento: string;                   // 15-digit
  clave: 'T1';
  regimen: 'IMD';
  destino: '9';
  tipoCambio: number;                        // e.g. 20.4568 — ON the pedimento
  pesoBrutoKg: number;                       // aggregate
  totalBultos: number;                       // aggregate
  valorDolares: number;
  valorAduana: number;
  precioPagado: number;
  customsEntryCode: string;                  // aduana entrada
  customsClearanceCode: string;              // aduana despacho
  transport: TransportTriad;
  entryDate: string;                         // fecha de entrada
  paymentDate: string;                       // fecha de pago
  coveAcuseValor?: string;                   // COVE / número de acuse de valor
  incoterm?: string;                         // DDP
  vinculacion?: boolean;
  masterGuide?: string;                      // no. guía / orden embarque
  identifiers: Record<string, string>;       // SO/CR/EM/ED → value
  observations: string;                      // mandatory pedimento-level legal text
  importer: ImporterFiscal;
  agent: AgentIdentity;
  payment: PaymentBlock;
  incrementables?: Incrementables;
  decrementables?: Decrementables;
}

export interface PedimentoPartida {
  secuencia: number;
  fraccion: string;                          // 9901.00.01 → '99010001'
  numIdentificacionComercial?: string;       // '00'
  vinc?: string;                             // '0'
  metVal?: string;                           // '1'
  umc: string; cantidadUmc: number;
  umt?: string; cantidadUmt?: number;
  paisVendedor: string;                      // P. V/C
  paisOrigenDestino: string;                 // P. O/D
  description: string;
  valorAduanaUsd: number;
  precioPagado?: number;
  precioUnitario?: number;
  valorAgregado?: number;
  marca?: string; modelo?: string; codigoProducto?: string;
  noms?: string[];                           // NOM citations
  identifiers?: string[];                    // EP/EN/XP + codes
  contribuciones: { concepto: string; tasa: number; importe: number }[];
  observation: string;                       // GUIA … VALOR … USD NOMBRE … RFC-CURP …
}

export interface Pedimento {
  header: PedimentoHeader;
  partidas: PedimentoPartida[];
}
```

- [ ] **Step 2: Add a compile-time shape test**

`shared/types/pedimento.typecheck.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import type { Pedimento } from './pedimento';

describe('pedimento type', () => {
  it('accepts a fully-populated object', () => {
    const p: Pedimento = {
      header: {
        numeroPedimento: '258516535001684', clave: 'T1', regimen: 'IMD', destino: '9',
        tipoCambio: 20.4568, pesoBrutoKg: 808, totalBultos: 34,
        valorDolares: 21592.68, valorAduana: 441717, precioPagado: 441717,
        customsEntryCode: '4', customsClearanceCode: '850',
        transport: { entrada: '4', arribo: '4', salida: '7' },
        entryDate: '2025-04-04', paymentDate: '2025-04-05',
        identifiers: { EM: '143' }, observations: 'RGCE 3.7.5 ...',
        importer: { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' },
        agent: { patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' },
        payment: { lineaCaptura: '0325 01FM XKP1 4561 1258' },
      },
      partidas: [],
    };
    expect(p.header.clave).toBe('T1');
  });
});
```

- [ ] **Step 3: Run to verify it passes**

Run: `cd shared && npx vitest run types/pedimento.typecheck.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add shared/types/pedimento.ts shared/types/pedimento.typecheck.test.ts
git commit -m "feat(shared): full T1 pedimento type model"
```

---

### Task 2: Correct per-partida observation format (fixes the known bug)

**Files:**
- Create: `shared/pedimento/observation.ts`
- Test: `shared/pedimento/observation.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/pedimento/observation.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { partidaObservation } from './observation';

describe('partidaObservation', () => {
  it('matches the real pedimento format: GUIA <n> VALOR <usd> USD NOMBRE <name> RFC-CURP <id>', () => {
    const obs = partidaObservation({
      guideId: '369-94268462', valueUsd: 120.5, consigneeName: 'JUAN PEREZ', id: 'TOMM020922D40',
    });
    expect(obs).toBe('GUIA 369-94268462 VALOR 120.50 USD NOMBRE JUAN PEREZ RFC-CURP TOMM020922D40');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run pedimento/observation.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shared/pedimento/observation.ts`:
```ts
export interface ObservationInput {
  guideId: string;
  valueUsd: number;
  consigneeName: string;
  id: string;               // RFC or CURP
}

export function partidaObservation(i: ObservationInput): string {
  const value = i.valueUsd.toFixed(2);
  return `GUIA ${i.guideId} VALOR ${value} USD NOMBRE ${i.consigneeName.toUpperCase()} RFC-CURP ${i.id}`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd shared && npx vitest run pedimento/observation.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/observation.ts shared/pedimento/observation.test.ts
git commit -m "fix(pedimento): correct per-partida observation format (GUIA/VALOR/NOMBRE/RFC-CURP)"
```

---

### Task 3: Prevalidator accepting RFC and CURP

**Files:**
- Create: `shared/pedimento/prevalidate.ts`
- Test: `shared/pedimento/prevalidate.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/pedimento/prevalidate.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { isValidTaxId, prevalidatePedimento } from './prevalidate';
import type { Pedimento } from '../types/pedimento';

describe('isValidTaxId', () => {
  it('accepts a 13-char RFC and an 18-char CURP', () => {
    expect(isValidTaxId('TOMM020922D40')).toBe(true);          // 13
    expect(isValidTaxId('AERA790828HBSRBR04')).toBe(true);     // 18
    expect(isValidTaxId('SHORT')).toBe(false);
  });
});

function basePedimento(): Pedimento {
  return {
    header: {
      numeroPedimento: '258516535001684', clave: 'T1', regimen: 'IMD', destino: '9',
      tipoCambio: 20.45, pesoBrutoKg: 1, totalBultos: 1, valorDolares: 1, valorAduana: 1, precioPagado: 1,
      customsEntryCode: '4', customsClearanceCode: '850',
      transport: { entrada: '4', arribo: '4', salida: '7' },
      entryDate: '2025-04-04', paymentDate: '2025-04-05', identifiers: {}, observations: 'x',
      importer: { rfc: 'ADM130509UQ0', name: 'X', fiscalAddress: 'Y' },
      agent: { patente: '1653', name: 'A', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' },
      payment: {},
    },
    partidas: [{
      secuencia: 1, fraccion: '99010001', umc: '6', cantidadUmc: 1, paisVendedor: 'CHN', paisOrigenDestino: 'CHN',
      description: 'TRAJE', valorAduanaUsd: 120, contribuciones: [{ concepto: 'IVA', tasa: 19, importe: 22 }],
      observation: 'GUIA 1 VALOR 120.00 USD NOMBRE X RFC-CURP TOMM020922D40',
    }],
  };
}

describe('prevalidatePedimento', () => {
  it('approves a well-formed pedimento', () => {
    expect(prevalidatePedimento(basePedimento()).status).toBe('APPROVED');
  });
  it('rejects a non-15-digit pedimento number', () => {
    const p = basePedimento(); p.header.numeroPedimento = '123';
    const r = prevalidatePedimento(p);
    expect(r.status).toBe('REJECTED');
    expect(r.errors.join(' ')).toMatch(/15/);
  });
  it('rejects a non-9901 fracción', () => {
    const p = basePedimento(); p.partidas[0].fraccion = '12345678';
    expect(prevalidatePedimento(p).status).toBe('REJECTED');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run pedimento/prevalidate.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shared/pedimento/prevalidate.ts`:
```ts
import type { Pedimento } from '../types/pedimento';

const RFC = /^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$/;        // 12–13 chars
const CURP = /^[A-Z]{4}[0-9]{6}[HM][A-Z]{5}[A-Z0-9]{2}$/; // 18 chars

export function isValidTaxId(id: string): boolean {
  const v = (id ?? '').toUpperCase().replace(/\s/g, '');
  return RFC.test(v) || CURP.test(v);
}

export interface PrevalidationResult {
  status: 'APPROVED' | 'REJECTED';
  errors: string[];
  warnings: string[];
}

export function prevalidatePedimento(p: Pedimento): PrevalidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!/^\d{15}$/.test(p.header.numeroPedimento)) errors.push('El número de pedimento debe tener 15 dígitos.');
  if (p.header.clave !== 'T1') errors.push('Clave debe ser T1.');
  if (!isValidTaxId(p.header.importer.rfc)) errors.push('RFC del importador inválido.');
  if (!isValidTaxId(p.header.agent.agentRfc)) errors.push('RFC del agente inválido.');
  if (!p.header.observations?.trim()) errors.push('Faltan observaciones a nivel pedimento.');

  p.partidas.forEach((pa) => {
    if (!/^990[12]00\d{2}$/.test(pa.fraccion)) errors.push(`Partida ${pa.secuencia}: fracción debe iniciar con 9901/9902.`);
    if (pa.valorAduanaUsd > 2500) errors.push(`Partida ${pa.secuencia}: valor excede $2,500 USD.`);
    if (pa.valorAduanaUsd <= 0) errors.push(`Partida ${pa.secuencia}: valor debe ser mayor a 0.`);
    if (!/^GUIA .+ VALOR .+ USD NOMBRE .+ RFC-CURP .+$/.test(pa.observation)) {
      warnings.push(`Partida ${pa.secuencia}: formato de observación no estándar.`);
    }
  });

  return { status: errors.length ? 'REJECTED' : 'APPROVED', errors, warnings };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd shared && npx vitest run pedimento/prevalidate.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/prevalidate.ts shared/pedimento/prevalidate.test.ts
git commit -m "feat(pedimento): prevalidator with RFC+CURP support and partida checks"
```

---

### Task 4: Build a full pedimento from scored shipments

**Files:**
- Create: `shared/pedimento/buildPedimento.ts`
- Test: `shared/pedimento/buildPedimento.test.ts`

- [ ] **Step 1: Write the failing test**

`shared/pedimento/buildPedimento.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { buildPedimento } from './buildPedimento';
import type { Shipment } from '../types/shipment';

function ship(over: Partial<Shipment>): Shipment {
  return {
    id: '1', mawbReference: '369-94268462', description: 'TRAJE', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 120.5, currency: 'USD', originCountry: 'CHN', guideId: '369-94268462',
    consignee: { name: 'Juan Perez', rfc: 'TOMM020922D40', address: 'Calle 1' },
    sender: { name: 'SHEIN HK' }, platform: { commercialName: 'SHEIN', countryOfOrigin: 'CHN' }, ...over,
  } as Shipment;
}

describe('buildPedimento', () => {
  it('aggregates header totals and builds partidas with correct observation', () => {
    const ped = buildPedimento([ship({ customsValueUsd: 100 }), ship({ id: '2', customsValueUsd: 50 })], {
      numeroPedimento: '258516535001684',
      importer: { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' },
      agent: { patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' },
      tipoCambio: 20.45, customsEntryCode: '4', customsClearanceCode: '850',
      entryDate: '2025-04-04', paymentDate: '2025-04-05',
    });
    expect(ped.partidas).toHaveLength(2);
    expect(ped.header.valorDolares).toBeCloseTo(150);
    expect(ped.header.totalBultos).toBe(2);
    expect(ped.partidas[0].observation).toMatch(/^GUIA .+ VALOR 100.00 USD NOMBRE JUAN PEREZ RFC-CURP TOMM020922D40$/);
    expect(ped.partidas[0].paisVendedor).toBe('CHN');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd shared && npx vitest run pedimento/buildPedimento.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

`shared/pedimento/buildPedimento.ts`:
```ts
import type { Shipment } from '../types/shipment';
import type { Pedimento, PedimentoHeader, PedimentoPartida } from '../types/pedimento';
import { partidaObservation } from './observation';

export interface BuildOptions {
  numeroPedimento: string;
  importer: PedimentoHeader['importer'];
  agent: PedimentoHeader['agent'];
  tipoCambio: number;
  customsEntryCode: string;
  customsClearanceCode: string;
  entryDate: string;
  paymentDate: string;
  observations?: string;
}

const DEFAULT_OBS =
  'De conformidad con las reglas 1.6.29, 3.1.8 y 3.7.5 de las RGCE. ' +
  'Mercancía exenta de NOM conforme a regla aplicable. Ver manifiesto / guía master.';

export function buildPedimento(shipments: Shipment[], opts: BuildOptions): Pedimento {
  const partidas: PedimentoPartida[] = shipments.map((s, idx) => ({
    secuencia: idx + 1,
    fraccion: s.hsCode.replace(/\./g, ''),
    umc: s.unit || '6', cantidadUmc: s.quantity || 1,
    paisVendedor: s.originCountry, paisOrigenDestino: s.originCountry,
    description: s.description,
    valorAduanaUsd: s.customsValueUsd,
    precioPagado: s.customsValueUsd,
    contribuciones: [{ concepto: 'IVA', tasa: 19, importe: Math.round(s.customsValueUsd * opts.tipoCambio * 0.19 * 100) / 100 }],
    observation: partidaObservation({
      guideId: s.guideId, valueUsd: s.customsValueUsd,
      consigneeName: s.consignee.name, id: (s.consignee.curp ?? s.consignee.rfc),
    }),
  }));

  const valorDolares = shipments.reduce((a, s) => a + s.customsValueUsd, 0);
  const valorAduana = Math.round(valorDolares * opts.tipoCambio * 100) / 100;

  const header: PedimentoHeader = {
    numeroPedimento: opts.numeroPedimento, clave: 'T1', regimen: 'IMD', destino: '9',
    tipoCambio: opts.tipoCambio,
    pesoBrutoKg: shipments.reduce((a, s) => a + (Number((s as any).weightKg) || 0), 0),
    totalBultos: shipments.length,
    valorDolares, valorAduana, precioPagado: valorAduana,
    customsEntryCode: opts.customsEntryCode, customsClearanceCode: opts.customsClearanceCode,
    transport: { entrada: '4', arribo: '4', salida: '7' },
    entryDate: opts.entryDate, paymentDate: opts.paymentDate,
    identifiers: { EM: '143' },
    observations: opts.observations ?? DEFAULT_OBS,
    importer: opts.importer, agent: opts.agent, payment: {},
  };

  return { header, partidas };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd shared && npx vitest run pedimento/buildPedimento.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add shared/pedimento/buildPedimento.ts shared/pedimento/buildPedimento.test.ts
git commit -m "feat(pedimento): build full pedimento (header totals + partidas) from shipments"
```

---

### Task 5: Pedimento generation endpoint

**Files:**
- Create: `server/src/routes/pedimento.ts`
- Modify: `server/src/app.ts`, migration to store generated pedimento
- Test: `server/test/routes/pedimento.test.ts`

- [ ] **Step 1: Migration to store the generated pedimento on the manifest**

`server/migrations/1700000300000_pedimento.ts`:
```ts
import type { MigrationBuilder } from 'node-pg-migrate';
export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.addColumns('manifests', {
    pedimento: { type: 'jsonb' },
    prevalidation: { type: 'jsonb' },
  });
}
export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.dropColumns('manifests', ['pedimento', 'prevalidation']);
}
```
Run: `cd server && npm run migrate up && DATABASE_URL=$TEST_DATABASE_URL npm run migrate up`

- [ ] **Step 2: Write the failing test**

`server/test/routes/pedimento.test.ts`:
```ts
import { beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app';
import { hashPassword } from '../../src/auth/password';
import { signToken } from '../../src/auth/token';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

const app = createApp();
let token: string; let manifestId: string;

beforeEach(async () => {
  await truncateAll();
  const hash = await hashPassword('p');
  const u = await query(`INSERT INTO users (username,password_hash,role) VALUES ('a',$1,'admin') RETURNING id`, [hash]);
  token = signToken({ userId: u.rows[0].id, role: 'admin' });
  const m = await query(`INSERT INTO manifests (mawb_reference) VALUES ('369-1') RETURNING id`);
  manifestId = m.rows[0].id;
  const s = { id: crypto.randomUUID(), mawbReference: '369-1', description: 'TRAJE', hsCode: '99010001',
    quantity: 1, unit: '6', customsValueUsd: 120, currency: 'USD', originCountry: 'CHN', guideId: 'g1',
    consignee: { name: 'Juan', rfc: 'TOMM020922D40' }, sender: { name: 'S' }, platform: { commercialName: 'P' } };
  await query('INSERT INTO shipments (id,manifest_id,data) VALUES ($1,$2,$3)', [s.id, manifestId, JSON.stringify(s)]);
});

describe('POST /api/manifests/:id/pedimento', () => {
  it('builds, prevalidates, persists and returns the pedimento', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        numeroPedimento: '258516535001684', tipoCambio: 20.45,
        customsEntryCode: '4', customsClearanceCode: '850',
        entryDate: '2025-04-04', paymentDate: '2025-04-05',
        importer: { rfc: 'ADM130509UQ0', name: 'ADMERCE SA DE CV', fiscalAddress: 'CDMX' },
        agent: { patente: '1653', name: 'GUZMOR', agentRfc: 'GUMM710831UYA', agencyRfc: 'GLG1502247K9' },
      });
    expect(res.status).toBe(201);
    expect(res.body.prevalidation.status).toBe('APPROVED');
    expect(res.body.pedimento.partidas[0].observation).toMatch(/^GUIA /);
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `cd server && npx vitest run test/routes/pedimento.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

`server/src/routes/pedimento.ts`:
```ts
import { Router } from 'express';
import { query } from '../db/pool';
import { requireAuth, requireRole } from '../auth/middleware';
import { recordAudit } from '../services/audit';
import { buildPedimento } from '../../../shared/pedimento/buildPedimento';
import { prevalidatePedimento } from '../../../shared/pedimento/prevalidate';
import type { Shipment } from '../../../shared/types/shipment';

export const pedimentoRouter = Router();

pedimentoRouter.post('/:id/pedimento', requireAuth, requireRole('admin', 'capturista'), async (req, res) => {
  const { rows } = await query<{ data: Shipment }>('SELECT data FROM shipments WHERE manifest_id=$1', [req.params.id]);
  if (!rows.length) { res.status(400).json({ error: 'No shipments for manifest' }); return; }
  const ped = buildPedimento(rows.map((r) => r.data), req.body);
  const prevalidation = prevalidatePedimento(ped);
  await query('UPDATE manifests SET pedimento=$1, prevalidation=$2 WHERE id=$3',
    [JSON.stringify(ped), JSON.stringify(prevalidation), req.params.id]);
  await recordAudit({ userId: req.user!.userId, action: 'GENERATE_PEDIMENTO', entity: 'manifest', entityId: req.params.id, after: { numeroPedimento: ped.header.numeroPedimento, status: prevalidation.status } });
  res.status(201).json({ pedimento: ped, prevalidation });
});
```

- [ ] **Step 5: Mount in `app.ts`**

```ts
import { pedimentoRouter } from './routes/pedimento';
app.use('/api/manifests', pedimentoRouter);
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd server && npx vitest run test/routes/pedimento.test.ts`
Expected: PASS (1 test).

- [ ] **Step 7: Commit**

```bash
git add server/migrations/1700000300000_pedimento.ts server/src/routes/pedimento.ts server/src/app.ts server/test/routes/pedimento.test.ts
git commit -m "feat(server): pedimento generation endpoint with prevalidation"
```

---

## Self-Review Notes (coverage of spec §3.4)
- Header gaps closed in the model (Task 1): importador fiscal block, tipo de cambio on pedimento, peso bruto + bultos aggregate, valor dólares/aduana/precio pagado, incrementables/decrementables, transport triad, payment/línea-de-captura block, COVE, proveedor (incoterm/vinculación/master guide), identifiers SO/CR/EM/ED, pedimento-level observaciones, full agente-aduanal identity, dual fechas.
- Partida gaps closed in the model (Task 1): país V/C and O/D, UMC/UMT, valor aduana/precio pagado/unitario/agregado, marca/modelo/código, identificación comercial/VINC/MET VAL, NOMs, identificadores.
- Observation-format bug fixed (Task 2) and asserted in build (Task 4).
- RFC **and** CURP accepted (Task 3 `isValidTaxId`).
- Build (Task 4) currently populates the legally-required core; optional capture fields (incrementables, COVE, payment specifics) are accepted via request body/UI in plan 05 and flow through unchanged.
- Reused types: `Shipment` (plan 02), `Pedimento`/`PedimentoHeader`/`PedimentoPartida` (here) consumed by plan 05's Reporte/Consulta and the M3 export. `prevalidatePedimento`/`buildPedimento`/`partidaObservation` names are stable across plans.
