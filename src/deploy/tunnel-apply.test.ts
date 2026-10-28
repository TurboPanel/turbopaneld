import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type { TunnelRoutesPayload } from "../contracts/commands-contracts.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import {
  removeHostingCaddySite,
  rewriteHostingCaddySites,
  setIngressHostCommandForTest,
} from "./ingress.ts";
import { applyTunnelRoutes } from "./tunnel-apply.ts";
import { TUNNEL_SITE_FILE, tunnelPeerPaths } from "./tunnel-caddy.ts";
import { readTunnelState } from "./tunnel-state.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const SERVER_A = "0192f0a4-1c2b-7d3e-8f40-5a6b7c8d9e01";
const CERT = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
const HASH_1 = "a".repeat(64);
const HASH_2 = "b".repeat(64);
const noGrant = () => Promise.resolve();
const decrypt = (envelopes: string[]) =>
  Promise.resolve(envelopes.map(() => "-----BEGIN PRIVATE KEY-----\nKEY\n"));

async function makeTestLayout(): Promise<
  { layout: LayoutPaths; cleanup: () => Promise<void> }
> {
  const root = await Deno.makeTempDir({ prefix: "tp-tunnel-test-" });
  const layout = resolveLayout(
    {
      TURBOPANEL_STATE_DIR: `${root}/state`,
      TURBOPANEL_CONFIG_DIR: `${root}/config`,
    },
    { skipDiscovery: true, forceMode: "production" },
  );
  await Deno.mkdir(`${root}/state/hosting-caddy`, { recursive: true });
  return { layout, cleanup: () => Deno.remove(root, { recursive: true }) };
}

/**
 * A stand-in for the hosting Caddy account's `caddy validate`: a snippet
 * marked BAD does not load, and neither does a name served twice. When
 * `TP_TEST_CADDY` names a real Caddy binary the set is judged by it instead.
 */
