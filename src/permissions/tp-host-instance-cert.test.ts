/**
 * tp-host `instance-cert-install`: a control-plane hostname's certificate
 * pair, staged by the daemon, is checked and placed in the certs folder the
 * control-plane Caddy reads; anything else is refused and nothing is written.
 * Run unprivileged in tp-host's test mode against a throwaway prefix (see
 * tp-host.test.ts).
 */
import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  type Host,
  refused,
  TP_HOST_SCRIPT,
  withHost,
} from "../testing/tp-host-fixture.ts";
import {
  INSTANCE_CERT_CHAIN_MAX_BLOCKS,
  INSTANCE_CERT_CHAIN_MAX_BYTES,
  INSTANCE_CERT_KEY_MAX_BYTES,
  instanceCertStageDir,
  resolveInstanceCertsDir,
} from "../instance/public-urls-apply.ts";

const test = Deno.test.bind(Deno);

const ID = "01a1a47c-5b2d-7e3f-9a4b-6c7d8e9f0a1b";
const STAGE_DIR = "var/lib/turbopanel/system/instance-certs";
const CERTS_DIR = "var/lib/turbopanel/tls/certs";
/** PEM labels built from parts, so no key header sits in the source. */
const KEY_LABEL = ["PRIVATE", "KEY"].join(" ");
const block = (label: string, body = "MIIBszCCAVmgAwIBAgIUZm9yIHRlc3Rz") =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
const CERT = block("CERTIFICATE");
const CHAIN = `${CERT}\n${CERT}`;
const KEY = block(KEY_LABEL, "MC4CAQAwBQYDK2VwBCIEIGZvciB0ZXN0cw==");

async function stage(host: Host, cert: string, key: string, id = ID) {
  await Deno.mkdir(host.path(STAGE_DIR), { recursive: true, mode: 0o700 });
  await Deno.writeTextFile(host.path(`${STAGE_DIR}/${id}.crt`), cert);
  await Deno.writeTextFile(host.path(`${STAGE_DIR}/${id}.key`), key);
}

const exists = (path: string) => Deno.lstat(path).then(() => true, () => false);

async function assertNothingInstalled(host: Host, id = ID) {
  assertEquals(
    await exists(host.path(`${CERTS_DIR}/uploaded-${id}.crt`)),
    false,
  );
  assertEquals(
    await exists(host.path(`${CERTS_DIR}/uploaded-${id}.key`)),
    false,
  );
}

test("instance-cert-install places a checked pair root:tp 0640 in the certs folder", async () => {
  await withHost(async (host) => {
    await stage(host, CHAIN, KEY);
    const result = await host.run(["instance-cert-install", ID]);
    assertEquals(result.code, 0, result.stderr);
    const crt = host.path(`${CERTS_DIR}/uploaded-${ID}.crt`);
    const key = host.path(`${CERTS_DIR}/uploaded-${ID}.key`);
    assertEquals(await Deno.readTextFile(crt), CHAIN);
    assertEquals(await Deno.readTextFile(key), KEY);
    assertEquals((await Deno.stat(crt)).mode! & 0o777, 0o640);
    assertEquals((await Deno.stat(key)).mode! & 0o777, 0o640);
    assertEquals((await Deno.stat(host.path(CERTS_DIR))).mode! & 0o777, 0o750);
    // Root would hand both to root:tp (printed in test mode).
    assertEquals(
      result.stdout.match(/EXEC \[chown\] \[-h\] \[--\] \[root:tp\] \[\.\/f\]/g)
        ?.length,
      2,
    );
    // Neither file's text appears in what tp-host prints.
    assert(
      !result.stdout.includes("MC4CAQ") && !result.stderr.includes("MC4CAQ"),
    );
    // A later run replaces the pair.
    const next = block(KEY_LABEL, "MC4CAQAwBQYDK2VwBCIEIG5leHQ=");
    await stage(host, CERT, next);
    assertEquals((await host.run(["instance-cert-install", ID])).code, 0);
    assertEquals(await Deno.readTextFile(crt), CERT);
    assertEquals(await Deno.readTextFile(key), next);
  });
});

test("instance-cert-install accepts the RSA and EC key labels and an existing certs folder", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path(CERTS_DIR), { recursive: true, mode: 0o750 });
    await Deno.chmod(host.path(CERTS_DIR), 0o750);
    for (const label of ["RSA PRIVATE KEY", "EC PRIVATE KEY"]) {
      const key = block(label.replace("PRIVATE KEY", KEY_LABEL));
      await stage(host, CERT, key);
      const result = await host.run(["instance-cert-install", ID]);
      assertEquals(result.code, 0, `${label}: ${result.stderr}`);
      assertEquals(
        await Deno.readTextFile(host.path(`${CERTS_DIR}/uploaded-${ID}.key`)),
        key,
      );
    }
  });
});

