import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { saveFile } from '../../src/storage/files';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('file storage', () => {
  beforeEach(truncateAll);
  it('saves bytes to disk and records metadata', async () => {
    const buf = Buffer.from('hello manifest');
    const meta = await saveFile({ kind: 'manifest', originalName: 'm.xlsx', bytes: buf, uploadedBy: null });
    expect(meta.id).toBeTruthy();
    const onDisk = await readFile(meta.storagePath);
    expect(onDisk.toString()).toBe('hello manifest');
    const { rows } = await query('SELECT kind, size_bytes FROM files WHERE id=$1', [meta.id]);
    expect(rows[0].kind).toBe('manifest');
    expect(Number(rows[0].size_bytes)).toBe(buf.length);
  });
});
