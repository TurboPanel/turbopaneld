import { assertEquals } from "@std/assert";
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
    "handleTlsTrust writes a first-time CA without allowRemoval when none is present",
  permissions: TLS_TRUST_PERMS,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-tls-trust-first-" });
    try {
      const cert = await mintCert(dir, "first");
      const fp = await fingerprintPemCertificate(cert);
      const caPath = join(dir, "instance-ca.pem");
      const result = await handleTlsTrust(
        { bundlePem: cert, fingerprint: fp },
        new Date().toISOString(),
        { caPath },
      );
      assertEquals(result.applied, true);
      assertEquals(result.fingerprint, fp);
      const written = await Deno.readTextFile(caPath);
      assertEquals(splitPemBundle(written).length, 1);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

test({
  name: "handleTlsTrust default writeAtomic keeps a PEM that already ends in newline",
  permissions: TLS_TRUST_PERMS,
  fn: async () => {
    const dir = await Deno.makeTempDir({ prefix: "tp-tls-trust-nl-" });
    try {
      const cert = await mintCert(dir, "newline");
      const fp = await fingerprintPemCertificate(cert);
      const caPath = join(dir, "instance-ca.pem");
      const withNewline = cert.endsWith("\n") ? cert : `${cert}\n`;
      const result = await handleTlsTrust(
        { bundlePem: withNewline, fingerprint: fp },
        new Date().toISOString(),
        { caPath, invalidate: () => undefined },
      );
      assertEquals(result.applied, true);
      const written = await Deno.readTextFile(caPath);
      assertEquals(written.endsWith("\n"), true);
      assertEquals(written.endsWith("\n\n"), false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});