test("instance-cert-install takes one certificate id and nothing that is a path", async () => {
  await withHost(async (host) => {
    await stage(host, CERT, KEY);
    for (
      const id of [
        "",
        "..",
        "../x",
        `${ID}/x`,
        "/etc/passwd",
        "-x",
        `${ID}.crt`,
        "a".repeat(36),
        "-".repeat(36),
        `${ID}0`,
        ID.slice(1),
        "instance",
      ]
    ) {
      await refused(host, ["instance-cert-install", id]);
    }
    await refused(host, ["instance-cert-install"]);
    await refused(host, ["instance-cert-install", ID, ID]);
    assertEquals(await exists(host.path(CERTS_DIR)), false);
  });
});

test("instance-cert-install refuses a staged file that is a link, a second link or missing", async () => {
  await withHost(async (host) => {
    await stage(host, CERT, KEY);
    await Deno.writeTextFile(host.path("outside/key"), KEY);
    // The key is a symlink to a file outside the staging folder.
    await Deno.remove(host.path(`${STAGE_DIR}/${ID}.key`));
    await Deno.symlink(
      host.path("outside/key"),
      host.path(`${STAGE_DIR}/${ID}.key`),
    );
    assertStringIncludes(
      await refused(host, ["instance-cert-install", ID]),
      "refusing the staged",
    );
    // A hard link to it (two names for one file).
    await Deno.remove(host.path(`${STAGE_DIR}/${ID}.key`));
    await Deno.link(
      host.path("outside/key"),
      host.path(`${STAGE_DIR}/${ID}.key`),
    );
    await refused(host, ["instance-cert-install", ID]);
    // A link to a root-only file as the certificate.
    await Deno.remove(host.path(`${STAGE_DIR}/${ID}.key`));
    await Deno.writeTextFile(host.path(`${STAGE_DIR}/${ID}.key`), KEY);
    await Deno.remove(host.path(`${STAGE_DIR}/${ID}.crt`));
    await Deno.symlink(
      host.path("outside/secret"),
      host.path(`${STAGE_DIR}/${ID}.crt`),
    );
    await refused(host, ["instance-cert-install", ID]);
    // Nothing staged at all, and no staging folder.
    await Deno.remove(host.path(STAGE_DIR), { recursive: true });
    await refused(host, ["instance-cert-install", ID]);
    // A staging folder that is itself a link.
    await Deno.mkdir(host.path("outside/stage"));
    await Deno.writeTextFile(host.path(`outside/stage/${ID}.crt`), CERT);
    await Deno.writeTextFile(host.path(`outside/stage/${ID}.key`), KEY);
    await Deno.symlink(host.path("outside/stage"), host.path(STAGE_DIR));
    await refused(host, ["instance-cert-install", ID]);
    await assertNothingInstalled(host);
  });
});

test("instance-cert-install refuses a chain or key over its size cap", async () => {
  await withHost(async (host) => {
    const line = "A".repeat(64);
    const lines = (bytes: number) =>
      Array.from({ length: Math.ceil(bytes / 65) }, () => line).join("\n");
    await stage(host, block("CERTIFICATE", lines(65_536)), KEY);
    assertStringIncludes(
      await refused(host, ["instance-cert-install", ID]),
      "over 65536 bytes",
    );
    await stage(host, CERT, block(KEY_LABEL, lines(16_384)));
    assertStringIncludes(
      await refused(host, ["instance-cert-install", ID]),
      "over 16384 bytes",
    );
    await assertNothingInstalled(host);
  });
});

