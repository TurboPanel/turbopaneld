import { assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { INSTANCE_CERTS_APPLY_PLAYBOOK } from "../orchestration/assets.ts";
import { PROD_INSTANCE_DIR_DEFAULT } from "../paths/layout.ts";
import {
  ansibleHostname,
  applyPublicUrls,
  installUploadedCertViaHost,
  INSTANCE_CERT_KEEP_MAX,
  instanceCertStageDir,
  pruneUploadedCertsDirect,
  pruneUploadedCertsViaHost,
  pruneUploadedInstanceCerts,
  resolveInstanceCertsDir,
  resolveInstanceDir,
  runInstanceCertsApply,
  staleUploadedCertFiles,
  uploadedCertIdsInUse,
  uploadedCertPair,
  upsertPublicUrlsInEnv,
  writeUploadedCertDirect,
  writeUploadedInstanceCerts,
} from "./public-urls-apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("resolveInstanceDir uses INSTANCE_REPO checkout in development", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_MODE: "development",
      TURBOPANEL_DEV_ROOT: "/home/dev",
      TURBOPANEL_INSTANCE_REPO: "/home/dev/turbopanel",
    }),
    "/home/dev/turbopanel",
  );
});

test("resolveInstanceDir falls back to <devRoot>/turbopanel in development", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_MODE: "development",
      TURBOPANEL_DEV_ROOT: "/home/dev",
    }),
    "/home/dev/turbopanel",
  );
});

test("resolveInstanceDir uses FHS lib path when not co-located", () => {
  assertEquals(
    resolveInstanceDir({
      // No DEV_USER / INSTANCE_REPO / MODE=development → managed FHS tree.
      HOME: "/root",
      TURBOPANEL_DEV_ROOT: undefined,
    }),
    PROD_INSTANCE_DIR_DEFAULT,
  );
});

test("resolveInstanceDir honors TURBOPANEL_INSTANCE_DIR override", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_MODE: "development",
      TURBOPANEL_INSTANCE_DIR: "/custom/instance/",
      TURBOPANEL_INSTANCE_REPO: "/home/dev/turbopanel",
    }),
    "/custom/instance",
  );
});

test("resolveInstanceDir treats TURBOPANEL_DEV_USER as co-located", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_DEV_USER: "dev",
      TURBOPANEL_DEV_ROOT: "/home/dev",
    }),
    "/home/dev/turbopanel",
  );
});

test("resolveInstanceDir treats TURBOPANEL_DEV_INSTANCE=1 as co-located", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_DEV_INSTANCE: "1",
      TURBOPANEL_DEV_ROOT: "/home/dev",
    }),
    "/home/dev/turbopanel",
  );
});

test("resolveInstanceDir strips repeated trailing slashes including root-only", () => {
  assertEquals(
    resolveInstanceDir({
      TURBOPANEL_INSTANCE_DIR: "////",
    }),
    "/",
  );
});

async function listEnvTmpFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith(".env.tmp-")) {
      found.push(entry.name);
    }
  }
  return found;
}

