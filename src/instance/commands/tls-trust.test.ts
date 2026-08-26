import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { fingerprintPemCertificate, splitPemBundle } from "../paths.ts";
import { handleTlsTrust } from "./tls-trust.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const TLS_TRUST_PERMS = {
  read: true,
  write: true,
  run: true,
  env: true,
} as const;

async function mintCert(dir: string, cn: string): Promise<string> {
  const keyPath = join(dir, `${cn}.key`);
  const certPath = join(dir, `${cn}.crt`);
  const gen = await new Deno.Command("openssl", {
    args: [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      `/CN=${cn}`,
    ],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (!gen.success) {
    throw new Error(`openssl failed: ${new TextDecoder().decode(gen.stderr)}`);
  }
  return await Deno.readTextFile(certPath);
}

test({
  name:
    "handleTlsTrust writes the bundle and rejects dropping the current anchor",
  permissions: TLS_TRUST_PERMS,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-tls-trust-" });
    try {
      const current = await mintCert(dir, "current");
      const next = await mintCert(dir, "next");
      const caPath = join(dir, "instance-ca.pem");
      await Deno.writeTextFile(caPath, current);
      const currentFp = await fingerprintPemCertificate(current);
      const nextFp = await fingerprintPemCertificate(next);
      const overlap = `${next.trim()}\n${current.trim()}\n`;

      const written: string[] = [];
      let invalidated = false;
      const result = await handleTlsTrust(
        { bundlePem: overlap, fingerprint: nextFp },
        new Date().toISOString(),
        {
          caPath,
          writeAtomic: (_path, contents) => {
            written.push(contents);
            return Promise.resolve();
          },
          invalidate: () => {
            invalidated = true;
          },
        },
      );
      assertEquals(result.applied, true);
      assertEquals(result.fingerprint, nextFp);
      assertEquals(written.length, 1);
      assertEquals(splitPemBundle(written[0] ?? []).length, 2);
      assertEquals(invalidated, true);

      await assertRejects(
        () =>
          handleTlsTrust(
            { bundlePem: next, fingerprint: nextFp },
            new Date().toISOString(),
            { caPath, readTextFile: () => Promise.resolve(current) },
          ),
        Error,
        "drops the currently-trusted platform CA",
      );

      const removed = await handleTlsTrust(
        { bundlePem: next, fingerprint: nextFp, allowRemoval: true },
        new Date().toISOString(),
        {
          caPath,
          readTextFile: () => Promise.resolve(current),
          writeAtomic: () => Promise.resolve(),
          invalidate: () => undefined,
        },
      );
      assertEquals(removed.applied, true);
      assertEquals(currentFp.length, 64);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "handleTlsTrust writes TURBOPANEL_INSTANCE_CA when that file exists",
  permissions: TLS_TRUST_PERMS,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-tls-trust-env-" });
    const previous = Deno.env.get("TURBOPANEL_INSTANCE_CA");
    try {
      const current = await mintCert(dir, "current");
      const next = await mintCert(dir, "next");
      const overridePath = join(dir, "custom-ca.pem");
      await Deno.writeTextFile(overridePath, current);
      Deno.env.set("TURBOPANEL_INSTANCE_CA", overridePath);
      const nextFp = await fingerprintPemCertificate(next);
      const overlap = `${next.trim()}\n${current.trim()}\n`;

      await assertRejects(
        () =>
          handleTlsTrust(
            { bundlePem: next, fingerprint: nextFp },
            new Date().toISOString(),
            {
              writeAtomic: () => Promise.resolve(),
              invalidate: () => undefined,
            },
          ),
        Error,
        "drops the currently-trusted platform CA",
      );

      const writtenPaths: string[] = [];
      const result = await handleTlsTrust(
        { bundlePem: overlap, fingerprint: nextFp },
        new Date().toISOString(),
        {
          writeAtomic: (path, _contents) => {
            writtenPaths.push(path);
            return Promise.resolve();
          },
          invalidate: () => undefined,
        },
      );
      assertEquals(result.applied, true);
      assertEquals(writtenPaths, [overridePath]);
    } finally {
      if (previous === undefined) Deno.env.delete("TURBOPANEL_INSTANCE_CA");
      else Deno.env.set("TURBOPANEL_INSTANCE_CA", previous);
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "handleTlsTrust rejects empty or mismatched fingerprint bundles",
  permissions: TLS_TRUST_PERMS,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-tls-trust-reject-" });
    try {
      const cert = await mintCert(dir, "only");
      const fp = await fingerprintPemCertificate(cert);
      // Parser only requires the substring; splitPemBundle needs ----- fences.
      await assertRejects(
        () =>
          handleTlsTrust(
            {
              bundlePem: "BEGIN CERTIFICATE without PEM fences",
              fingerprint: fp,
            },
            new Date().toISOString(),
            { caPath: join(dir, "missing.pem") },
          ),
        Error,
        "bundlePem contains no certificates",
      );
      await assertRejects(
        () =>
          handleTlsTrust(
            {
              bundlePem: cert,
              fingerprint: "0".repeat(64),
            },
            new Date().toISOString(),
            { caPath: join(dir, "missing.pem") },
          ),
        Error,
        "does not match the first certificate",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name:
    "handleTlsTrust rethrows non-NotFound errors when reading the current CA",
  permissions: TLS_TRUST_PERMS,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-tls-trust-read-" });
    try {
      const cert = await mintCert(dir, "fresh");
      const fp = await fingerprintPemCertificate(cert);
      await assertRejects(
        () =>
          handleTlsTrust(
            { bundlePem: cert, fingerprint: fp },
            new Date().toISOString(),
            {
              caPath: join(dir, "instance-ca.pem"),
              readTextFile: () =>
                Promise.reject(new Deno.errors.PermissionDenied("denied")),
            },
          ),
        Deno.errors.PermissionDenied,
        "denied",
      );
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "handleTlsTrust default writeAtomic persists PEM with trailing newline",
  permissions: TLS_TRUST_PERMS,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-tls-trust-atomic-" });
    try {
      const cert = await mintCert(dir, "anchor");
      const fp = await fingerprintPemCertificate(cert);
      const caPath = join(dir, "instance-ca.pem");
      const withoutNewline = cert.trimEnd();
      const result = await handleTlsTrust(
        { bundlePem: withoutNewline, fingerprint: fp },
        new Date().toISOString(),
        {
          caPath,
          invalidate: () => undefined,
        },
      );
      assertEquals(result.applied, true);
      assertEquals(result.fingerprint, fp);
      const written = await Deno.readTextFile(caPath);
      assertEquals(written.endsWith("\n"), true);
      assertEquals(splitPemBundle(written).length, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