test("instance-cert-install refuses anything but PEM certificates and one PEM key", async () => {
  await withHost(async (host) => {
    const bad: Array<[string, string, string]> = [
      ["an empty chain", "", KEY],
      ["an empty key", CERT, ""],
      ["a key as the chain", KEY, KEY],
      ["a certificate as the key", CERT, CERT],
      ["two keys", CERT, `${KEY}${KEY}`],
      ["a key beside the chain", `${CERT}${KEY}`, KEY],
      ["an encrypted key", CERT, block(`ENCRYPTED ${KEY_LABEL}`)],
      ["a public key", CERT, block("PUBLIC KEY")],
      ["text before the chain", `subject=CN=x\n${CERT}`, KEY],
      ["text after the key", CERT, `${KEY}trailing\n`],
      ["no END line", "-----BEGIN CERTIFICATE-----\nMIIB\n", KEY],
      [
        "a mismatched END",
        "-----BEGIN CERTIFICATE-----\nMIIB\n-----END X509 CRL-----\n",
        KEY,
      ],
      [
        "an empty block",
        "-----BEGIN CERTIFICATE-----\n-----END CERTIFICATE-----\n",
        KEY,
      ],
      ["a carriage return", CERT.replaceAll("\n", "\r\n"), KEY],
      ["a NUL", CERT.replace("MIIB", "MI\0IB"), KEY],
      ["a non-base64 line", CERT.replace("MIIB", "MI IB"), KEY],
      ["a shell line", CERT, KEY.replace("MC4C", "$(id)")],
      [
        "too many certificates",
        Array.from({ length: 11 }, () => CERT).join(""),
        KEY,
      ],
    ];
    for (const [label, cert, key] of bad) {
      await stage(host, cert, key);
      try {
        await refused(host, ["instance-cert-install", ID]);
      } catch (err) {
        throw new Error(
          `${label}: ${err instanceof Error ? err.message : err}`,
        );
      }
      await assertNothingInstalled(host);
    }
    // Ten certificates is still a chain.
    await stage(host, Array.from({ length: 10 }, () => CERT).join(""), KEY);
    assertEquals((await host.run(["instance-cert-install", ID])).code, 0);
  });
});

test("instance-cert-install refuses a certs folder that is a link or group-writable", async () => {
  await withHost(async (host) => {
    await stage(host, CERT, KEY);
    await Deno.mkdir(host.path("var/lib/turbopanel/tls"), { recursive: true });
    await Deno.mkdir(host.path("outside/certs"));
    await Deno.symlink(host.path("outside/certs"), host.path(CERTS_DIR));
    await refused(host, ["instance-cert-install", ID]);
    assertEquals([...Deno.readDirSync(host.path("outside/certs"))], []);
    await Deno.remove(host.path(CERTS_DIR));
    await Deno.mkdir(host.path(CERTS_DIR));
    await Deno.chmod(host.path(CERTS_DIR), 0o770);
    assertStringIncludes(
      await refused(host, ["instance-cert-install", ID]),
      "group- or world-writable",
    );
    await assertNothingInstalled(host);
  });
});

test("tp-host and the daemon agree on the staging folder, the certs folder and the caps", async () => {
  const script = await Deno.readTextFile(TP_HOST_SCRIPT);
  assertStringIncludes(
    script,
    `TP_INSTANCE_CERT_MAX=${INSTANCE_CERT_CHAIN_MAX_BYTES}\n`,
  );
  assertStringIncludes(
    script,
    `TP_INSTANCE_KEY_MAX=${INSTANCE_CERT_KEY_MAX_BYTES}\n`,
  );
  assertStringIncludes(
    script,
    `TP_INSTANCE_CERT_BLOCKS_MAX=${INSTANCE_CERT_CHAIN_MAX_BLOCKS}\n`,
  );
  assertStringIncludes(
    script,
    'R_INSTANCE_CERT_STAGE="$R_STATE/system/instance-certs"\n',
  );
  assertStringIncludes(script, 'R_INSTANCE_CERTS="$R_STATE/tls/certs"\n');
  const managed = { TURBOPANEL_MODE: "production" };
  assertEquals(instanceCertStageDir(managed), `/${STAGE_DIR}`);
  assertEquals(resolveInstanceCertsDir(managed), `/${CERTS_DIR}`);
});

/**
 * Runs one of tp-host's id checks, lifted from the script, on VALUE. The
 * dispatch already refuses an argument with a newline, so this proves the
 * check holds on its own: grep matches any line of a multi-line value.
 */
async function idCheck(fn: string, value: string): Promise<boolean> {
  const script = await Deno.readTextFile(TP_HOST_SCRIPT);
  const start = script.indexOf(`${fn}() {`);
  const body = script.slice(start, script.indexOf("\n}\n", start) + 3);
  const out = await new Deno.Command("sh", {
    args: ["-c", `${body}\n${fn} "$1"`, "sh", value],
  }).output();
  return out.success;
}

test("the certificate and tunnel id checks refuse a value with a second line", async () => {
  const tunnelId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
  assert(await idCheck("tp_instance_cert_id_ok", ID));
  assert(await idCheck("tp_tunnel_id_ok", tunnelId));
  assert(await idCheck("tp_tunnel_id_ok", "instance"));
  for (const value of [`${ID}\nx`, `x\n${ID}`, `${ID}\n`]) {
    assertEquals(await idCheck("tp_instance_cert_id_ok", value), false);
  }
  for (const value of [`${tunnelId}\nx`, `x\n${tunnelId}`, `${tunnelId}\n`]) {
    assertEquals(await idCheck("tp_tunnel_id_ok", value), false);
  }
});
