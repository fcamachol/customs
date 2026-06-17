import { beforeEach, describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { saveFile } from '../../src/storage/files';
import { query } from '../../src/db/pool';
import { truncateAll } from '../helpers/db';

describe('file storage security', () => {
  beforeEach(truncateAll);

  it('sanitizes a traversal filename so it cannot escape the storage dir', async () => {
    const buf = Buffer.from('payload');
    const meta = await saveFile({ kind: 'manifest', originalName: '../../evil.txt', bytes: buf, uploadedBy: null });
    expect(meta.storagePath).toContain('/storage/');
    expect(meta.storagePath).not.toContain('..');
    const onDisk = await readFile(meta.storagePath);
    expect(onDisk.toString()).toBe('payload');
  });

  it('keeps the original (unsanitized) name in the files record', async () => {
    const buf = Buffer.from('payload');
    const meta = await saveFile({ kind: 'manifest', originalName: '../../evil.txt', bytes: buf, uploadedBy: null });
    expect(meta.originalName).toBe('../../evil.txt');
    const { rows } = await query<{ original_name: string }>('SELECT original_name FROM files WHERE id=$1', [meta.id]);
    expect(rows[0].original_name).toBe('../../evil.txt');
  });
});
