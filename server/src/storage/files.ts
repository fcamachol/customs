import { mkdir, readFile as fsReadFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { query } from '../db/pool';

export type FileKind = 'manifest' | 'pedimento_pdf' | 'report' | 'risk_analysis';
export interface SaveFileInput { kind: FileKind; originalName: string; bytes: Buffer; uploadedBy: string | null; }
export interface FileMeta { id: string; kind: FileKind; originalName: string; storagePath: string; sizeBytes: number; contentHash: string; }

const STORAGE_DIR = resolve(process.env.FILE_STORAGE_DIR ?? './storage');
const MAX_BYTES = 100 * 1024 * 1024;

export async function saveFile(input: SaveFileInput): Promise<FileMeta> {
  if (input.bytes.length > MAX_BYTES) throw new Error(`File exceeds ${MAX_BYTES} bytes`);
  const id = randomUUID();
  const dir = join(STORAGE_DIR, input.kind);
  await mkdir(dir, { recursive: true });
  const safeName = basename(input.originalName).replace(/[/\\]/g, '_') || 'file';
  const storagePath = join(dir, `${id}-${safeName}`);
  const contentHash = createHash('sha256').update(input.bytes).digest('hex');
  await writeFile(storagePath, input.bytes);
  await query(
    `INSERT INTO files (id, kind, original_name, storage_path, size_bytes, uploaded_by, content_hash) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, input.kind, input.originalName, storagePath, input.bytes.length, input.uploadedBy, contentHash],
  );
  return { id, kind: input.kind, originalName: input.originalName, storagePath, sizeBytes: input.bytes.length, contentHash };
}

export async function readFileById(fileId: string): Promise<{ bytes: Buffer; originalName: string } | null> {
  const { rows } = await query<{ storage_path: string; original_name: string }>(
    'SELECT storage_path, original_name FROM files WHERE id=$1', [fileId]);
  if (!rows.length) return null;
  const bytes = await fsReadFile(rows[0].storage_path);
  return { bytes: Buffer.from(bytes), originalName: rows[0].original_name };
}
