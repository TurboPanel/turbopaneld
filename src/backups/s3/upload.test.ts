import { assertEquals, assertRejects } from "@std/assert";
import { startFakeS3 } from "../../testing/fake-s3.ts";
import { S3Client, S3Error } from "./client.ts";
import { abandonUpload, partSizeFor, uploadBackupFile } from "./upload.ts";
import { downloadBackupFile } from "./download.ts";
import { backupIdOfKey, pruneBucketFolder } from "./prune.ts";
import { digestFileSha256 } from "../../managed/backup.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function clientFor(endpoint: string): S3Client {
  return new S3Client({
    endpoint,
    region: "us-east-1",
    bucket: "backups",
    prefix: "tp",
    pathStyle: true,
    serverSideEncryption: false,
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
  }, { guard: { allowLoopback: true }, sleep: () => Promise.resolve() });
}

async function withFile<T>(
  bytes: number,
  fn: (dir: string, path: string, sha: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/bk_1.dump`;
    const data = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i++) data[i] = (i * 31 + 7) & 255;
    await Deno.writeFile(path, data);
    return await fn(dir, path, await digestFileSha256(path));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("a small file goes up in one request with its checksum", async () => {
  const fake = startFakeS3();
  try {
    await withFile(1000, async (dir, path, sha) => {
      const client = clientFor(fake.endpoint);
      const size = await uploadBackupFile(client, {
        path,
        key: "tp/managed/m1/manual/bk_1.dump",
        sha256: sha,
        statePath: `${dir}/state.json`,
      });
      assertEquals(size, 1000);
      assertEquals(
        fake.objects.get("tp/managed/m1/manual/bk_1.dump")?.metadata["sha256"],
        sha,
      );
      assertEquals(fake.uploads.size, 0);
    });
  } finally {
    await fake.stop();
  }
});

test("a large file goes up in parts and round-trips through a download", async () => {
  const fake = startFakeS3();
  try {
    await withFile(1_000_003, async (dir, path, sha) => {
      const client = clientFor(fake.endpoint);
      const key = "tp/managed/m1/policy-p1/bk_1.dump";
      await uploadBackupFile(client, {
        path,
        key,
        sha256: sha,
        statePath: `${dir}/state.json`,
        partBytes: 300_000,
      });
      assertEquals(
        fake.requests.filter((r) => r.includes("partNumber")).length,
        4,
      );
      const dest = `${dir}/restored.dump`;
      assertEquals(
        await downloadBackupFile(client, {
          key,
          destination: dest,
          sha256: sha,
          rangeBytes: 400_000,
        }),
        1_000_003,
      );
      assertEquals(await digestFileSha256(dest), sha);
      await assertRejects(
        () =>
          downloadBackupFile(client, {
            key,
            destination: `${dir}/bad`,
            sha256: "0".repeat(64),
          }),
        S3Error,
        "checksum",
      );
    });
  } finally {
    await fake.stop();
  }
});

test("an interrupted multipart upload continues with the missing parts", async () => {
  const fake = startFakeS3();
  try {
    await withFile(900_000, async (dir, path, sha) => {
      const client = clientFor(fake.endpoint);
      const key = "tp/managed/m1/manual/bk_1.dump";
      let puts = 0;
      fake.inject = (req, url) => {
        if (
          req.method === "PUT" && url.searchParams.has("partNumber") &&
          ++puts > 2
        ) {
          return new Response(null, { status: 400 });
        }
        return null;
      };
      const req = {
        path,
        key,
        sha256: sha,
        statePath: `${dir}/state.json`,
        partBytes: 300_000,
      };
      await assertRejects(() => uploadBackupFile(client, req), S3Error);
      fake.inject = null;
      fake.requests.length = 0;
      await uploadBackupFile(client, req);
      assertEquals(
        fake.requests.filter((r) => r.includes("partNumber")).length,
        1,
      );
      assertEquals(fake.uploads.size, 0);
      assertEquals(fake.objects.get(key)?.body.byteLength, 900_000);
    });
  } finally {
    await fake.stop();
  }
});

test("abandoning an upload aborts it at the storage", async () => {
  const fake = startFakeS3();
  try {
    await withFile(900_000, async (dir, path, sha) => {
      const client = clientFor(fake.endpoint);
      fake.inject = (req, url) =>
        req.method === "PUT" && url.searchParams.has("partNumber")
          ? new Response(null, { status: 400 })
          : null;
      const statePath = `${dir}/state.json`;
      await assertRejects(() =>
        uploadBackupFile(client, {
          path,
          key: "tp/x/bk_1.dump",
          sha256: sha,
          statePath,
          partBytes: 300_000,
        })
      );
      assertEquals(fake.uploads.size, 1);
      fake.inject = null;
      await abandonUpload(client, statePath);
      assertEquals(fake.uploads.size, 0);
    });
  } finally {
    await fake.stop();
  }
});

test("bucket retention keeps the newest copies and the one just made", async () => {
  const fake = startFakeS3();
  try {
    const client = clientFor(fake.endpoint);
    for (let i = 1; i <= 5; i++) {
      await client.putObject(
        `tp/managed/m1/policy-p1/bk_${i}.dump`,
        new Uint8Array(1),
      );
      fake.objects.get(`tp/managed/m1/policy-p1/bk_${i}.dump`)!.modified =
        new Date(2026, 0, i);
    }
    await client.putObject(
      "tp/managed/m1/policy-p2/bk_9.dump",
      new Uint8Array(1),
    );
    const removed = await pruneBucketFolder(
      client,
      "tp/managed/m1/policy-p1",
      2,
      "tp/managed/m1/policy-p1/bk_5.dump",
    );
    assertEquals(removed.sort(), ["bk_1", "bk_2", "bk_3"]);
    assertEquals(fake.objects.size, 3);
    assertEquals(backupIdOfKey("a/bk_1.dump"), "bk_1");
    assertEquals(backupIdOfKey("a/.turbopanel-test"), null);
    assertEquals(partSizeFor(1e12), Math.ceil(1e12 / 9000));
  } finally {
    await fake.stop();
  }
});
