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
  INSTANCE_CERT_KEEP_MAX,
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
    // Root would hand both to root:tp in one call, before either is renamed
    // into place (printed in test mode).
    assertEquals(
      result.stdout.match(
        /EXEC \[chown\] \[-h\] \[--\] \[root:tp\] \[\.\/key\] \[\.\/crt\]/g,
      )?.length,
      1,
    );
    // The scratch folder is gone: only the pair is left in the certs folder.
    assertEquals(
      [...Deno.readDirSync(host.path(CERTS_DIR))].map((e) => e.name).sort(),
      [`uploaded-${ID}.crt`, `uploaded-${ID}.key`],
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
        ID.toUpperCase(),
        `${ID.slice(0, 8)}x${ID.slice(9)}`,
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
  const lift = (name: string) => {
    const start = script.indexOf(`${name}() {`);
    return script.slice(start, script.indexOf("\n}\n", start) + 3);
  };
  const body = `${lift("tp_uuid_ok")}\n${lift(fn)}`;
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
  const variants = (id: string) => [
    `${id}\nx`,
    `x\n${id}`,
    `${id}\n`,
    `\n${id}`,
    `${id}\n${id}`,
    `${id.slice(0, 18)}\n${id.slice(19)}`,
    id.toUpperCase(),
    `${id.slice(1)}-`,
    `${id.slice(0, 8)}${id.slice(9)}-`,
    "-".repeat(36),
    "a".repeat(36),
    "",
  ];
  for (const value of variants(ID)) {
    assertEquals(
      await idCheck("tp_instance_cert_id_ok", value),
      false,
      JSON.stringify(value),
    );
  }
  for (const value of variants(tunnelId)) {
    assertEquals(
      await idCheck("tp_tunnel_id_ok", value),
      false,
      JSON.stringify(value),
    );
  }
  for (const value of ["instance\n", "default\nx", "x\ninstance"]) {
    assertEquals(await idCheck("tp_tunnel_id_ok", value), false, value);
  }
});

test("the id checks match whole values with shell patterns, not grep", async () => {
  const script = await Deno.readTextFile(TP_HOST_SCRIPT);
  for (
    const fn of ["tp_uuid_ok", "tp_instance_cert_id_ok", "tp_tunnel_id_ok"]
  ) {
    const start = script.indexOf(`${fn}() {`);
    assert(start >= 0, fn);
    const body = script.slice(start, script.indexOf("\n}\n", start));
    assert(!/\bgrep\s/.test(body), `${fn} must not run grep`);
  }
});

const RETIRED = "9f8e7d6c-5b4a-4321-8fed-cba987654321";
const OTHER = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

async function certsFolder(host: Host, names: string[]) {
  await Deno.mkdir(host.path(CERTS_DIR), { recursive: true, mode: 0o750 });
  await Deno.chmod(host.path(CERTS_DIR), 0o750);
  for (const name of names) {
    await Deno.writeTextFile(host.path(`${CERTS_DIR}/${name}`), CERT);
  }
}

const listCerts = (host: Host) =>
  [...Deno.readDirSync(host.path(CERTS_DIR))].map((e) => e.name).sort();

