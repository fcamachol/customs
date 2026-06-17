import { mkdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { query } from '../db/pool';

export type FileKind = 'manifest' | 'pedimento_pdf' | 'report';
export interface SaveFileInput { kind: FileKind; originalName: string; bytes: Buffer; uploadedBy: string | null; }
export interface FileMeta { id: string; kind: FileKind; originalName: string; storagePath: string; sizeBytes: number; }

const STORAGE_DIR = resolve(process.env.FILE_STORAGE_DIR ?? './storage');
const MAX_BYTES = 100 * 1024 * 1024;

export async function saveFile(input: SaveFileInput): Promise<FileMeta> {
  if (input.bytes.length > MAX_BYTES) throw new Error(`File exceeds ${MAX_BYTES} bytes`);
  const id = randomUUID();
  const dir = join(STORAGE_DIR, input.kind);
  await mkdir(dir, { recursive: true });
  const safeName = basename(input.originalName).replace(/[/\\]/g, '_') || 'file';
  const storagePath = join(dir, `${id}-${safeName}`);
  await writeFile(storagePath, input.bytes);
  await query(
    `INSERT INTO files (id, kind, original_name, storage_path, size_bytes, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, input.kind, input.originalName, storagePath, input.bytes.length, input.uploadedBy],
  );
  return { id, kind: input.kind, originalName: input.originalName, storagePath, sizeBytes: input.bytes.length };
}
