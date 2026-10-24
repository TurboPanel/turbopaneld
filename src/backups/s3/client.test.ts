import { assert, assertEquals, assertRejects } from "@std/assert";
import { startFakeS3 } from "../../testing/fake-s3.ts";
import { S3Client, S3Error, type S3TargetConfig } from "./client.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function config(
  endpoint: string,
  over: Partial<S3TargetConfig> = {},
): S3TargetConfig {
  return {
    endpoint,
    region: "us-east-1",
    bucket: "backups",
    prefix: "tp",
    pathStyle: true,
    serverSideEncryption: false,
    credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret" },
    ...over,
  };
}

const deps = { guard: { allowLoopback: true }, sleep: () => Promise.resolve() };

test("put, head, get, list with paging, and delete", async () => {
  const fake = startFakeS3();
  try {
    const client = new S3Client(
      config(fake.endpoint, { serverSideEncryption: true }),
      deps,
    );
    await client.putObject(
      client.fullKey("a/one.dump"),
      new TextEncoder().encode("hello"),
      {
        sha256: "abc",
      },
    );
    for (const n of ["two", "three", "four"]) {
      await client.putObject(client.fullKey(`a/${n}.dump`), new Uint8Array(3));
    }
    const head = await client.headObject(client.fullKey("a/one.dump"));
    assertEquals(head?.size, 5);
    assertEquals(head?.metadata["sha256"], "abc");
    assertEquals(await client.headObject("tp/missing"), null);
    const text = new TextDecoder().decode(
      await client.getObjectBytes("tp/a/one.dump"),
    );
    assertEquals(text, "hello");
    const range =
      await (await client.getObject("tp/a/one.dump", { start: 1, end: 2 }))
        .text();
    assertEquals(range, "el");
    assertEquals((await client.listObjects("tp/a/")).length, 4);
    await client.deleteObject("tp/a/one.dump");
    await client.deleteObject("tp/a/one.dump");
    assertEquals((await client.listObjects("tp/a/")).length, 3);
  } finally {
    await fake.stop();
  }
});

test("retries a server error and then succeeds", async () => {
  const fake = startFakeS3();
  try {
    let failures = 2;
    fake.inject = (req) => {
      if (req.method === "PUT" && failures-- > 0) {
        return new Response("boom", { status: 503 });
      }
      return null;
    };
    const client = new S3Client(config(fake.endpoint), deps);
    await client.putObject("tp/x", new Uint8Array(1));
    assertEquals(fake.requests.filter((r) => r.startsWith("PUT")).length, 3);
  } finally {
    await fake.stop();
  }
});

test("gives plain reasons and does not retry a refusal", async () => {
  const fake = startFakeS3();
  try {
    const wrongBucket = new S3Client(
      config(fake.endpoint, { bucket: "nope" }),
      deps,
    );
    const err = await assertRejects(
      () => wrongBucket.putObject("x", new Uint8Array(1)),
      S3Error,
    );
    assertEquals(err.message, "the bucket does not exist");
    assertEquals(fake.requests.length, 1);
  } finally {
    await fake.stop();
  }
});

test("never echoes a response body and does not follow redirects", async () => {
  const fake = startFakeS3();
  try {
    fake.inject = () =>
      new Response("secret-body-text", {
        status: 307,
        headers: { location: "http://evil.example/" },
      });
    const client = new S3Client(config(fake.endpoint), deps);
    const err = await assertRejects(
      () => client.putObject("x", new Uint8Array(1)),
      S3Error,
    );
    assert(!err.message.includes("secret-body-text"));
    assertEquals(
      err.message,
      "the endpoint or region is wrong for this bucket",
    );
    assertEquals(fake.requests.length, 1);
  } finally {
    await fake.stop();
  }
});

test("refuses a loopback endpoint unless the test allows it", async () => {
  const client = new S3Client(config("http://127.0.0.1:1"), {
    sleep: () => Promise.resolve(),
  });
  const err = await assertRejects(
    () => client.putObject("x", new Uint8Array(1)),
    S3Error,
  );
  assertEquals(err.code, "EndpointRefused");
});

test("virtual-host style puts the bucket in the host name", async () => {
  const seen: string[] = [];
  const client = new S3Client(
    config("https://s3.example.com", { pathStyle: false }),
    {
      ...deps,
      fetch: (input) => {
        seen.push(String(input));
        return Promise.resolve(new Response(null, { status: 200 }));
      },
    },
  );
  await client.putObject("tp/x y", new Uint8Array(1));
  assertEquals(seen, ["https://backups.s3.example.com/tp/x%20y"]);
});