test("instance-cert-prune removes only the uploaded pairs of ids it is not given", async () => {
  await withHost(async (host) => {
    const kept = [
      `uploaded-${ID}.crt`,
      `uploaded-${ID}.key`,
      `uploaded-${OTHER}.crt`,
      `uploaded-${OTHER}.key`,
    ];
    const untouched = [
      "uploaded.crt",
      "uploaded.key",
      "platform-ca.crt",
      "platform-ca.key",
      "letsencrypt-panel.example.crt",
      `uploaded-${RETIRED.toUpperCase()}.crt`,
      `uploaded-${RETIRED}.pem`,
      `uploaded-${RETIRED}.crt.bak`,
      `xuploaded-${RETIRED}.crt`,
    ];
    await certsFolder(host, [
      ...kept,
      ...untouched,
      `uploaded-${RETIRED}.crt`,
      `uploaded-${RETIRED}.key`,
    ]);
    const result = await host.run(["instance-cert-prune", ID, OTHER]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(listCerts(host), [...kept, ...untouched].sort());
    // A second run has nothing to do.
    assertEquals((await host.run(["instance-cert-prune", ID, OTHER])).code, 0);
    assertEquals(listCerts(host), [...kept, ...untouched].sort());
    // No id in use: every uploaded pair goes, nothing else does.
    assertEquals((await host.run(["instance-cert-prune"])).code, 0);
    assertEquals(listCerts(host), untouched.sort());
  });
});

test("instance-cert-prune removes a link itself, never its target, and never a folder", async () => {
  await withHost(async (host) => {
    await certsFolder(host, []);
    await Deno.writeTextFile(host.path("outside/secret"), "keep me\n");
    await Deno.symlink(
      host.path("outside/secret"),
      host.path(`${CERTS_DIR}/uploaded-${RETIRED}.key`),
    );
    await Deno.mkdir(host.path("outside/dir"));
    await Deno.writeTextFile(host.path("outside/dir/x"), "x\n");
    await Deno.symlink(
      host.path("outside/dir"),
      host.path(`${CERTS_DIR}/uploaded-${OTHER}.key`),
    );
    await Deno.mkdir(host.path(`${CERTS_DIR}/uploaded-${RETIRED}.crt`));
    await Deno.writeTextFile(
      host.path(`${CERTS_DIR}/uploaded-${RETIRED}.crt/x`),
      "x\n",
    );
    const result = await host.run(["instance-cert-prune", ID]);
    assertEquals(result.code, 0, result.stderr);
    assertEquals(listCerts(host), [`uploaded-${RETIRED}.crt`]);
    assertEquals(
      await Deno.readTextFile(host.path("outside/secret")),
      "keep me\n",
    );
    assertEquals(await Deno.readTextFile(host.path("outside/dir/x")), "x\n");
    assertEquals(
      await Deno.readTextFile(
        host.path(`${CERTS_DIR}/uploaded-${RETIRED}.crt/x`),
      ),
      "x\n",
    );
  });
});

test("instance-cert-prune refuses a bad id, a linked or writable folder, and too many ids", async () => {
  await withHost(async (host) => {
    // No certs folder yet: nothing to do.
    assertEquals((await host.run(["instance-cert-prune", ID])).code, 0);
    await certsFolder(host, [`uploaded-${RETIRED}.crt`]);
    for (
      const id of [
        "",
        "../x",
        `${ID}/x`,
        "*",
        "uploaded-*",
        ID.toUpperCase(),
        `${ID}.crt`,
        "instance",
      ]
    ) {
      await refused(host, ["instance-cert-prune", id]);
      await refused(host, ["instance-cert-prune", ID, id]);
    }
    await refused(
      host,
      ["instance-cert-prune", ...Array.from({ length: 65 }, () => ID)],
    );
    assertEquals(
      (await host.run([
        "instance-cert-prune",
        ...Array.from({ length: 64 }, () => RETIRED),
      ])).code,
      0,
    );
    await Deno.chmod(host.path(CERTS_DIR), 0o770);
    assertStringIncludes(
      await refused(host, ["instance-cert-prune", ID]),
      "group- or world-writable",
    );
    await Deno.chmod(host.path(CERTS_DIR), 0o750);
    assertEquals(listCerts(host), [`uploaded-${RETIRED}.crt`]);
    // A certs folder that is a link to somewhere else.
    await Deno.remove(host.path(CERTS_DIR), { recursive: true });
    await Deno.mkdir(host.path("outside/certs"));
    await Deno.writeTextFile(
      host.path(`outside/certs/uploaded-${RETIRED}.crt`),
      CERT,
    );
    await Deno.symlink(host.path("outside/certs"), host.path(CERTS_DIR));
    await refused(host, ["instance-cert-prune", ID]);
    assertEquals(
      [...Deno.readDirSync(host.path("outside/certs"))].map((e) => e.name),
      [`uploaded-${RETIRED}.crt`],
    );
  });
});

test("tp-host and the daemon agree on how many ids instance-cert-prune takes", async () => {
  const script = await Deno.readTextFile(TP_HOST_SCRIPT);
  assertStringIncludes(
    script,
    `TP_INSTANCE_CERT_KEEP_MAX=${INSTANCE_CERT_KEEP_MAX}\n`,
  );
});

test("instance-cert-install renames the key into place before the chain", async () => {
  const script = await Deno.readTextFile(TP_HOST_SCRIPT);
  const start = script.indexOf("tp_verb_instance_cert_install() {");
  const body = script.slice(start, script.indexOf("\n}\n", start));
  const key = body.indexOf('mv -T -f -- ./key "../uploaded-$1.key"');
  const crt = body.indexOf('mv -T -f -- ./crt "../uploaded-$1.crt"');
  assert(key > 0 && crt > key, "the key is renamed in first");
  // Both are written before either rename.
  const writes = Math.max(
    body.indexOf("cat > ./key"),
    body.indexOf("cat > ./crt"),
  );
  assert(writes > 0 && writes < key, "both files are written before a rename");
});

const TLS_DIR = "var/lib/turbopanel/tls";

test("no generic verb reaches the TLS folder but the CA pin and the Let's Encrypt pairs", async () => {
  await withHost(async (host) => {
    await Deno.mkdir(host.path(CERTS_DIR), { recursive: true, mode: 0o750 });
    await Deno.chmod(host.path(CERTS_DIR), 0o750);
    await Deno.writeTextFile(host.path("tmp/staged"), "x\n");
    for (
      const name of ["ca.key", "ca.crt", "certs/platform-ca.key", "certs/x"]
    ) {
      await Deno.writeTextFile(host.path(`${TLS_DIR}/${name}`), "x\n");
    }
    await Deno.writeTextFile(
      host.path(`${CERTS_DIR}/uploaded-${ID}.key`),
      KEY,
    );
    const refusedPaths = [
      `${TLS_DIR}/ca.key`,
      `${TLS_DIR}/ca.crt`,
      `${TLS_DIR}/ca-bundle.pem`,
      `${CERTS_DIR}/uploaded-${ID}.key`,
      `${CERTS_DIR}/uploaded-${ID}.crt`,
      `${CERTS_DIR}/platform-ca.key`,
      `${CERTS_DIR}/letsencrypt-.key`,
      `${CERTS_DIR}/letsencrypt-a_b.key`,
      `${CERTS_DIR}/letsencrypt-a.pem`,
      `${CERTS_DIR}/x`,
    ].map((rel) => host.path(rel));
    for (const path of refusedPaths) {
      const staged = host.path("tmp/staged");
      for (
        const argv of [
          ["install", "-m", "0640", "-o", "tp", "-g", "tp", staged, path],
          ["rm", "-f", "--", path],
          ["chmod", "0644", path],
          ["chown", "tp:tp", path],
          ["cat", "--", path],
          ["tee", path],
          ["cp", staged, path],
        ]
      ) {
        await refused(host, argv, "x\n");
      }
    }
    for (const dir of [TLS_DIR, CERTS_DIR]) {
      await refused(host, ["rm", "-rf", "--", host.path(dir)]);
      await refused(host, ["chown", "tp:tp", host.path(dir)]);
      await refused(host, ["install", "-d", "-m", "0750", host.path(dir)]);
    }
    // Nothing was written, removed or replaced.
    assertEquals(
      await Deno.readTextFile(host.path(`${TLS_DIR}/ca.key`)),
      "x\n",
    );
    assertEquals(
      await Deno.readTextFile(host.path(`${CERTS_DIR}/uploaded-${ID}.key`)),
      KEY,
    );
    // The daemon's own CA pin file, through writeDaemonFile's fallback.
    const pin = host.path(`${TLS_DIR}/instance-ca-pin`);
    const staged = host.path("tmp/staged");
    const pinned = await host.run([
      "install",
      "-m",
      "0600",
      "-o",
      "tp",
      "-g",
      "tp",
      staged,
      pin,
    ]);
    assertEquals(pinned.code, 0, pinned.stderr);
    assertEquals(await Deno.readTextFile(pin), "x\n");
    // A Let's Encrypt pair the daemon installs and reads back.
    const le = host.path(`${CERTS_DIR}/letsencrypt-panel.example.com.key`);
    for (
      const argv of [
        ["install", "-m", "0600", "-o", "tp", "-g", "tp", "--", staged, le],
        ["chown", ":tp", le],
        ["chmod", "0600", le],
        ["cat", "--", le],
      ]
    ) {
      const result = await host.run(argv);
      assertEquals(result.code, 0, `${argv[0]}: ${result.stderr}`);
    }
  });
});
