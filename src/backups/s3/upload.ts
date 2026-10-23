/**
 * Copy one file to the bucket: a single PUT for a small file, a resumable
 * multipart upload for a large one, then a size check on the stored object.
 *
 * Memory: at most one part (16 MiB, more only for a very large file) is held
 * at a time, because the request body needs a known length (see `client.ts`).
 * The whole file is never read into memory.
 */

import { type S3Client, S3Error } from "./client.ts";

export const DEFAULT_PART_BYTES = 16 * 1024 * 1024;
const MAX_PARTS = 9000;

type UploadState = {
  version: 1;
  key: string;
  uploadId: string;
  partBytes: number;
  size: number;
  mtimeMs: number;
  parts: { n: number; etag: string }[];
};

export type UploadRequest = {
  path: string;
  /** Full object key. */
  key: string;
  sha256: string;
  /** Where multipart progress is kept so a restart can continue. */
  statePath: string;
  partBytes?: number;
};

export function partSizeFor(
  size: number,
  preferred = DEFAULT_PART_BYTES,
): number {
  return Math.max(preferred, Math.ceil(size / MAX_PARTS));
}

async function readState(path: string): Promise<UploadState | null> {
  try {
    const parsed = JSON.parse(await Deno.readTextFile(path)) as UploadState;
    return parsed?.version === 1 && Array.isArray(parsed.parts) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeState(path: string, state: UploadState): Promise<void> {
  const tmp = `${path}.tmp`;
  await Deno.writeTextFile(tmp, JSON.stringify(state), { mode: 0o600 });
  await Deno.rename(tmp, path);
}

async function readRange(
  file: Deno.FsFile,
  offset: number,
  length: number,
): Promise<Uint8Array> {
  const buf = new Uint8Array(length);
  await file.seek(offset, Deno.SeekMode.Start);
  let read = 0;
  while (read < length) {
    const n = await file.read(buf.subarray(read));
    if (n === null) throw new Error("the backup file ended early");
    read += n;
  }
  return buf;
}

async function resumableState(
  client: S3Client,
  req: UploadRequest,
  size: number,
  mtimeMs: number,
  partBytes: number,
): Promise<UploadState> {
  const old = await readState(req.statePath);
  if (
    old?.key === req.key && old.size === size &&
    old.mtimeMs === mtimeMs &&
    old.partBytes === partBytes
  ) {
    return old;
  }
  if (old) {
    await client.abortMultipartUpload(old.key, old.uploadId).catch(() => {});
  }
  const uploadId = await client.createMultipartUpload(req.key, {
    sha256: req.sha256,
  });
  const fresh: UploadState = {
    version: 1,
    key: req.key,
    uploadId,
    partBytes,
    size,
    mtimeMs,
    parts: [],
  };
  await writeState(req.statePath, fresh);
  return fresh;
}

async function uploadParts(
  client: S3Client,
  file: Deno.FsFile,
  state: UploadState,
  req: UploadRequest,
): Promise<void> {
  const total = Math.ceil(state.size / state.partBytes);
  const done = new Set(state.parts.map((p) => p.n));
  for (let n = 1; n <= total; n++) {
    if (done.has(n)) continue;
    const offset = (n - 1) * state.partBytes;
    const length = Math.min(state.partBytes, state.size - offset);
    const etag = await client.uploadPart(
      req.key,
      state.uploadId,
      n,
      await readRange(file, offset, length),
    );
    state.parts.push({ n, etag });
    await writeState(req.statePath, state);
  }
}

/** Returns the stored size. Throws {@link S3Error} with a plain reason. */
export async function uploadBackupFile(
  client: S3Client,
  req: UploadRequest,
): Promise<number> {
  const info = await Deno.stat(req.path);
  const size = info.size;
  const partBytes = partSizeFor(size, req.partBytes);
  const file = await Deno.open(req.path, { read: true });
  try {
    if (size <= partBytes) {
      await client.putObject(req.key, await readRange(file, 0, size), {
        sha256: req.sha256,
      });
    } else {
      const state = await resumableState(
        client,
        req,
        size,
        info.mtime?.getTime() ?? 0,
        partBytes,
      );
      try {
        await uploadParts(client, file, state, req);
        state.parts.sort((a, b) => a.n - b.n);
        await client.completeMultipartUpload(
          req.key,
          state.uploadId,
          state.parts,
        );
      } catch (err) {
        // The storage forgot the upload: start clean next time.
        if (err instanceof S3Error && err.code === "NoSuchUpload") {
          await Deno.remove(req.statePath).catch(() => {});
        }
        throw err;
      }
    }
  } finally {
    file.close();
  }
  await Deno.remove(req.statePath).catch(() => {});
  const head = await client.headObject(req.key);
  if (!head || head.size !== size) {
    throw new S3Error(
      "the stored copy is not the same size as the backup",
      200,
      "SizeMismatch",
      true,
    );
  }
  return size;
}

/** Stop a half-finished multipart upload so its parts stop costing storage. */
export async function abandonUpload(
  client: S3Client,
  statePath: string,
): Promise<void> {
  const state = await readState(statePath);
  if (state) {
    await client.abortMultipartUpload(state.key, state.uploadId).catch(
      () => {},
    );
  }
  await Deno.remove(statePath).catch(() => {});
}