test("upsertPublicUrlsInEnv writes public URLs to protected runtime env", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-public-urls-" });
  const checkoutDir = join(root, "checkout", "turbopanel");
  const configDir = join(root, "config", "instance");
  const runtimeEnvPath = join(configDir, "runtime.env");
  await Deno.mkdir(checkoutDir, { recursive: true });

  try {
    await upsertPublicUrlsInEnv(["https://panel.example.com"], {
      runtimeEnvPath,
    });

    const content = await Deno.readTextFile(runtimeEnvPath);
    assertEquals(
      content.includes("TURBOPANEL_PUBLIC_URLS=https://panel.example.com"),
      true,
    );
    assertEquals(await listEnvTmpFiles(checkoutDir), []);
    assertEquals(await listEnvTmpFiles(configDir), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("upsertPublicUrlsInEnv removes temp files when rename fails", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-public-urls-fail-" });
  const checkoutDir = join(root, "checkout", "turbopanel");
  const configDir = join(root, "config", "instance");
  const runtimeEnvPath = join(configDir, "runtime.env");
  await Deno.mkdir(checkoutDir, { recursive: true });
  await Deno.mkdir(runtimeEnvPath, { recursive: true });

  try {
    let threw = false;
    try {
      await upsertPublicUrlsInEnv(["https://panel.example.com"], {
        runtimeEnvPath,
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true);
    assertEquals(await listEnvTmpFiles(checkoutDir), []);

    for await (const entry of Deno.readDir(configDir)) {
      assertEquals(entry.name.startsWith("runtime.env.tmp-"), false);
    }
    assertEquals(
      await Deno.stat(join(configDir, ".write-tmp")).then(
        () => true,
        () => false,
      ),
      false,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test({
  name: "runInstanceCertsApply builds playbook extras via stubbed runPlaybook",
  permissions: { env: true },
  fn: async () => {
    const originalDevUser = Deno.env.get("TURBOPANEL_DEV_USER");
    const originalDevRoot = Deno.env.get("TURBOPANEL_DEV_ROOT");
    Deno.env.set("TURBOPANEL_DEV_USER", "dev");
    Deno.env.set("TURBOPANEL_DEV_ROOT", "/home/dev");
    const calls: Array<{ playbook: string; args: string[] }> = [];
    try {
      await runInstanceCertsApply("/home/dev/turbopanel", [
        { host: "https://a.example", source: "platform-ca" },
        { host: "https://b.example", source: "platform-ca" },
      ], {
        readForwardHosts: () => "",
        instanceAcme: {
          contactEmail: "acme@example.com",
          tosAccepted: true,
          directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
          useStaging: false,
        },
        runPlaybook: (playbook, extraArgs = []) => {
          calls.push({ playbook, args: [...extraArgs] });
          return Promise.resolve();
        },
      });
      assertEquals(calls.length, 1);
      assertEquals(calls[0]!.playbook, INSTANCE_CERTS_APPLY_PLAYBOOK);
      assertEquals(
        calls[0]!.args.includes("turbopanel_instance_dir=/home/dev/turbopanel"),
        true,
      );
      assertEquals(
        calls[0]!.args.includes(
          "turbopanel_public_urls=https://a.example,https://b.example",
        ),
        true,
      );
      assertEquals(
        calls[0]!.args.includes("turbopanel_dev_user=dev"),
        true,
      );
      // resolve-hostnames.yml decodes this value; it must be the full list,
      // in order, as a JSON array behind a key= (tp-orchestrate refuses a
      // bare JSON object extra-var).
      const hostnamesJson = calls[0]!.args.find((arg) =>
        arg.startsWith("turbopanel_hostnames_json=")
      );
      if (hostnamesJson === undefined) {
        throw new TypeError("turbopanel_hostnames_json extra-var missing");
      }
      assertEquals(
        JSON.parse(hostnamesJson.slice("turbopanel_hostnames_json=".length)),
        [
          { host: "https://a.example", source: "platform-ca", cert_id: "" },
          { host: "https://b.example", source: "platform-ca", cert_id: "" },
        ],
      );
      const valueIndex = calls[0]!.args.indexOf(hostnamesJson);
      assertEquals(calls[0]!.args[valueIndex - 1], "-e");
      assertEquals(
        calls[0]!.args.includes("turbopanel_acme_email=acme@example.com"),
        true,
      );
      assertEquals(
        calls[0]!.args.includes(
          "turbopanel_acme_directory=https://acme-v02.api.letsencrypt.org/directory",
        ),
        true,
      );
      assertEquals(
        calls[0]!.args.some((arg) => arg.startsWith("{")),
        false,
      );
      assertEquals(
        calls[0]!.args.join(" ").includes("TURBOPANEL_TLS_CA_ROTATE"),
        false,
      );
    } finally {
      if (originalDevUser === undefined) Deno.env.delete("TURBOPANEL_DEV_USER");
      else Deno.env.set("TURBOPANEL_DEV_USER", originalDevUser);
      if (originalDevRoot === undefined) Deno.env.delete("TURBOPANEL_DEV_ROOT");
      else Deno.env.set("TURBOPANEL_DEV_ROOT", originalDevRoot);
    }
  },
});

test({
  name:
    "runInstanceCertsApply omits turbopanel_public_urls when no platform-ca hosts exist (not co-located dev)",
  permissions: { env: true },
  fn: async () => {
    // A managed host whose only hostname is lets-encrypt-sourced computes an
    // empty platform-ca list. tp-orchestrate's tp_host_list_ok refuses an
    // empty extra-var value outright, so the flag must be omitted rather
    // than sent as `turbopanel_public_urls=`. Reproduces the apply failure
    // seen against a real managed host with exactly this hostname shape.
    const originalDevUser = Deno.env.get("TURBOPANEL_DEV_USER");
    Deno.env.delete("TURBOPANEL_DEV_USER");
    const calls: Array<{ playbook: string; args: string[] }> = [];
    try {
      await runInstanceCertsApply("/opt/turbopanel", [
        {
          host: "https://canary.turbopanel.dev:8443",
          source: "lets-encrypt",
        },
      ], {
        readForwardHosts: () => "",
        instanceAcme: {
          contactEmail: "noc@turbopanel.io",
          tosAccepted: true,
          directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
          useStaging: false,
        },
        runPlaybook: (playbook, extraArgs = []) => {
          calls.push({ playbook, args: [...extraArgs] });
          return Promise.resolve();
        },
      });
      assertEquals(calls.length, 1);
      assertEquals(
        calls[0]!.args.some((arg) => arg.startsWith("turbopanel_public_urls")),
        false,
      );
    } finally {
      if (originalDevUser === undefined) {
        Deno.env.delete("TURBOPANEL_DEV_USER");
      } else Deno.env.set("TURBOPANEL_DEV_USER", originalDevUser);
    }
  },
});

test({
  name: "applyPublicUrls upserts env then invokes certs apply stub",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-apply-urls-" });
    const originalConfigDir = Deno.env.get("TURBOPANEL_CONFIG_DIR");
    const originalInstanceDir = Deno.env.get("TURBOPANEL_INSTANCE_DIR");
    Deno.env.set("TURBOPANEL_INSTANCE_DIR", join(root, "instance-src"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", root);
    await Deno.mkdir(join(root, "instance"), { recursive: true });

    const certCalls: Array<{
      dir: string;
      hosts: string[];
    }> = [];
    try {
      await applyPublicUrls([{
        host: "https://apply.example",
        source: "platform-ca",
      }], {
        pruneUploadedCerts: () => Promise.resolve(),
        runCertsApply: (instanceDir, hostnames) => {
          certCalls.push({
            dir: instanceDir,
            hosts: hostnames.map((entry) => entry.host),
          });
          return Promise.resolve();
        },
      });
      const expectedEnv = join(root, "instance", "runtime.env");
      const content = await Deno.readTextFile(expectedEnv);
      assertEquals(
        content.includes("TURBOPANEL_PUBLIC_URLS=https://apply.example"),
        true,
      );
      assertEquals(certCalls.length, 1);
      assertEquals(certCalls[0]!.dir, join(root, "instance-src"));
      assertEquals(certCalls[0]!.hosts, ["https://apply.example"]);
    } finally {
      if (originalConfigDir === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else {
        Deno.env.set("TURBOPANEL_CONFIG_DIR", originalConfigDir);
      }
      if (originalInstanceDir === undefined) {
        Deno.env.delete("TURBOPANEL_INSTANCE_DIR");
      } else {
        Deno.env.set("TURBOPANEL_INSTANCE_DIR", originalInstanceDir);
      }
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "applyPublicUrls stops before certs apply when HTTP-01 preflight fails",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-apply-preflight-" });
    const originalConfigDir = Deno.env.get("TURBOPANEL_CONFIG_DIR");
    const originalInstanceDir = Deno.env.get("TURBOPANEL_INSTANCE_DIR");
    Deno.env.set("TURBOPANEL_INSTANCE_DIR", join(root, "instance-src"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", root);
    await Deno.mkdir(join(root, "instance"), { recursive: true });
    let certs = 0;
    try {
      await assertRejects(
        () =>
          applyPublicUrls([{
            host: "https://panel.example.com",
            source: "lets-encrypt",
          }], {
            preflightLetsEncrypt: () =>
              Promise.reject(
                new Error(
                  "Let's Encrypt HTTP-01 preflight failed for panel.example.com: http://panel.example.com/.well-known/acme-challenge/abc did not reach the instance ACME issuer (HTTP 404)",
                ),
              ),
            openWindow: () => Promise.resolve(),
            closeWindow: () => Promise.resolve(),
            instanceAcme: {
              contactEmail: "acme@example.com",
              tosAccepted: true,
              directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
              useStaging: false,
            },
            pruneUploadedCerts: () => Promise.resolve(),
            runCertsApply: () => {
              certs += 1;
              return Promise.resolve();
            },
          }),
        Error,
        "did not reach the instance ACME issuer",
      );
    } finally {
      if (originalConfigDir === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else Deno.env.set("TURBOPANEL_CONFIG_DIR", originalConfigDir);
      if (originalInstanceDir === undefined) {
        Deno.env.delete("TURBOPANEL_INSTANCE_DIR");
      } else Deno.env.set("TURBOPANEL_INSTANCE_DIR", originalInstanceDir);
      await Deno.remove(root, { recursive: true });
    }
    assertEquals(certs, 0);
  },
});

test({
  name: "applyPublicUrls issues Let's Encrypt before certs apply",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-apply-order-" });
    const originalConfigDir = Deno.env.get("TURBOPANEL_CONFIG_DIR");
    const originalInstanceDir = Deno.env.get("TURBOPANEL_INSTANCE_DIR");
    Deno.env.set("TURBOPANEL_INSTANCE_DIR", join(root, "instance-src"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", root);
    await Deno.mkdir(join(root, "instance"), { recursive: true });
    const order: string[] = [];
    try {
      await applyPublicUrls([{
        host: "https://panel.example.com",
        source: "lets-encrypt",
      }], {
        instanceAcme: {
          contactEmail: "acme@example.com",
          tosAccepted: true,
          directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
          useStaging: false,
        },
        openWindow: () => {
          order.push("open");
          return Promise.resolve();
        },
        preflightLetsEncrypt: () => {
          order.push("preflight");
          return Promise.resolve();
        },
        issueLetsEncrypt: () => {
          order.push("issue");
          return Promise.resolve();
        },
        pruneUploadedCerts: () => Promise.resolve(),
        runCertsApply: () => {
          order.push("certs");
          return Promise.resolve();
        },
      });
      assertEquals(order, ["open", "preflight", "issue", "certs"]);
    } finally {
      if (originalConfigDir === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else Deno.env.set("TURBOPANEL_CONFIG_DIR", originalConfigDir);
      if (originalInstanceDir === undefined) {
        Deno.env.delete("TURBOPANEL_INSTANCE_DIR");
      } else Deno.env.set("TURBOPANEL_INSTANCE_DIR", originalInstanceDir);
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "applyPublicUrls closes the window when opening fails",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    const failures = [
      "hosting Caddy lost its admin socket",
      "something unrelated broke",
    ];
    for (const message of failures) {
      const root = await Deno.makeTempDir({ prefix: "tp-apply-open-" });
      const originalConfigDir = Deno.env.get("TURBOPANEL_CONFIG_DIR");
      const originalInstanceDir = Deno.env.get("TURBOPANEL_INSTANCE_DIR");
      Deno.env.set("TURBOPANEL_INSTANCE_DIR", join(root, "instance-src"));
      Deno.env.set("TURBOPANEL_CONFIG_DIR", root);
      await Deno.mkdir(join(root, "instance"), { recursive: true });
      let closed = 0;
      let certs = 0;
      try {
        await assertRejects(
          () =>
            applyPublicUrls([{
              host: "https://panel.example.com",
              source: "lets-encrypt",
            }], {
              instanceAcme: {
                contactEmail: "acme@example.com",
                tosAccepted: true,
                directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
                useStaging: false,
              },
              openWindow: () => Promise.reject(new Error(message)),
              closeWindow: () => {
                closed += 1;
                return Promise.resolve();
              },
              pruneUploadedCerts: () => Promise.resolve(),
              runCertsApply: () => {
                certs += 1;
                return Promise.resolve();
              },
            }),
          Error,
          message,
        );
      } finally {
        if (originalConfigDir === undefined) {
          Deno.env.delete("TURBOPANEL_CONFIG_DIR");
        } else Deno.env.set("TURBOPANEL_CONFIG_DIR", originalConfigDir);
        if (originalInstanceDir === undefined) {
          Deno.env.delete("TURBOPANEL_INSTANCE_DIR");
        } else Deno.env.set("TURBOPANEL_INSTANCE_DIR", originalInstanceDir);
        await Deno.remove(root, { recursive: true });
      }
      assertEquals(closed, 1);
      assertEquals(certs, 0);
    }
  },
});

test({
  name: "applyPublicUrls holds the ACME window lock around issuance",
  permissions: { read: true, write: true, env: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-apply-lock-" });
    const originalConfigDir = Deno.env.get("TURBOPANEL_CONFIG_DIR");
    const originalInstanceDir = Deno.env.get("TURBOPANEL_INSTANCE_DIR");
    Deno.env.set("TURBOPANEL_INSTANCE_DIR", join(root, "instance-src"));
    Deno.env.set("TURBOPANEL_CONFIG_DIR", root);
    await Deno.mkdir(join(root, "instance"), { recursive: true });
    let inside = false;
    let openedInside = false;
    try {
      await applyPublicUrls([{
        host: "https://panel.example.com",
        source: "lets-encrypt",
      }], {
        instanceAcme: {
          contactEmail: "acme@example.com",
          tosAccepted: true,
          directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
          useStaging: false,
        },
        withLock: async (fn) => {
          inside = true;
          try {
            return await fn();
          } finally {
            inside = false;
          }
        },
        openWindow: () => {
          openedInside = inside;
          return Promise.resolve();
        },
        preflightLetsEncrypt: () => Promise.resolve(),
        issueLetsEncrypt: () => Promise.resolve(),
        closeWindow: () => Promise.resolve(),
        pruneUploadedCerts: () => Promise.resolve(),
        runCertsApply: () => Promise.resolve(),
      });
      assertEquals(openedInside, true);
      assertEquals(inside, false);
    } finally {
      if (originalConfigDir === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else Deno.env.set("TURBOPANEL_CONFIG_DIR", originalConfigDir);
      if (originalInstanceDir === undefined) {
        Deno.env.delete("TURBOPANEL_INSTANCE_DIR");
      } else Deno.env.set("TURBOPANEL_INSTANCE_DIR", originalInstanceDir);
      await Deno.remove(root, { recursive: true });
    }
  },
});

const CERT_ENV_KEYS = [
  "TURBOPANEL_DEV_USER",
  "TURBOPANEL_DEV_ROOT",
  "TURBOPANEL_DEV_INSTANCE",
  "TURBOPANEL_MODE",
  "TURBOPANEL_CONFIG_DIR",
  "TURBOPANEL_INSTANCE_DIR",
] as const;

/** RFC 5737 address standing in for the Vagrant host LAN forward. */
const VAGRANT_HOST_LAN = "192.0.2.10";

const instanceCertScript = join(
  dirname(dirname(dirname(dirname(fromFileUrl(import.meta.url))))),
  "turbopanel",
  "scripts",
  "generate-self-signed-cert.mjs",
);

function rememberEnv(
  keys: readonly string[],
): Map<string, string | undefined> {
  return new Map(keys.map((key) => [key, Deno.env.get(key)]));
}

function restoreEnv(saved: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) Deno.env.delete(key);
    else Deno.env.set(key, value);
  }
}

function isExecutable(path: string): boolean {
  try {
    const info = Deno.statSync(path);
    return info.isFile && ((info.mode ?? 0) & 0o111) !== 0;
  } catch {
    return false;
  }
}

function nodeBinary(): string | undefined {
  const fromPath = (Deno.env.get("PATH") ?? "").split(":")
    .filter((dir) => dir.length > 0)
    .map((dir) => join(dir, "node"));
  return [
    "/opt/turbopanel/vendor/node/current/bin/node",
    ...fromPath,
  ].find(isExecutable);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/** Mint a leaf from the extra-var the apply passed and require the LAN SAN. */
async function assertLanAddressOnLeaf(publicUrls: string): Promise<void> {
  const node = nodeBinary();
  if (!node || !(await fileExists(instanceCertScript))) return;
  const root = await Deno.makeTempDir({ prefix: "tp-lan-san-" });
  const certs = join(root, "certs");
  const state = join(root, "state");
  const runtimeEnv = join(root, "runtime.env");
  await Deno.writeTextFile(runtimeEnv, "");
  try {
    const generated = await new Deno.Command(node, {
      args: [instanceCertScript],
      cwd: root,
      clearEnv: true,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: root,
        TURBOPANEL_PUBLIC_URLS: publicUrls,
        TURBOPANEL_TLS_CERTS_DIR: certs,
        TURBOPANEL_STATE_DIR: state,
        TURBOPANEL_TLS_CA: join(state, "tls", "ca.crt"),
        TURBOPANEL_TLS_CA_KEY: join(state, "tls", "ca.key"),
        TURBOPANEL_TLS_CA_BUNDLE: join(state, "tls", "ca-bundle.pem"),
        TURBOPANEL_INSTANCE_RUNTIME_ENV: runtimeEnv,
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!generated.success) {
      throw new TypeError(new TextDecoder().decode(generated.stderr));
    }
    const san = await new Deno.Command("openssl", {
      args: [
        "x509",
        "-in",
        join(certs, "self-signed.crt"),
        "-noout",
        "-ext",
        "subjectAltName",
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    const text = new TextDecoder().decode(san.stdout);
    if (!san.success || !text.includes(VAGRANT_HOST_LAN)) {
      throw new TypeError(text || new TextDecoder().decode(san.stderr));
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test({
  name: "managed cert apply leaves forwarded LAN names off the leaf list",
  permissions: { env: true },
  fn: async () => {
    const saved = rememberEnv(CERT_ENV_KEYS);
    Deno.env.delete("TURBOPANEL_DEV_USER");
    Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
    Deno.env.delete("TURBOPANEL_MODE");
    const calls: Array<{ args: string[] }> = [];
    try {
      await runInstanceCertsApply("/opt/turbopanel", [{
        host: "https://panel.example.com:8443",
        source: "platform-ca",
      }], {
        readForwardHosts: () => `${VAGRANT_HOST_LAN}\n`,
        runPlaybook: (_playbook, extraArgs = []) => {
          calls.push({ args: [...extraArgs] });
          return Promise.resolve();
        },
      });
      assertEquals(calls.length, 1);
      assertEquals(
        calls[0]?.args.includes(
          "turbopanel_public_urls=https://panel.example.com:8443",
        ),
        true,
      );
      const hostnames = calls[0]?.args.find((arg) =>
        arg.includes("turbopanel_hostnames")
      );
      assertEquals(hostnames?.includes(VAGRANT_HOST_LAN), false);
    } finally {
      restoreEnv(saved);
    }
  },
});

test({
  name:
    "admin hostname apply keeps the Vagrant host LAN address on the certificate",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-admin-lan-" });
    const saved = rememberEnv(CERT_ENV_KEYS);
    const operator = "https://panel.example.com:8443";
    Deno.env.set("TURBOPANEL_DEV_USER", "vagrant");
    Deno.env.set("TURBOPANEL_DEV_ROOT", "/home/vagrant");
    Deno.env.set("TURBOPANEL_MODE", "development");
    Deno.env.delete("TURBOPANEL_DEV_INSTANCE");
    Deno.env.set("TURBOPANEL_CONFIG_DIR", root);
    Deno.env.delete("TURBOPANEL_INSTANCE_DIR");
    const calls: Array<{ args: string[] }> = [];
    try {
      await applyPublicUrls([{ host: operator, source: "platform-ca" }], {
        readForwardHosts: () => `${VAGRANT_HOST_LAN}\n`,
        runPlaybook: (_playbook, extraArgs = []) => {
          calls.push({ args: [...extraArgs] });
          return Promise.resolve();
        },
      });
      const runtime = await Deno.readTextFile(
        join(root, "instance", "runtime.env"),
      );
      assertEquals(
        runtime.includes(`TURBOPANEL_PUBLIC_URLS=${operator}`),
        true,
      );
      assertEquals(runtime.includes(VAGRANT_HOST_LAN), false);
      const publicUrls = calls[0]?.args.find((arg) =>
        arg.startsWith("turbopanel_public_urls=")
      );
      assertEquals(
        publicUrls,
        `turbopanel_public_urls=${operator},${VAGRANT_HOST_LAN}`,
      );
      const hostnames = calls[0]?.args.find((arg) =>
        arg.includes("turbopanel_hostnames")
      );
      assertEquals(hostnames?.includes(operator), true);
      assertEquals(hostnames?.includes(VAGRANT_HOST_LAN), false);
      await assertLanAddressOnLeaf(
        publicUrls?.slice("turbopanel_public_urls=".length) ?? "",
      );
    } finally {
      restoreEnv(saved);
      await Deno.remove(root, { recursive: true });
    }
  },
});

test("upsertPublicUrlsInEnv creates no folder beside runtime.env (sealed config root)", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-public-urls-flat-" });
  const configDir = join(root, "config", "instance");
  const runtimeEnvPath = join(configDir, "runtime.env");
  try {
    await Deno.mkdir(configDir, { recursive: true });
    await upsertPublicUrlsInEnv(["https://panel.example.com"], {
      runtimeEnvPath,
    });
    const names: string[] = [];
    for await (const entry of Deno.readDir(configDir)) names.push(entry.name);
    assertEquals(names, ["runtime.env"]);
    const source = await Deno.readTextFile(
      new URL("./public-urls-env.ts", import.meta.url),
    );
    assertEquals(source.includes(".write-tmp"), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("a hostname row carries public_port only for a valid port", () => {
  const base = {
    host: "https://panel.example.com:8443",
    source: "platform-ca",
  } as const;
  assertEquals(ansibleHostname({ ...base, publicPort: 443 }), {
    host: base.host,
    source: "platform-ca",
    cert_id: "",
    public_port: 443,
  });
  assertEquals(
    ansibleHostname({ ...base, publicPort: 8443 }).public_port,
    8443,
  );
  for (const publicPort of [undefined, 0, 65536, 44.3, Number.NaN]) {
    assertEquals(
      "public_port" in ansibleHostname({ ...base, publicPort }),
      false,
    );
  }
});

const EDGE_TRUST = {
  cidrs: ["198.51.100.0/24", "203.0.113.7/32"],
  hash: "b".repeat(64),
  cloudflare: ["198.51.100.0/24"],
  bunny: ["203.0.113.7/32"],
};

async function certsApplyArgs(
  edgeTrust: typeof EDGE_TRUST | undefined,
): Promise<string[]> {
  let captured: string[] = [];
  await runInstanceCertsApply("/opt/turbopanel", [], {
    readForwardHosts: () => "",
    env: {},
    edgeTrust,
    runPlaybook: (_playbook, extraArgs = []) => {
      captured = [...extraArgs];
      return Promise.resolve();
    },
  });
  return captured;
}

test("an apply without edgeTrust passes no edge extra-var, so the persisted set stays", async () => {
  const args = await certsApplyArgs(undefined);
  assertEquals(
    args.some((a) => a.startsWith("turbopanel_edge_trust_json=")),
    false,
  );
});

test("an apply with edgeTrust passes the per-provider lists and the hash only", async () => {
  const args = await certsApplyArgs(EDGE_TRUST);
  const value = args.find((a) => a.startsWith("turbopanel_edge_trust_json="));
  assertEquals(
    JSON.parse(value!.slice("turbopanel_edge_trust_json=".length)),
    {
      hash: EDGE_TRUST.hash,
      cloudflare: EDGE_TRUST.cloudflare,
      bunny: EDGE_TRUST.bunny,
    },
  );
});

test("an edge range that is not a CIDR literal is refused before the playbook runs", async () => {
  await assertRejects(
    () =>
      certsApplyArgs({
        ...EDGE_TRUST,
        cloudflare: ["1.2.3.0/24; id"],
        cidrs: ["1.2.3.0/24; id"],
      }),
    Error,
    "refusing edge range",
  );
  await assertRejects(
    () => certsApplyArgs({ ...EDGE_TRUST, cloudflare: ["192.0.2.0/24"] }),
    Error,
    "not in the union",
  );
});

test("edge ranges that are catch-all, loopback or private are refused on the daemon", async () => {
  const bad = [
    "0.0.0.0/0",
    "::/0",
    "10.0.0.0/8",
    "127.0.0.0/8",
    "192.168.1.0/24",
    "fc00::/7",
    "::1/128",
    "1.0.0.0/7",
  ];
  await Promise.all(bad.map((range) =>
    assertRejects(
      () =>
        certsApplyArgs({
          ...EDGE_TRUST,
          cidrs: [range],
          cloudflare: [range],
          bunny: [],
        }),
      Error,
      "refusing edge range",
    )
  ));
});

// --- uploaded certificate pairs -----------------------------------------------

const CERT_ID = "01a1a47c-5b2d-7e3f-9a4b-6c7d8e9f0a1b";
/** PEM labels built from parts, so no key header sits in the source. */
const KEY_LABEL = ["PRIVATE", "KEY"].join(" ");
const pem = (label: string, body: string) =>
  `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
const CERT_PEM = pem("CERTIFICATE", "MIIBszCCAVmgAwIBAgIUZm9yIHRlc3Rz");
const KEY_PEM = pem(KEY_LABEL, "MC4CAQAwBQYDK2VwBCIEIGZvciB0ZXN0cw==");
const uploadedRow = (host: string, id = CERT_ID) => ({
  host,
  source: "uploaded" as const,
  uploadedCertId: id,
  certPem: CERT_PEM,
  keyPem: KEY_PEM,
});

const pathExists = (path: string) =>
  Deno.lstat(path).then(() => true, () => false);

test("a managed host stages the pair 0600 and asks tp-host to install it, never writing the certs dir", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-instance-cert-" });
  try {
    const stageDir = join(root, "system", "instance-certs");
    const certsDir = join(root, "tls", "certs");
    const calls: string[][] = [];
    const seen: Record<string, { text: string; mode: number }> = {};
    const install = installUploadedCertViaHost({
      stageDir,
      run: async (command, args) => {
        assertEquals(command, "sudo");
        calls.push(args);
        for (const ext of ["crt", "key"]) {
          const path = join(stageDir, `${CERT_ID}.${ext}`);
          seen[ext] = {
            text: await Deno.readTextFile(path),
            mode: (await Deno.stat(path)).mode! & 0o777,
          };
        }
        return { success: true, stdout: "", stderr: "" };
      },
    });
    await writeUploadedInstanceCerts(
      [
        uploadedRow("https://a.example"),
        // The same certificate on a second name is installed once.
        uploadedRow("https://b.example"),
        { host: "https://c.example", source: "platform-ca" },
      ],
      certsDir,
      install,
    );
    assertEquals(calls.length, 1);
    assertEquals(calls[0]!.slice(-2), ["instance-cert-install", CERT_ID]);
    assertEquals(calls[0]![0], "-n");
    assertEquals(seen.crt, { text: CERT_PEM, mode: 0o600 });
    assertEquals(seen.key, { text: KEY_PEM, mode: 0o600 });
    assertEquals((await Deno.stat(stageDir)).mode! & 0o777, 0o700);
    // The staged copies are gone and the daemon never touched the certs dir.
    assertEquals([...Deno.readDirSync(stageDir)], []);
    assertEquals(await pathExists(certsDir), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("a tp-host refusal surfaces as the apply's error and leaves nothing staged", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-instance-cert-" });
  try {
    const stageDir = join(root, "instance-certs");
    const install = installUploadedCertViaHost({
      stageDir,
      run: () =>
        Promise.resolve({
          success: false,
          stdout: "",
          stderr:
            "tp-host: refusing the private key for x: not one PEM private key\n",
        }),
    });
    const err = await assertRejects(
      () =>
        writeUploadedInstanceCerts(
          [uploadedRow("https://a.example")],
          join(root, "certs"),
          install,
        ),
      Error,
    );
    assertEquals(
      err.message,
      `installing uploaded certificate ${CERT_ID} failed: tp-host: refusing the private key for x: not one PEM private key`,
    );
    assertEquals([...Deno.readDirSync(stageDir)], []);
    const silent = installUploadedCertViaHost({
      stageDir,
      run: () => Promise.resolve({ success: false, stdout: "", stderr: "" }),
    });
    await assertRejects(
      () => silent(CERT_ID, { cert: CERT_PEM, key: KEY_PEM }),
      Error,
      "tp-host refused it",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("a pair that is not PEM certificates and one key is refused before anything is staged", async () => {
  const calls: string[] = [];
  const install = (id: string) => {
    calls.push(id);
    return Promise.resolve();
  };
  const bad = [
    { certPem: KEY_PEM, keyPem: KEY_PEM },
    { certPem: CERT_PEM, keyPem: CERT_PEM },
    { certPem: CERT_PEM, keyPem: `${KEY_PEM}${KEY_PEM}` },
    { certPem: `junk\n${CERT_PEM}`, keyPem: KEY_PEM },
    { certPem: CERT_PEM, keyPem: pem(`ENCRYPTED ${KEY_LABEL}`, "MC4C") },
    { certPem: CERT_PEM.repeat(11), keyPem: KEY_PEM },
    {
      certPem: pem("CERTIFICATE", "A".repeat(64)).repeat(1100),
      keyPem: KEY_PEM,
    },
  ];
  for (const pair of bad) {
    await assertRejects(
      () =>
        writeUploadedInstanceCerts(
          [{ ...uploadedRow("https://a.example"), ...pair }],
          "/nonexistent",
          install,
        ),
      Error,
      `refusing uploaded certificate ${CERT_ID}`,
    );
  }
  // A certificate id that is not a UUID is refused too.
  for (
    const id of [
      "-".repeat(36),
      "a".repeat(36),
      `${CERT_ID}\nx`,
      CERT_ID.toUpperCase(),
    ]
  ) {
    await assertRejects(
      () =>
        writeUploadedInstanceCerts(
          [uploadedRow("https://a.example", id)],
          "/nonexistent",
          install,
        ),
      Error,
      "refusing uploaded certificate id",
    );
  }
  assertEquals(calls, []);
  // CRLF line endings and a missing final newline are normalized, not refused.
  assertEquals(
    uploadedCertPair(
      CERT_ID,
      CERT_PEM.replaceAll("\n", "\r\n").trimEnd(),
      KEY_PEM,
    ),
    { cert: CERT_PEM, key: KEY_PEM },
  );
});

test("co-located development writes the pair into its own certs dir", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-instance-cert-" });
  try {
    const certsDir = join(root, "certs");
    await writeUploadedInstanceCerts(
      [uploadedRow("https://a.example")],
      certsDir,
      writeUploadedCertDirect(certsDir),
    );
    assertEquals(
      await Deno.readTextFile(join(certsDir, `uploaded-${CERT_ID}.crt`)),
      CERT_PEM,
    );
    assertEquals(
      await Deno.readTextFile(join(certsDir, `uploaded-${CERT_ID}.key`)),
      KEY_PEM,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("the staging folder is in the daemon's state tree, apart from the certs dir", () => {
  const managed = { TURBOPANEL_MODE: "production" };
  assertEquals(
    instanceCertStageDir(managed),
    "/var/lib/turbopanel/system/instance-certs",
  );
  assertEquals(
    resolveInstanceCertsDir(managed),
    "/var/lib/turbopanel/tls/certs",
  );
});

// --- unused uploaded pairs ----------------------------------------------------

const RETIRED_ID = "9f8e7d6c-5b4a-4321-8fed-cba987654321";

async function certsDirWith(root: string, names: string[]): Promise<string> {
  const certsDir = join(root, "certs");
  await Deno.mkdir(certsDir, { recursive: true });
  for (const name of names) {
    await Deno.writeTextFile(join(certsDir, name), CERT_PEM);
  }
  return certsDir;
}

const listDir = (dir: string) =>
  [...Deno.readDirSync(dir)].map((e) => e.name).sort();

test("the ids in use are the uploaded hostnames' certificate ids, each once", () => {
  assertEquals(
    uploadedCertIdsInUse([
      uploadedRow("https://a.example"),
      uploadedRow("https://b.example"),
      uploadedRow("https://c.example", RETIRED_ID),
      { host: "https://d.example", source: "platform-ca" },
      // Not an uploaded hostname: its stray id keeps nothing.
      {
        host: "https://e.example",
        source: "lets-encrypt",
        uploadedCertId: "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d",
      },
      { host: "https://f.example", source: "uploaded" },
    ]),
    [CERT_ID, RETIRED_ID],
  );
});

test("stale uploaded files are exactly uploaded-<uuid>.{crt,key} of ids not kept", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-instance-cert-" });
  try {
    const certsDir = await certsDirWith(root, [
      `uploaded-${CERT_ID}.crt`,
      `uploaded-${CERT_ID}.key`,
      `uploaded-${RETIRED_ID}.crt`,
      `uploaded-${RETIRED_ID}.key`,
      `uploaded-${RETIRED_ID.toUpperCase()}.crt`,
      `uploaded-${RETIRED_ID}.pem`,
      "uploaded.crt",
      "platform-ca.key",
      "letsencrypt-panel.example.key",
    ]);
    await Deno.mkdir(
      join(
        certsDir,
        `uploaded-${"0".repeat(8)}-0000-0000-0000-${"0".repeat(12)}.crt`,
      ),
    );
    assertEquals(await staleUploadedCertFiles(certsDir, [CERT_ID]), [
      `uploaded-${RETIRED_ID}.crt`,
      `uploaded-${RETIRED_ID}.key`,
    ]);
    assertEquals(
      await staleUploadedCertFiles(join(root, "missing"), []),
      [],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("co-located development removes the unused pairs from its own certs dir", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-instance-cert-" });
  try {
    const certsDir = await certsDirWith(root, [
      `uploaded-${CERT_ID}.crt`,
      `uploaded-${CERT_ID}.key`,
      `uploaded-${RETIRED_ID}.crt`,
      `uploaded-${RETIRED_ID}.key`,
      "uploaded.crt",
    ]);
    await pruneUploadedInstanceCerts(
      [uploadedRow("https://a.example")],
      certsDir,
      pruneUploadedCertsDirect(certsDir),
    );
    assertEquals(listDir(certsDir), [
      `uploaded-${CERT_ID}.crt`,
      `uploaded-${CERT_ID}.key`,
      "uploaded.crt",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("a managed host asks tp-host to prune only when a stale pair is there, naming the ids in use", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-instance-cert-" });
  try {
    const calls: string[][] = [];
    const prune = pruneUploadedCertsViaHost({
      run: (command, args) => {
        assertEquals(command, "sudo");
        calls.push(args);
        return Promise.resolve({ success: true, stdout: "", stderr: "" });
      },
    });
    const certsDir = await certsDirWith(root, [
      `uploaded-${CERT_ID}.crt`,
      `uploaded-${CERT_ID}.key`,
    ]);
    const hostnames = [uploadedRow("https://a.example")];
    // Nothing stale: no root call at all.
    await pruneUploadedInstanceCerts(hostnames, certsDir, prune);
    assertEquals(calls, []);
    await Deno.writeTextFile(
      join(certsDir, `uploaded-${RETIRED_ID}.key`),
      KEY_PEM,
    );
    await pruneUploadedInstanceCerts(hostnames, certsDir, prune);
    assertEquals(calls.length, 1);
    assertEquals(calls[0]![0], "-n");
    assertEquals(calls[0]!.slice(-2), ["instance-cert-prune", CERT_ID]);
    // The daemon removed nothing itself.
    assertEquals(listDir(certsDir).length, 3);
    // No uploaded hostname left: tp-host is given no id at all.
    await pruneUploadedInstanceCerts([], certsDir, prune);
    assertEquals(calls[1]!.at(-1), "instance-cert-prune");
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("a failed prune is logged and does not fail the apply; too many ids are refused", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-instance-cert-" });
  try {
    const certsDir = await certsDirWith(root, [`uploaded-${RETIRED_ID}.crt`]);
    const refusing = pruneUploadedCertsViaHost({
      run: () =>
        Promise.resolve({ success: false, stdout: "", stderr: "refused\n" }),
    });
    await pruneUploadedInstanceCerts([], certsDir, refusing);
    await assertRejects(
      () => refusing([]),
      Error,
      "removing unused uploaded certificates failed: refused",
    );
    await assertRejects(
      () =>
        pruneUploadedCertsViaHost({
          run: () => Promise.reject(new Error("must not run")),
        })(Array.from({ length: INSTANCE_CERT_KEEP_MAX + 1 }, () => CERT_ID)),
      Error,
      `more than ${INSTANCE_CERT_KEEP_MAX}`,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("applyPublicUrls prunes after the certs apply, with the hostnames and certs dir", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-apply-urls-" });
  const saved = {
    config: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
    instance: Deno.env.get("TURBOPANEL_INSTANCE_DIR"),
  };
  Deno.env.set("TURBOPANEL_INSTANCE_DIR", join(root, "instance-src"));
  Deno.env.set("TURBOPANEL_CONFIG_DIR", root);
  try {
    await Deno.mkdir(join(root, "instance"), { recursive: true });
    const order: string[] = [];
    const hostnames = [{
      host: "https://apply.example",
      source: "platform-ca" as const,
    }];
    await applyPublicUrls(hostnames, {
      writeUploadedCerts: () => {
        order.push("write");
        return Promise.resolve();
      },
      runCertsApply: () => {
        order.push("apply");
        return Promise.resolve();
      },
      pruneUploadedCerts: (seen, certsDir) => {
        order.push("prune");
        assertEquals(seen, hostnames);
        assertEquals(certsDir, resolveInstanceCertsDir());
        return Promise.resolve();
      },
    });
    assertEquals(order, ["write", "apply", "prune"]);
    // A failed certs apply never prunes: the old config may still name them.
    order.length = 0;
    await assertRejects(() =>
      applyPublicUrls(hostnames, {
        writeUploadedCerts: () => Promise.resolve(),
        runCertsApply: () => Promise.reject(new Error("caddy refused")),
        pruneUploadedCerts: () => {
          order.push("prune");
          return Promise.resolve();
        },
      })
    );
    assertEquals(order, []);
  } finally {
    for (
      const [name, value] of [
        ["TURBOPANEL_CONFIG_DIR", saved.config],
        ["TURBOPANEL_INSTANCE_DIR", saved.instance],
      ] as const
    ) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
    await Deno.remove(root, { recursive: true });
  }
});
