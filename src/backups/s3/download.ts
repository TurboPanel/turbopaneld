/**
 * Fetch one object to a local file with ranged requests (resumable, never in
 * memory), then check size and SHA-256 before the file is moved into place.
 */

import { digestFileSha256 } from "../../managed/backup.ts";
import { type S3Client, S3Error } from "./client.ts";
import { repeatSequential } from "../../util/sequential.ts";
import { DEFAULT_PART_BYTES } from "./upload.ts";

export type DownloadRequest = {
  key: string;
  destination: string;
  sha256: string;
  size?: number;
  rangeBytes?: number;
};

/** Download to `destination`; the file exists only if it verified. */
export async function downloadBackupFile(
  client: S3Client,
  req: DownloadRequest,
): Promise<number> {
  const head = await client.headObject(req.key);
  if (!head) {
    throw new S3Error(
      "the copy is no longer in the bucket",
      404,
      "NoSuchKey",
      false,
    );
  }
  if (req.size !== undefined && head.size !== req.size) {
    throw new S3Error(
      "the copy in the bucket is not the size the panel recorded",
      200,
      "SizeMismatch",
      false,
    );
  }
  const part = `${req.destination}.part`;
  let have = 0;
  try {
    have = (await Deno.stat(part)).size;
  } catch { /* nothing yet */ }
  if (have > head.size) {
    await Deno.remove(part);
    have = 0;
  }
  const step = req.rangeBytes ?? DEFAULT_PART_BYTES;
  const file = await Deno.open(part, {
    create: true,
    write: true,
    mode: 0o600,
  });
  try {
    await file.seek(have, Deno.SeekMode.Start);
    await repeatSequential(async () => {
      if (have >= head.size) return false;
      const end = Math.min(have + step, head.size) - 1;
      const response = await client.getObject(req.key, { start: have, end });
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength !== end - have + 1) {
        throw new S3Error(
          "the download came back short",
          200,
          "ShortRead",
          true,
        );
      }
      await file.write(bytes);
      have += bytes.byteLength;
      return true;
    });
  } finally {
    file.close();
  }
  if ((await digestFileSha256(part)) !== req.sha256) {
    await Deno.remove(part).catch(() => {});
    throw new S3Error(
      "the downloaded file does not match the checksum the panel recorded",
      200,
      "ChecksumMismatch",
      false,
    );
  }
  await Deno.rename(part, req.destination);
  return head.size;
}
