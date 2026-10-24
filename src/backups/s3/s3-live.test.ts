import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { digestFileSha256 } from "../../managed/backup.ts";
import { S3Client } from "./client.ts";
import { downloadBackupFile } from "./download.ts";
import { pruneBucketFolder } from "./prune.ts";
import { EMPTY_PAYLOAD_SHA256, signS3Request } from "./sigv4.ts";
import { uploadBackupFile } from "./upload.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * Runs the client against a real S3-compatible server when
 * `TP_S3_TEST_ENDPOINT`, `TP_S3_TEST_ACCESS_KEY` and `TP_S3_TEST_SECRET_KEY`
 * are set (a throwaway local container; start one, run this, remove it).
 * Skipped otherwise, so it never needs a network or real credentials in CI.
 */
const endpoint = Deno.env.get("TP_S3_TEST_ENDPOINT");
const accessKeyId = Deno.env.get("TP_S3_TEST_ACCESS_KEY") ?? "";
const secretAccessKey = Deno.env.get("TP_S3_TEST_SECRET_KEY") ?? "";
const bucket = "tp-copy-live-test";

async function ensureBucket(): Promise<void> {
  const url = new URL(`${endpoint}/${bucket}/`);
  const headers = await signS3Request({
    method: "PUT",
    url,
    region: "us-east-1",
    credentials: { accessKeyId, secretAccessKey },
    payloadHash: EMPTY_PAYLOAD_SHA256,
    now: new Date(),
  });
  const response = await fetch(url, { method: "PUT", headers });
  await response.body?.cancel();
  if (response.status !== 200 && response.status !== 409) {
    throw new Error(
      `could not create the test bucket: HTTP ${response.status}`,
    );
  }
}

test({
  name: "live: multipart upload, ranged download, listing and pruning",
  ignore: !endpoint,
  fn: async () => {
    await ensureBucket();
    const client = new S3Client({
      endpoint: endpoint!,
      region: "us-east-1",
      bucket,
      prefix: "live",
      pathStyle: true,
      serverSideEncryption: false,
      credentials: { accessKeyId, secretAccessKey },
    }, { guard: { allowLoopback: true } });
    const dir = await Deno.makeTempDir();
    try {
      const path = join(dir, "bk_live.dump");
      // 11 MiB with a 5 MiB part size: three parts on a real server.
      const data = new Uint8Array(11 * 1024 * 1024);
      for (let i = 0; i < data.length; i++) data[i] = (i * 131 + 17) & 255;
      await Deno.writeFile(path, data);
      const sha = await digestFileSha256(path);
      const key = client.fullKey("managed/m/policy-p/bk_live.dump");
      await uploadBackupFile(client, {
        path,
        key,
        sha256: sha,
        statePath: join(dir, "state.json"),
        partBytes: 5 * 1024 * 1024,
      });
      const head = await client.headObject(key);
      assertEquals(head?.size, data.length);
      assertEquals(head?.metadata["sha256"], sha);
      const back = join(dir, "back.dump");
      await downloadBackupFile(client, {
        key,
        destination: back,
        sha256: sha,
        rangeBytes: 4 * 1024 * 1024,
      });
      assertEquals(await digestFileSha256(back), sha);
      for (const n of [1, 2, 3]) {
        await client.putObject(
          client.fullKey(`managed/m/policy-p/bk_o${n}.dump`),
          new Uint8Array(1),
        );
      }
      const removed = await pruneBucketFolder(
        client,
        client.fullKey("managed/m/policy-p"),
        2,
        key,
      );
      assertEquals(removed.length, 2);
      for (const o of await client.listObjects(client.fullKey("managed/"))) {
        await client.deleteObject(o.key);
      }
      assertEquals((await client.listObjects("live/")).length, 0);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
