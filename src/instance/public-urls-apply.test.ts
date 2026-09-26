import { assertEquals, assertRejects } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { INSTANCE_CERTS_APPLY_PLAYBOOK } from "../orchestration/assets.ts";
import { PROD_INSTANCE_DIR_DEFAULT } from "../paths/layout.ts";
import {
  applyPublicUrls,
  resolveInstanceDir,
  runInstanceCertsApply,
  upsertPublicUrlsInEnv,
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

    const writeTmpDir = join(configDir, ".write-tmp");
    let leftoverTmp = 0;
    try {
      for await (const entry of Deno.readDir(writeTmpDir)) {
        if (entry.name.startsWith("write-")) leftoverTmp++;
      }
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound)) throw err;
    }
    assertEquals(leftoverTmp, 0);
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
      "hosting Caddy reload failed",
      "hosting Caddy is not listening on port 80",
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
