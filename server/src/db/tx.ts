import { pool } from './pool';
export async function withTransaction<T>(fn: (q: (text: string, params?: unknown[]) => Promise<any>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn((text, params) => client.query(text, params as any[]));
    await client.query('COMMIT');
    return out;
  } catch (e) { await client.query('ROLLBACK'); throw e; }
  finally { client.release(); }
}
