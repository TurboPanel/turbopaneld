import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  INSTANCE_ACME_HTTP01_SITE,
  InstanceAcmeHttp01PreflightError,
  instanceAcmePreflightNonce,
  isDaemonReservedHostingSite,
  preflightInstanceLetsEncryptHttp01,
  renderInstanceAcmeHttp01Site,
  renderInstancePublicEdgeSite,
  syncInstanceAcmeHttp01Site,
  verifyInstanceAcmeHttp01Reachability,
  withInstanceAcmePreflightHandle,
} from "./instance-acme-http01.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isDaemonReservedHostingSite names the challenge forward and the empty site", () => {
  assertEquals(isDaemonReservedHostingSite(INSTANCE_ACME_HTTP01_SITE), true);
  assertEquals(isDaemonReservedHostingSite("00-empty.caddy"), true);
  assertEquals(isDaemonReservedHostingSite("env-1.caddy"), false);
});

test("syncInstanceAcmeHttp01Site writes the reserved site and removes it when idle", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-http01-" });
  const sites = join(root, "hosting", "sites");
  const caddy = join(root, "caddy");
  await Deno.mkdir(sites, { recursive: true });
  await Deno.mkdir(caddy, { recursive: true });
  await Deno.writeTextFile(
    join(caddy, "instance-hostnames.json"),
    JSON.stringify([{ host: "panel.example.com", source: "lets-encrypt" }]),
  );
  const layout = { configDir: root } as LayoutPaths;
  const dest = join(sites, INSTANCE_ACME_HTTP01_SITE);
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => Promise.resolve(),
    });
    const written = await Deno.readTextFile(dest);
    assertEquals(written.includes("http://panel.example.com"), true);
    assertEquals(written.includes("127.0.0.1:8880"), true);
    assertEquals(
      written,
      renderInstanceAcmeHttp01Site(["panel.example.com"]),
    );

    await Deno.writeTextFile(
      join(caddy, "instance-hostnames.json"),
      "[]",
    );
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => Promise.resolve(),
    });
    let removed = false;
    try {
      await Deno.stat(dest);
    } catch (err) {
      removed = err instanceof Deno.errors.NotFound;
    }
    assertEquals(removed, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site does nothing when hosting Caddy is absent", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-http01-absent-" });
  try {
    await syncInstanceAcmeHttp01Site({ configDir: root } as LayoutPaths);
    let sites = false;
    try {
      await Deno.stat(join(root, "hosting", "sites"));
      sites = true;
    } catch (err) {
      sites = !(err instanceof Deno.errors.NotFound);
    }
    assertEquals(sites, false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

const UPLOADED_ID = "11111111-1111-4111-8111-111111111111";

async function hostingFixture(
  sidecar: unknown,
): Promise<{ root: string; layout: LayoutPaths; dest: string }> {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-edge-" });
  const sites = join(root, "hosting", "sites");
  await Deno.mkdir(sites, { recursive: true });
  await Deno.mkdir(join(root, "caddy"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "caddy", "instance-hostnames.json"),
    JSON.stringify(sidecar),
  );
  return {
    root,
    layout: { configDir: root, stateDir: root } as LayoutPaths,
    dest: join(sites, INSTANCE_ACME_HTTP01_SITE),
  };
}

test("syncInstanceAcmeHttp01Site publishes an uploaded name on hosting :443", async () => {
  const { root, layout, dest } = await hostingFixture([{
    host: "panel.example.com",
    source: "uploaded",
    cert_id: UPLOADED_ID,
  }]);
  const certDir = join(root, "tls", "certs");
  await Deno.mkdir(certDir, { recursive: true });
  const certFile = join(certDir, `uploaded-${UPLOADED_ID}.crt`);
  const keyFile = join(certDir, `uploaded-${UPLOADED_ID}.key`);
  await Deno.writeTextFile(certFile, "uploaded-cert\n");
  await Deno.writeTextFile(keyFile, "uploaded-key\n");
  let reloads = 0;
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    const written = await Deno.readTextFile(dest);
    assertEquals(/^panel\.example\.com \{$/m.test(written), true);
    assertEquals(written.includes(certFile), true);
    assertEquals(written.includes(keyFile), true);
    assertEquals(written.includes("127.0.0.1:8443"), true);
    assertEquals(written.includes("acme-challenge"), false);
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    assertEquals(reloads, 1);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site omits an uploaded name whose files are missing", async () => {
  const { root, layout, dest } = await hostingFixture([{
    host: "panel.example.com",
    source: "uploaded",
    cert_id: UPLOADED_ID,
  }]);
  let reloads = 0;
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    let present = true;
    try {
      await Deno.stat(dest);
    } catch (err) {
      present = !(err instanceof Deno.errors.NotFound);
    }
    assertEquals(present, false);
    assertEquals(reloads, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site forwards HTTP-01 and leaves :443 unpublished before the leaf exists", async () => {
  const { root, layout, dest } = await hostingFixture([{
    host: "panel.example.com",
    source: "lets-encrypt",
  }]);
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => Promise.resolve(),
    });
    const written = await Deno.readTextFile(dest);
    assertEquals(written, renderInstanceAcmeHttp01Site(["panel.example.com"]));
    assertEquals(/^panel\.example\.com \{$/m.test(written), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site publishes Let's Encrypt :443 after the leaf is copied", async () => {
  const host = "panel.example.com";
  const { root, layout, dest } = await hostingFixture([{
    host,
    source: "lets-encrypt",
  }]);
  const issued = join(
    root,
    "caddy",
    ".local",
    "share",
    "caddy",
    "certificates",
    "acme-v02.api.letsencrypt.org",
    host,
  );
  await Deno.mkdir(issued, { recursive: true });
  const certBytes = new TextEncoder().encode("leaf-v1");
  await Deno.writeFile(join(issued, `${host}.crt`), certBytes);
  await Deno.writeFile(
    join(issued, `${host}.key`),
    new TextEncoder().encode("key-v1"),
  );
  let reloads = 0;
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    const written = await Deno.readTextFile(dest);
    const edgeCert = join(root, "caddy", "public-edge", `${host}.crt`);
    assertEquals(written.includes("127.0.0.1:8880"), true);
    assertEquals(written.includes("127.0.0.1:8444"), true);
    assertEquals(written.includes(edgeCert), true);
    assertEquals(/^panel\.example\.com \{$/m.test(written), true);
    assertEquals(await Deno.readFile(edgeCert), certBytes);
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    assertEquals(reloads, 1);
    const renewed = new TextEncoder().encode("leaf-version-2");
    await Deno.writeFile(join(issued, `${host}.crt`), renewed);
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    assertEquals(reloads, 2);
    assertEquals(await Deno.readFile(edgeCert), renewed);
    assertEquals(await Deno.readTextFile(dest), written);
    const sameLength = new TextEncoder().encode("leaf-version-3");
    await Deno.writeFile(join(issued, `${host}.crt`), sameLength);
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => {
        reloads += 1;
        return Promise.resolve();
      },
    });
    assertEquals(reloads, 3);
    assertEquals(await Deno.readFile(edgeCert), sameLength);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("withInstanceAcmePreflightHandle inserts a pass-through challenge root", () => {
  const root = "/etc/turbopanel/caddy/acme-preflight";
  const source = ":8880 {\n\tredir https://example\n}\n";
  const once = withInstanceAcmePreflightHandle(source, root);
  assertStringIncludes(once, `root * ${root}`);
  assertStringIncludes(once, "pass_thru");
  assertEquals(withInstanceAcmePreflightHandle(once, root), once);
});

test("verifyInstanceAcmeHttp01Reachability requires both hops to echo the nonce", async () => {
  const nonce = "ab".repeat(16);
  const seen: string[] = [];
  await verifyInstanceAcmeHttp01Reachability("panel.example.com", nonce, {
    fetchImpl: ((input: string | URL | Request) => {
      seen.push(String(input));
      return Promise.resolve(new Response(nonce, { status: 200 }));
    }) as typeof fetch,
  });
  assertEquals(seen[0]?.includes("127.0.0.1:8880"), true);
  assertEquals(
    seen[1],
    `http://panel.example.com/.well-known/acme-challenge/${nonce}`,
  );

  await assertRejects(
    () =>
      verifyInstanceAcmeHttp01Reachability("panel.example.com", nonce, {
        fetchImpl: (() =>
          Promise.resolve(
            new Response("nope", { status: 404 }),
          )) as typeof fetch,
      }),
    InstanceAcmeHttp01PreflightError,
    "did not reach 127.0.0.1:8880",
  );
});

test("preflightInstanceLetsEncryptHttp01 publishes a nonce and removes it", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-preflight-" });
  const layout = { configDir: root } as LayoutPaths;
  await Deno.mkdir(join(root, "caddy"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "caddy", "Caddyfile"),
    ":8880 {\n\tredir https://example\n}\n",
  );
  const nonce = "cd".repeat(16);
  let synced = 0;
  try {
    await preflightInstanceLetsEncryptHttp01(
      [{ host: "https://panel.example.com", source: "lets-encrypt" }],
      layout,
      {
        nonce: () => nonce,
        syncChallenge: () => {
          synced += 1;
          return Promise.resolve();
        },
        reloadControlPlane: () => Promise.resolve(),
        fetchImpl: ((input: string | URL | Request) => {
          const url = String(input);
          if (url.includes(nonce)) {
            return Promise.resolve(new Response(nonce, { status: 200 }));
          }
          return Promise.resolve(new Response("missing", { status: 404 }));
        }) as typeof fetch,
      },
    );
    assertEquals(synced, 1);
    const caddyfile = await Deno.readTextFile(join(root, "caddy", "Caddyfile"));
    assertStringIncludes(caddyfile, "acme-preflight");
    const names: string[] = [];
    for await (
      const entry of Deno.readDir(
        join(root, "caddy", "acme-preflight", ".well-known", "acme-challenge"),
      )
    ) {
      names.push(entry.name);
    }
    assertEquals(names, []);

    await assertRejects(
      () =>
        preflightInstanceLetsEncryptHttp01(
          [{ host: "panel.example.com", source: "lets-encrypt" }],
          layout,
          {
            nonce: () => nonce,
            syncChallenge: () => Promise.resolve(),
            reloadControlPlane: () => Promise.resolve(),
            fetchImpl: (() =>
              Promise.resolve(
                new Response("nope", { status: 404 }),
              )) as typeof fetch,
          },
        ),
      InstanceAcmeHttp01PreflightError,
      "panel.example.com",
    );
    const afterFailure: string[] = [];
    for await (
      const entry of Deno.readDir(
        join(root, "caddy", "acme-preflight", ".well-known", "acme-challenge"),
      )
    ) {
      afterFailure.push(entry.name);
    }
    assertEquals(afterFailure, []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("renderInstancePublicEdgeSite returns the HTTP-01 forward before a leaf exists", async () => {
  const { root, layout } = await hostingFixture([]);
  try {
    const text = await renderInstancePublicEdgeSite(layout, [{
      host: "panel.example.com",
      source: "lets-encrypt",
      certId: "",
    }]);
    assertEquals(text, renderInstanceAcmeHttp01Site(["panel.example.com"]));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site rethrows when the sites path is not a directory", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-acme-not-dir-" });
  await Deno.writeTextFile(join(root, "hosting"), "not-a-directory");
  try {
    await assertRejects(
      () =>
        syncInstanceAcmeHttp01Site({ configDir: root } as LayoutPaths, {
          reload: () => Promise.resolve(),
        }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site rethrows when the site path cannot be read or removed", async () => {
  const idle = await hostingFixture([]);
  await Deno.mkdir(idle.dest, { recursive: true });
  await Deno.writeTextFile(join(idle.dest, "keep"), "x");
  const blocked = await hostingFixture([{
    host: "panel.example.com",
    source: "lets-encrypt",
  }]);
  await Deno.mkdir(blocked.dest, { recursive: true });
  try {
    await assertRejects(
      () =>
        syncInstanceAcmeHttp01Site(idle.layout, {
          reload: () => Promise.resolve(),
        }),
    );
    await assertRejects(
      () =>
        syncInstanceAcmeHttp01Site(blocked.layout, {
          reload: () => Promise.resolve(),
        }),
    );
  } finally {
    await Deno.remove(idle.root, { recursive: true });
    await Deno.remove(blocked.root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site skips a Let's Encrypt leaf it cannot copy", async () => {
  const host = "panel.example.com";
  const { root, layout, dest } = await hostingFixture([{
    host,
    source: "lets-encrypt",
  }]);
  const certificates = join(
    root,
    "caddy",
    ".local",
    "share",
    "caddy",
    "certificates",
  );
  await Deno.mkdir(
    join(root, "caddy", ".local", "share", "caddy"),
    { recursive: true },
  );
  await Deno.writeTextFile(certificates, "not-a-directory");
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => Promise.resolve(),
    });
    const written = await Deno.readTextFile(dest);
    assertEquals(/^panel\.example\.com \{$/m.test(written), false);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site skips a leaf when stat or read is not a file", async () => {
  const host = "panel.example.com";
  const { root, layout, dest } = await hostingFixture([{
    host,
    source: "lets-encrypt",
  }]);
  const certificates = join(
    root,
    "caddy",
    ".local",
    "share",
    "caddy",
    "certificates",
  );
  await Deno.mkdir(certificates, { recursive: true });
  await Deno.writeTextFile(join(certificates, "not-a-directory"), "x");
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => Promise.resolve(),
    });
    const issued = join(certificates, "acme.example", host);
    await Deno.mkdir(issued, { recursive: true });
    await Deno.writeFile(
      join(issued, `${host}.crt`),
      new TextEncoder().encode("leaf"),
    );
    await Deno.writeFile(
      join(issued, `${host}.key`),
      new TextEncoder().encode("key"),
    );
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => Promise.resolve(),
    });
    const edgeCert = join(root, "caddy", "public-edge", `${host}.crt`);
    await Deno.remove(edgeCert);
    await Deno.mkdir(edgeCert);
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => Promise.resolve(),
    });
    assertEquals(
      (await Deno.readTextFile(dest)).includes("127.0.0.1:8880"),
      true,
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site ignores an issuer directory with no leaf", async () => {
  const host = "panel.example.com";
  const { root, layout, dest } = await hostingFixture([{
    host,
    source: "lets-encrypt",
  }]);
  await Deno.mkdir(
    join(
      root,
      "caddy",
      ".local",
      "share",
      "caddy",
      "certificates",
      "acme.example",
    ),
    { recursive: true },
  );
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => Promise.resolve(),
    });
    const written = await Deno.readTextFile(dest);
    assertEquals(written, renderInstanceAcmeHttp01Site([host]));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

async function withSudo(
  script: string,
  fn: () => Promise<void>,
): Promise<void> {
  const bin = await Deno.makeTempDir({ prefix: "tp-fake-sudo-" });
  const sudo = join(bin, "sudo");
  await Deno.writeTextFile(sudo, script);
  await Deno.chmod(sudo, 0o755);
  const previous = Deno.env.get("PATH") ?? "";
  Deno.env.set("PATH", `${bin}:${previous}`);
  try {
    await fn();
  } finally {
    Deno.env.set("PATH", previous);
    await Deno.remove(bin, { recursive: true });
  }
}

test("syncInstanceAcmeHttp01Site reads a root-only issued leaf through sudo", async () => {
  const host = "panel.example.com";
  const { root, layout, dest } = await hostingFixture([{
    host,
    source: "lets-encrypt",
  }]);
  const issued = join(
    root,
    "caddy",
    ".local",
    "share",
    "caddy",
    "certificates",
    "acme.example",
    host,
  );
  await Deno.mkdir(issued, { recursive: true });
  const crt = join(issued, `${host}.crt`);
  const key = join(issued, `${host}.key`);
  await Deno.writeFile(crt, new TextEncoder().encode("secret-leaf"));
  await Deno.writeFile(key, new TextEncoder().encode("secret-key"));
  await Deno.chmod(crt, 0o000);
  const certificates = join(
    root,
    "caddy",
    ".local",
    "share",
    "caddy",
    "certificates",
  );
  await Deno.chmod(certificates, 0o000);
  const script = `#!/bin/sh
if [ "$2" = find ]; then
  printf '%s\\n' '${crt}'
  exit 0
fi
if [ "$2" = cat ]; then
  printf '%s' 'from-sudo'
  exit 0
fi
exit 1
`;
  try {
    await withSudo(script, async () => {
      await syncInstanceAcmeHttp01Site(layout, {
        reload: () => Promise.resolve(),
      });
    });
    const edgeCert = join(root, "caddy", "public-edge", `${host}.crt`);
    assertEquals(await Deno.readTextFile(edgeCert), "from-sudo");
    assertEquals(
      (await Deno.readTextFile(dest)).includes("127.0.0.1:8444"),
      true,
    );
  } finally {
    await Deno.chmod(certificates, 0o755);
    await Deno.chmod(crt, 0o644);
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site skips sudo find for a wildcard and a failed sudo", async () => {
  const { root, layout, dest } = await hostingFixture([]);
  const certificates = join(
    root,
    "caddy",
    ".local",
    "share",
    "caddy",
    "certificates",
  );
  await Deno.mkdir(certificates, { recursive: true });
  await Deno.chmod(certificates, 0o000);
  try {
    await withSudo("#!/bin/sh\nexit 1\n", async () => {
      await syncInstanceAcmeHttp01Site(layout, {
        entries: [{
          host: "*.example.com",
          source: "lets-encrypt",
          certId: "",
        }],
        reload: () => Promise.resolve(),
      });
      await syncInstanceAcmeHttp01Site(layout, {
        entries: [{
          host: "panel.example.com",
          source: "lets-encrypt",
          certId: "",
        }],
        reload: () => Promise.resolve(),
      });
    });
    await withSudo(
      "#!/bin/sh\nprintf '%s\\n' 'not-a-certificate'\n",
      async () => {
        await syncInstanceAcmeHttp01Site(layout, {
          entries: [{
            host: "panel.example.com",
            source: "lets-encrypt",
            certId: "",
          }],
          reload: () => Promise.resolve(),
        });
      },
    );
    await Deno.chmod(certificates, 0o755);
    const host = "panel.example.com";
    const issued = join(certificates, "acme.example", host);
    await Deno.mkdir(issued, { recursive: true });
    const crt = join(issued, `${host}.crt`);
    await Deno.writeFile(crt, new TextEncoder().encode("hidden"));
    await Deno.chmod(crt, 0o000);
    await syncInstanceAcmeHttp01Site(layout, {
      entries: [{
        host,
        source: "lets-encrypt",
        certId: "",
      }],
      reload: () => Promise.resolve(),
    });
    await Deno.chmod(crt, 0o644);
    const written = await Deno.readTextFile(dest);
    assertEquals(written.includes("127.0.0.1:8444"), false);
  } finally {
    await Deno.chmod(certificates, 0o755);
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site skips a leaf sudo cannot read", async () => {
  const host = "panel.example.com";
  const { root, layout, dest } = await hostingFixture([{
    host,
    source: "lets-encrypt",
  }]);
  const issued = join(
    root,
    "caddy",
    ".local",
    "share",
    "caddy",
    "certificates",
    "acme.example",
    host,
  );
  await Deno.mkdir(issued, { recursive: true });
  const crt = join(issued, `${host}.crt`);
  await Deno.writeFile(crt, new TextEncoder().encode("hidden"));
  await Deno.writeFile(
    join(issued, `${host}.key`),
    new TextEncoder().encode("key"),
  );
  await Deno.chmod(crt, 0o000);
  const previous = Deno.env.get("PATH") ?? "";
  const empty = await Deno.makeTempDir({ prefix: "tp-no-sudo-" });
  Deno.env.set("PATH", empty);
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      reload: () => Promise.resolve(),
    });
    const written = await Deno.readTextFile(dest);
    assertEquals(written.includes("127.0.0.1:8444"), false);
    const nonce = "ab".repeat(16);
    await preflightInstanceLetsEncryptHttp01(
      [{ host, source: "lets-encrypt" }],
      { configDir: root } as LayoutPaths,
      {
        nonce: () => nonce,
        syncChallenge: () => Promise.resolve(),
        reloadControlPlane: () => Promise.resolve(),
        fetchImpl: (() =>
          Promise.resolve(
            new Response(nonce, { status: 200 }),
          )) as typeof fetch,
      },
    );
  } finally {
    Deno.env.set("PATH", previous);
    await Deno.chmod(crt, 0o644);
    await Deno.remove(empty, { recursive: true });
    await Deno.remove(root, { recursive: true });
  }
});

test("syncInstanceAcmeHttp01Site skips uploaded names without a usable certificate id", async () => {
  const { root, layout, dest } = await hostingFixture([]);
  const certDir = join(root, "tls", "certs");
  await Deno.mkdir(certDir, { recursive: true });
  await Deno.writeTextFile(join(certDir, "uploaded.crt"), "bare-cert\n");
  await Deno.writeTextFile(join(certDir, "uploaded.key"), "bare-key\n");
  try {
    await syncInstanceAcmeHttp01Site(layout, {
      entries: [{
        host: "panel.example.com",
        source: "uploaded",
        certId: "not-a-uuid",
      }],
      reload: () => Promise.resolve(),
    });
    let present = true;
    try {
      await Deno.stat(dest);
    } catch (err) {
      present = !(err instanceof Deno.errors.NotFound);
    }
    assertEquals(present, false);

    await syncInstanceAcmeHttp01Site(
      { configDir: root } as LayoutPaths,
      {
        entries: [{
          host: "panel.example.com",
          source: "uploaded",
          certId: "",
        }],
        reload: () => Promise.resolve(),
      },
    );
    assertEquals(present, false);

    await syncInstanceAcmeHttp01Site(layout, {
      entries: [{
        host: "panel.example.com",
        source: "uploaded",
        certId: "",
      }],
      reload: () => Promise.resolve(),
    });
    const written = await Deno.readTextFile(dest);
    assertEquals(written.includes("uploaded.crt"), true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("the default hosting and control-plane reloads tolerate a missing sudo", async () => {
  const { root, layout } = await hostingFixture([{
    host: "panel.example.com",
    source: "lets-encrypt",
  }]);
  const caddyfile = join(root, "caddy", "Caddyfile");
  await Deno.writeTextFile(caddyfile, ":8880 {\n\tredir https://example\n}\n");
  const nonce = "ef".repeat(16);
  const fetchImpl =
    (() =>
      Promise.resolve(new Response(nonce, { status: 200 }))) as typeof fetch;
  try {
    await withSudo("#!/bin/sh\nexit 1\n", async () => {
      await syncInstanceAcmeHttp01Site(layout);
      await preflightInstanceLetsEncryptHttp01(
        [{ host: "panel.example.com", source: "lets-encrypt" }],
        layout,
        {
          nonce: () => nonce,
          syncChallenge: () => Promise.resolve(),
          fetchImpl,
        },
      );
    });
    const empty = await Deno.makeTempDir({ prefix: "tp-no-sudo-" });
    const previous = Deno.env.get("PATH") ?? "";
    Deno.env.set("PATH", empty);
    try {
      await syncInstanceAcmeHttp01Site(layout, {
        entries: [],
      });
      await preflightInstanceLetsEncryptHttp01(
        [{ host: "panel.example.com", source: "lets-encrypt" }],
        layout,
        {
          nonce: () => nonce,
          syncChallenge: () => Promise.resolve(),
          fetchImpl,
        },
      );
    } finally {
      Deno.env.set("PATH", previous);
      await Deno.remove(empty, { recursive: true });
    }
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("preflight rejects a non-DNS name, a blocked Caddyfile, and a mismatched nonce", async () => {
  await assertRejects(
    () =>
      preflightInstanceLetsEncryptHttp01(
        [{ host: "   ", source: "lets-encrypt" }],
        { configDir: "unused-config" } as LayoutPaths,
        { syncChallenge: () => Promise.resolve() },
      ),
    InstanceAcmeHttp01PreflightError,
    "not a DNS name",
  );

  const root = await Deno.makeTempDir({ prefix: "tp-acme-caddyfile-" });
  await Deno.mkdir(join(root, "caddy", "Caddyfile"), { recursive: true });
  try {
    await assertRejects(
      () =>
        preflightInstanceLetsEncryptHttp01(
          [{ host: "panel.example.com", source: "lets-encrypt" }],
          { configDir: root } as LayoutPaths,
          { syncChallenge: () => Promise.resolve() },
        ),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }

  const nonce = instanceAcmePreflightNonce();
  assertEquals(/^[0-9a-f]{32}$/.test(nonce), true);
  assertEquals(
    withInstanceAcmePreflightHandle("example.com {\n}\n", "/tmp/preflight"),
    "example.com {\n}\n",
  );

  await assertRejects(
    () =>
      verifyInstanceAcmeHttp01Reachability("panel.example.com", nonce, {
        fetchImpl: (() =>
          Promise.resolve(
            new Response("other", { status: 200 }),
          )) as typeof fetch,
      }),
    InstanceAcmeHttp01PreflightError,
    "body did not match the nonce",
  );
  await assertRejects(
    () =>
      verifyInstanceAcmeHttp01Reachability("panel.example.com", nonce, {
        fetchImpl: ((input: string | URL | Request) => {
          if (String(input).includes("127.0.0.1")) {
            return Promise.resolve(new Response(nonce, { status: 200 }));
          }
          return Promise.resolve(new Response("other", { status: 200 }));
        }) as typeof fetch,
      }),
    InstanceAcmeHttp01PreflightError,
    "body did not match the nonce",
  );
  await assertRejects(
    () =>
      verifyInstanceAcmeHttp01Reachability("panel.example.com", nonce, {
        fetchImpl: (() => Promise.reject(new Error("refused"))) as typeof fetch,
      }),
    InstanceAcmeHttp01PreflightError,
    "refused",
  );
});

test("preflightInstanceLetsEncryptHttp01 skips hostnames that are not Let's Encrypt", async () => {
  let fetched = 0;
  await preflightInstanceLetsEncryptHttp01(
    [{ host: "panel.example.com", source: "platform-ca" }],
    { configDir: "unused-config" } as LayoutPaths,
    {
      fetchImpl: (() => {
        fetched += 1;
        return Promise.resolve(new Response("nope", { status: 500 }));
      }) as typeof fetch,
    },
  );
  assertEquals(fetched, 0);
});