function fakeHost(
  layout: LayoutPaths,
  calls: string[][],
  refuse: (() => boolean) | undefined,
  useReal: boolean,
) {
  const sites = join(layout.configDir, "hosting", "sites.next");
  return (_command: string, args: string[]) => {
    calls.push([...args]);
    if (!args.includes("validate")) {
      return Promise.resolve({ success: true, stderr: "" });
    }
    const config = args[args.indexOf("--config") + 1]!;
    const real = useReal ? Deno.env.get("TP_TEST_CADDY") : undefined;
    if (real) {
      const out = new Deno.Command(real, {
        args: ["validate", "--adapter", "caddyfile", "--config", config],
        env: { HOME: layout.configDir, XDG_DATA_HOME: layout.configDir },
        stdout: "null",
        stderr: "piped",
      }).outputSync();
      return Promise.resolve({
        success: out.success,
        stderr: new TextDecoder().decode(out.stderr),
      });
    }
    const seen = new Set<string>();
    for (const entry of Deno.readDirSync(sites)) {
      const text = Deno.readTextFileSync(join(sites, entry.name));
      const refused = refuse?.() && entry.name === TUNNEL_SITE_FILE &&
        text.trim() !== "";
      if (text.includes("BAD") || refused) {
        return Promise.resolve({
          success: false,
          stderr: `unrecognized directive in ${entry.name}`,
        });
      }
      const own = new Set(
        [...text.matchAll(/^(?:http:\/\/)?([a-z0-9.-]+) \{$/gm)].map((m) =>
          m[1]!
        ),
      );
      for (const host of own) {
        if (seen.has(host)) {
          return Promise.resolve({
            success: false,
            stderr: `ambiguous site definition: ${host}`,
          });
        }
        seen.add(host);
      }
    }
    return Promise.resolve({ success: true, stderr: "" });
  };
}

function table(
  overrides: Partial<TunnelRoutesPayload> = {},
): TunnelRoutesPayload {
  return {
    hash: HASH_1,
    routes: [
      {
        hostname: "app.example.com",
        local: false,
        lock: true,
        upstreams: [{ serverId: SERVER_A, addresses: ["10.0.0.5"] }],
      },
    ],
    peerAddresses: ["10.0.0.5"],
    listenAddresses: ["10.0.0.7"],
    peerMaterial: {
      certificatePem: CERT,
      privateKeyEnvelope: "tpdaemon.AAAA",
      caCertPem: CERT,
    },
    ...overrides,
  };
}

function envPayload(environmentId: string, hostname: string) {
  return {
    environmentId,
    projectId: "proj-1",
    organizationId: "org-1",
    projectName: "demo",
    composeFiles: [{
      filename: "compose.yaml",
      role: "runtime" as const,
      content: "services: {}",
    }],
    hostings: [{
      hostingId: "h1",
      serviceId: "s1",
      composeServiceName: "web",
      hostnames: [hostname],
    }],
  };
}

async function withHost<T>(
  work: (ctx: {
    layout: LayoutPaths;
    sitesDir: string;
    hostingDir: string;
    calls: string[][];
    refuse: { tunnel: boolean };
  }) => Promise<T>,
  useReal = false,
): Promise<T> {
  const { layout, cleanup } = await makeTestLayout();
  const calls: string[][] = [];
  const refuse = { tunnel: false };
  const restore = setIngressHostCommandForTest(
    fakeHost(layout, calls, () => refuse.tunnel, useReal),
  );
  try {
    const hostingDir = join(layout.configDir, "hosting");
    return await work({
      layout,
      hostingDir,
      sitesDir: join(hostingDir, "sites"),
      calls,
      refuse,
    });
  } finally {
    restore();
    await cleanup();
  }
}

const exists = (path: string) => Deno.stat(path).then(() => true, () => false);

test("a table writes the forward file, the peer material and the stored table, then reloads once", async () => {
  await withHost(async ({ layout, sitesDir, hostingDir, calls }) => {
    const result = await applyTunnelRoutes(layout, table(), {
      decryptSecrets: decrypt,
      grantRead: noGrant,
    });
    assertEquals(result.applied, true);
    assertEquals(result.routeCount, 1);
    const file = await Deno.readTextFile(join(sitesDir, TUNNEL_SITE_FILE));
    assertStringIncludes(file, "app.example.com {");
    assertStringIncludes(file, "tp-peer.internal {");
    const state = await readTunnelState(hostingDir);
    assertEquals(state?.hash, HASH_1);
    const paths = tunnelPeerPaths(hostingDir, state!.peerId!);
    assertStringIncludes(await Deno.readTextFile(paths.key), "KEY");
    assertEquals((await Deno.stat(paths.key)).mode! & 0o777, 0o640);
    assertStringIncludes(file, paths.trust);
    const validateAt = calls.findIndex((a) => a.includes("validate"));
    const reloadAt = calls.findIndex((a) => a.includes("reload"));
    assert(validateAt >= 0 && reloadAt > validateAt);
  });
});

test("the same table again changes nothing and runs no command", async () => {
  await withHost(async ({ layout, calls }) => {
    const deps = { decryptSecrets: decrypt, grantRead: noGrant };
    await applyTunnelRoutes(layout, table(), deps);
    const before = calls.length;
    const again = await applyTunnelRoutes(layout, table(), deps);
    assertEquals(again.applied, false);
    assertEquals(again.routeCount, 1);
    assertEquals(calls.length, before);
  });
});

test("a changed table replaces the file and the old peer material folder", async () => {
  await withHost(async ({ layout, sitesDir, hostingDir }) => {
    const deps = { decryptSecrets: decrypt, grantRead: noGrant };
    await applyTunnelRoutes(layout, table(), deps);
    const first = (await readTunnelState(hostingDir))!.peerId!;
    const other =
      "-----BEGIN CERTIFICATE-----\nMIIC\n-----END CERTIFICATE-----\n";
    await applyTunnelRoutes(
      layout,
      table({
        hash: HASH_2,
        peerMaterial: {
          certificatePem: other,
          privateKeyEnvelope: "tpdaemon.BBBB",
          caCertPem: CERT,
        },
      }),
      deps,
    );
    const second = (await readTunnelState(hostingDir))!.peerId!;
    assert(first !== second);
    assertEquals(await exists(tunnelPeerPaths(hostingDir, first).dir), false);
    assertStringIncludes(
      await Deno.readTextFile(join(sitesDir, TUNNEL_SITE_FILE)),
      tunnelPeerPaths(hostingDir, second).certificate,
    );
  });
});

test("a name already served on this server is left out and reported", async () => {
  await withHost(async ({ layout, sitesDir }) => {
    await rewriteHostingCaddySites(
      layout,
      envPayload("env-1", "app.example.com"),
      undefined,
      noGrant,
    );
    const result = await applyTunnelRoutes(layout, table(), {
      decryptSecrets: decrypt,
      grantRead: noGrant,
    });
    assertEquals(result.dropped, ["app.example.com"]);
    assertEquals(result.routeCount, 0);
    const file = await Deno.readTextFile(join(sitesDir, TUNNEL_SITE_FILE));
    assertEquals(file.includes("reverse_proxy"), false);
  });
});

test("a site that moves here leaves the forward file in the same deploy, and back again when removed", async () => {
  await withHost(async ({ layout, sitesDir }) => {
    const deps = { decryptSecrets: decrypt, grantRead: noGrant };
    await applyTunnelRoutes(layout, table(), deps);
    assertStringIncludes(
      await Deno.readTextFile(join(sitesDir, TUNNEL_SITE_FILE)),
      "app.example.com {",
    );
    // Would fail validation with "ambiguous site definition" if both held it.
    await rewriteHostingCaddySites(
      layout,
      envPayload("env-1", "app.example.com"),
      undefined,
      noGrant,
    );
    assertEquals(
      (await Deno.readTextFile(join(sitesDir, TUNNEL_SITE_FILE))).includes(
        "app.example.com {",
      ),
      false,
    );
    assertStringIncludes(
      await Deno.readTextFile(join(sitesDir, "env-1.caddy")),
      "app.example.com",
    );
    await removeHostingCaddySite(layout, "env-1");
    assertStringIncludes(
      await Deno.readTextFile(join(sitesDir, TUNNEL_SITE_FILE)),
      "app.example.com {",
    );
  });
});

test("a refused table leaves the live file, the stored table and the new key files as they were", async () => {
  await withHost(async ({ layout, sitesDir, hostingDir, refuse }) => {
    const deps = { decryptSecrets: decrypt, grantRead: noGrant };
    await applyTunnelRoutes(layout, table(), deps);
    const live = await Deno.readTextFile(join(sitesDir, TUNNEL_SITE_FILE));
    const kept = (await readTunnelState(hostingDir))!.peerId!;
    refuse.tunnel = true;
    await assertRejects(() =>
      applyTunnelRoutes(
        layout,
        table({
          hash: HASH_2,
          peerMaterial: {
            certificatePem:
              "-----BEGIN CERTIFICATE-----\nMIID\n-----END CERTIFICATE-----\n",
            privateKeyEnvelope: "tpdaemon.CCCC",
            caCertPem: CERT,
          },
        }),
        deps,
      )
    );
    assertEquals(
      await Deno.readTextFile(join(sitesDir, TUNNEL_SITE_FILE)),
      live,
    );
    assertEquals((await readTunnelState(hostingDir))!.hash, HASH_1);
    const folders = [];
    for await (const entry of Deno.readDir(join(hostingDir, "peer"))) {
      folders.push(entry.name);
    }
    assertEquals(folders, [kept]);
  });
});

test("a forward file Caddy refuses is set aside and never stops a site from deploying", async () => {
  await withHost(async ({ layout, sitesDir, refuse }) => {
    await applyTunnelRoutes(layout, table(), {
      decryptSecrets: decrypt,
      grantRead: noGrant,
    });
    refuse.tunnel = true;
    await rewriteHostingCaddySites(
      layout,
      envPayload("env-2", "other.example.com"),
      undefined,
      noGrant,
    );
    assertStringIncludes(
      await Deno.readTextFile(join(sitesDir, "env-2.caddy")),
      "other.example.com",
    );
    assertEquals(await exists(join(sitesDir, TUNNEL_SITE_FILE)), false);
    assert(await exists(join(sitesDir, `${TUNNEL_SITE_FILE}.quarantined`)));
    // The same table again repairs it.
    refuse.tunnel = false;
    const again = await applyTunnelRoutes(layout, table(), {
      decryptSecrets: decrypt,
      grantRead: noGrant,
    });
    assertEquals(again.applied, true);
    assert(await exists(join(sitesDir, TUNNEL_SITE_FILE)));
  });
});

test("a re-rendered forward file Caddy refuses is emptied for the deploy that changed it", async () => {
  await withHost(async ({ layout, sitesDir, refuse }) => {
    await applyTunnelRoutes(layout, table(), {
      decryptSecrets: decrypt,
      grantRead: noGrant,
    });
    refuse.tunnel = true;
    await rewriteHostingCaddySites(
      layout,
      envPayload("env-1", "app.example.com"),
      undefined,
      noGrant,
    );
    assertStringIncludes(
      await Deno.readTextFile(join(sitesDir, "env-1.caddy")),
      "app.example.com",
    );
    assertEquals(await Deno.readTextFile(join(sitesDir, TUNNEL_SITE_FILE)), "");
  });
});

test("an empty table removes the file, the stored table and the peer material", async () => {
  await withHost(async ({ layout, sitesDir, hostingDir }) => {
    const deps = { decryptSecrets: decrypt, grantRead: noGrant };
    await applyTunnelRoutes(layout, table(), deps);
    const result = await applyTunnelRoutes(
      layout,
      { hash: HASH_2, routes: [], peerAddresses: [] },
      deps,
    );
    assertEquals(result.applied, true);
    assertEquals(result.routeCount, 0);
    assertEquals(await exists(join(sitesDir, TUNNEL_SITE_FILE)), false);
    assertEquals(await readTunnelState(hostingDir), undefined);
    assertEquals(await exists(join(hostingDir, "peer")), false);
  });
});

test("an empty table on a host that never had one touches nothing", async () => {
  await withHost(async ({ layout, calls }) => {
    const result = await applyTunnelRoutes(
      layout,
      { hash: HASH_1, routes: [], peerAddresses: [] },
      { decryptSecrets: decrypt, grantRead: noGrant },
    );
    assertEquals(result.applied, true);
    assertEquals(calls.length, 0);
  });
});

/** A CA and a leaf for the peer name, made with the host's `openssl`. */
async function makePeerMaterial(
  dir: string,
): Promise<{ certificate: string; key: string; ca: string }> {
  const openssl = async (...args: string[]) => {
    const out = await new Deno.Command("openssl", {
      args,
      cwd: dir,
      stdout: "null",
      stderr: "piped",
    }).output();
    if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  };
  await openssl(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.pem",
    "-days",
    "2",
    "-subj",
    "/CN=Test CA",
  );
  await openssl(
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "leaf.key",
    "-out",
    "leaf.csr",
    "-subj",
    "/CN=tp-peer",
  );
  await Deno.writeTextFile(
    join(dir, "ext"),
    "subjectAltName=DNS:tp-peer.internal,IP:10.0.0.7\nextendedKeyUsage=serverAuth\n",
  );
  await openssl(
    "x509",
    "-req",
    "-in",
    "leaf.csr",
    "-CA",
    "ca.pem",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "leaf.pem",
    "-days",
    "2",
    "-extfile",
    "ext",
  );
  const read = (name: string) => Deno.readTextFile(join(dir, name));
  return {
    certificate: await read("leaf.pem"),
    key: await read("leaf.key"),
    ca: await read("ca.pem"),
  };
}

// Runs only where a real Caddy is named (TP_TEST_CADDY=/path/to/caddy) and
// openssl exists: CI hosts without them skip it.
test({
  name:
    "a real Caddy loads the whole rendered set: locked site, forward blocks and peer site",
  ignore: !Deno.env.get("TP_TEST_CADDY"),
  fn: async () => {
    await withHost(async ({ layout, sitesDir }) => {
      const scratch = await Deno.makeTempDir({ prefix: "tp-tunnel-pki-" });
      try {
        const pki = await makePeerMaterial(scratch);
        const sealed = (envelopes: string[]) =>
          Promise.resolve(envelopes.map(() => pki.key));
        await applyTunnelRoutes(
          layout,
          table({
            peerMaterial: {
              certificatePem: pki.certificate,
              privateKeyEnvelope: "tpdaemon.AAAA",
              caCertPem: pki.ca,
            },
          }),
          { decryptSecrets: sealed, grantRead: noGrant },
        );
        const payload = envPayload("env-9", "pub.example.com");
        payload.hostings[0] = {
          ...payload.hostings[0]!,
          hostnames: ["pub.example.com", "open.example.com"],
          bindAddress: "10.0.0.7",
          tunnel: {
            hostnames: ["pub.example.com", "open.example.com"],
            openHostnames: ["open.example.com"],
            peers: ["10.0.0.5"],
            extraBind: ["10.0.0.7"],
          },
        } as never;
        await rewriteHostingCaddySites(layout, payload, undefined, noGrant);
        assertStringIncludes(
          await Deno.readTextFile(join(sitesDir, "env-9.caddy")),
          "@tp_outside",
        );
      } finally {
        await Deno.remove(scratch, { recursive: true });
      }
    }, true);
  },
});
