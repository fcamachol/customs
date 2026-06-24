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
  token = signToken({ userId: u.rows[0].id, role: 'admin' , tv: 0 });
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

  it('returns 400 (not 500) when importer and agent are missing', async () => {
    const res = await request(app)
      .post(`/api/manifests/${manifestId}/pedimento`)
      .set('Authorization', `Bearer ${token}`)
      .send({
        numeroPedimento: '258516535001684', tipoCambio: 20.45,
        customsEntryCode: '4', customsClearanceCode: '850',
        entryDate: '2025-04-04', paymentDate: '2025-04-05',
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/importer/);
  });
});
