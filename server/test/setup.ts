import { execSync } from 'node:child_process';
import { afterAll, beforeAll } from 'vitest';
import { pool } from '../src/db/pool';

beforeAll(() => {
  process.env.NODE_ENV = 'test';
  execSync('npx node-pg-migrate --tsx -m migrations up', {
    env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
    stdio: 'inherit',
  });
});

afterAll(async () => {
  await pool.end();
});
