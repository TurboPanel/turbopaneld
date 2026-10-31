import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type { LayoutPaths } from "../paths/layout.ts";
import {
  applyProofRoutes,
  dropReservedProofSitesFor,
  normalizeProofTarget,
  parseProofHeader,
  proofDir,
  proofHandlerPath,
  proofImportPattern,
  proofSiteState,
  proofTargetUpstream,
  renderProofHandler,
  reservedProofSiteName,
  startProofForward,
  withdrawProofForwards,
} from "./acme-proof-forward.ts";
import type {
  CommandResult,
  InstanceAcmeCommand,
} from "./instance-acme-http01.ts";
import { siteSnippet } from "./ingress.ts";

const test = Deno.test.bind(Deno);

const EXPIRES = "2030-01-01T00:00:00.000Z";

function layoutUnder(root: string): LayoutPaths {
  return {
    configDir: join(root, "config"),
    stateDir: join(root, "state"),
    logDir: join(root, "log"),
    runDir: join(root, "run"),
    tlsDir: join(root, "tls"),
  } as LayoutPaths;
}

function ok(stdout = ""): CommandResult {
  return { ok: true, stdout, stderr: "" };
}

/** Records every host command; hosting Caddy always owns port 80. */
function recorder(): { calls: string[]; run: InstanceAcmeCommand } {
  const calls: string[] = [];
  return {
    calls,
    run: (_program, args) => {
      calls.push(args.join(" "));
      return Promise.resolve(ok());
    },
  };
}

const onPort80 = () => Promise.resolve({ kind: "hosting-caddy" as const });

async function withLayout(
  fn: (layout: LayoutPaths, root: string) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-proof-forward-" });
  try {
    await fn(layoutUnder(root), root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function writeSite(layout: LayoutPaths, name: string, text: string) {
  const dir = join(layout.configDir, "hosting", "sites");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(join(dir, name), text);
}

function siteWithProof(layout: LayoutPaths, hostname: string): string {
  return siteSnippet({
    hostname,
    tlsDir: layout.tlsDir,
    proofDir: proofDir(layout),
  });
}

test("normalizeProofTarget keeps public addresses and refuses the rest", () => {
  assertEquals(normalizeProofTarget(" 203.0.113.9 "), "203.0.113.9");
  assertEquals(normalizeProofTarget("2001:DB8::1"), "2001:db8::1");
  for (
    const bad of [
      "127.0.0.1",
      "0.0.0.0",
      "169.254.1.1",
      "224.0.0.1",
      "::1",
      "::ffff:127.0.0.1",
      "::",
      "fe80::1",
      "ff02::1",
      "not-an-address",
      "1.2.3",
      "",
    ]
  ) {
    assertEquals(normalizeProofTarget(bad), null, bad);
  }
});

test("proofTargetUpstream brackets IPv6", () => {
  assertEquals(proofTargetUpstream("203.0.113.9"), "http://203.0.113.9:80");
  assertEquals(proofTargetUpstream("2001:db8::1"), "http://[2001:db8::1]:80");
});

test("proofImportPattern refuses names a glob could misread", () => {
  assertEquals(
    proofImportPattern("/c/hosting/proof", "example.com"),
    "/c/hosting/proof/example.com/*.proof",
  );
  assertEquals(proofImportPattern("/c/p", "*.example.com"), null);
  assertEquals(proofImportPattern("/c/p", "a b"), null);
});

test("the proof header round-trips and other files are ignored", () => {
  const text = renderProofHandler("req_1", EXPIRES, "http://203.0.113.9:80");
  assertEquals(parseProofHeader(text), {
    requestId: "req_1",
    expiresAtMs: Date.parse(EXPIRES),
  });
  assertStringIncludes(text, "header_up Host {http.request.host}");
  assertEquals(parseProofHeader("handle {\n}\n"), null);
  assertEquals(
    parseProofHeader("# tp-proof-forward request=a b expires=x\n"),
    null,
  );
});

test("a site written with a proof directory imports the handler before the redirect", () => {
  const text = siteSnippet({
    hostname: "example.com",
    tlsDir: "/tls",
    proofDir: "/c/hosting/proof",
  });
  const http = text.split("\n\n")[0];
  assertStringIncludes(http, "import /c/hosting/proof/example.com/*.proof");
  assertStringIncludes(
    http,
    "handle {\n    redir https://{host}{uri} permanent",
  );
  assertEquals(
    http.indexOf("import ") < http.indexOf("redir"),
    true,
  );
});

test("a site written without a proof directory is unchanged", () => {
  const text = siteSnippet({ hostname: "example.com", tlsDir: "/tls" });
  assertStringIncludes(
    text,
    "http://example.com {\n  redir https://{host}{uri} permanent\n}",
  );
});

test("a www redirect block and a plain-HTTP-only block both import the handler", () => {
  const redirect = siteSnippet({
    hostname: "www.example.com",
    tlsDir: "/tls",
    proofDir: "/p",
    redirectTo: "example.com",
  });
  assertStringIncludes(redirect, "import /p/www.example.com/*.proof");
  assertStringIncludes(
    redirect,
    "handle {\n    redir https://example.com{uri} permanent",
  );
  const plain = siteSnippet({
    hostname: "example.com",
    tlsDir: "/tls",
    proofDir: "/p",
    forceHttps: false,
  });
  assertStringIncludes(
    plain,
    "http://example.com {\n  import /p/example.com/*.proof",
  );
});

test("proofSiteState tells a current block, an older block and no block apart", () => {
  const pattern = "/p/example.com/*.proof";
  const current = `http://example.com {\n  import ${pattern}\n}\n`;
  const older =
    "http://example.com {\n  redir https://{host}{uri} permanent\n}\n";
  assertEquals(proofSiteState([current], "example.com", pattern), "imports");
  assertEquals(proofSiteState([older], "example.com", pattern), "stale");
  assertEquals(proofSiteState([older], "other.example", pattern), "none");
  assertEquals(proofSiteState([], "example.com", pattern), "none");
});

test("startProofForward writes the handler into the per-host file and reloads", async () => {
  await withLayout(async (layout) => {
    await writeSite(layout, "env.caddy", siteWithProof(layout, "example.com"));
    const { calls, run } = recorder();
    const result = await startProofForward(layout, {
      requestId: "req_1",
      names: ["example.com"],
      targetAddress: "203.0.113.9",
      expiresAtIso: EXPIRES,
    }, {
      run,
      inspect: onPort80,
      localAddresses: () => ["198.51.100.4"],
      now: () => Date.parse("2029-01-01T00:00:00Z"),
    });
    assertEquals(result, { ok: true });
    const written = await Deno.readTextFile(
      proofHandlerPath(proofDir(layout), "example.com"),
    );
    assertStringIncludes(written, "reverse_proxy http://203.0.113.9:80");
    assertEquals(calls.some((c) => c.includes("systemctl reload")), true);
  });
});

test("a name with no site block gets a reserved site, claimed by the later deploy", async () => {
  await withLayout(async (layout) => {
    const { run } = recorder();
    const result = await applyProofRoutes(layout, {
      requestId: "req_2",
      names: ["new.example.com"],
      upstream: "http://203.0.113.9:80",
      expiresAtIso: EXPIRES,
    }, { run, inspect: onPort80 });
    assertEquals(result, { ok: true });
    const sitesDir = join(layout.configDir, "hosting", "sites");
    const reserved = join(sitesDir, reservedProofSiteName("req_2"));
    assertStringIncludes(
      await Deno.readTextFile(reserved),
      "http://new.example.com {",
    );
    await dropReservedProofSitesFor(sitesDir, new Set(["new.example.com"]));
    assertEquals(await Deno.stat(reserved).catch(() => null), null);
  });
});

test("a site written before the import existed is refused and nothing stays written", async () => {
  await withLayout(async (layout) => {
    await writeSite(
      layout,
      "env.caddy",
      "http://old.example.com {\n  redir https://{host}{uri} permanent\n}\n",
    );
    const { run } = recorder();
    const result = await applyProofRoutes(layout, {
      requestId: "req_3",
      names: ["old.example.com"],
      upstream: "http://203.0.113.9:80",
      expiresAtIso: EXPIRES,
    }, { run, inspect: onPort80 });
    assertEquals(result.ok, false);
    assertEquals(
      await Deno.stat(proofHandlerPath(proofDir(layout), "old.example.com"))
        .catch(
          () => null,
        ),
      null,
    );
  });
});

test("startProofForward refuses a target that is this server, an unusable one and an expired request", async () => {
  await withLayout(async (layout) => {
    const base = {
      requestId: "req_4",
      names: ["example.com"],
      expiresAtIso: EXPIRES,
    };
    const deps = {
      localAddresses: () => ["203.0.113.9"],
      now: () => Date.parse("2029-01-01T00:00:00Z"),
    };
    const self = await startProofForward(layout, {
      ...base,
      targetAddress: "203.0.113.9",
    }, deps);
    assertEquals(self.ok, false);
    const bad = await startProofForward(layout, {
      ...base,
      targetAddress: "127.0.0.1",
    }, deps);
    assertEquals(bad.ok, false);
    const late = await startProofForward(layout, {
      ...base,
      targetAddress: "203.0.113.10",
    }, { ...deps, now: () => Date.parse("2031-01-01T00:00:00Z") });
    assertEquals(late.ok, false);
  });
});

test("port 80 held by another program fails the forward with a plain reason", async () => {
  await withLayout(async (layout) => {
    await writeSite(layout, "env.caddy", siteWithProof(layout, "example.com"));
    const { run } = recorder();
    const result = await applyProofRoutes(layout, {
      requestId: "req_5",
      names: ["example.com"],
      upstream: "http://203.0.113.9:80",
      expiresAtIso: EXPIRES,
    }, {
      run,
      inspect: () => Promise.resolve({ kind: "other", process: "otherserver" }),
    });
    assertEquals(result.ok, false);
    if (!result.ok) assertStringIncludes(result.reason, "otherserver");
  });
});

test("withdrawProofForwards removes by request id and by expiry, and keeps the rest", async () => {
  await withLayout(async (layout) => {
    const dir = proofDir(layout);
    await Deno.mkdir(join(dir, "a.example.com"), { recursive: true });
    await Deno.mkdir(join(dir, "b.example.com"), { recursive: true });
    await Deno.writeTextFile(
      proofHandlerPath(dir, "a.example.com"),
      renderProofHandler(
        "req_a",
        "2020-01-01T00:00:00Z",
        "http://203.0.113.9:80",
      ),
    );
    await Deno.writeTextFile(
      proofHandlerPath(dir, "b.example.com"),
      renderProofHandler("req_b", EXPIRES, "http://203.0.113.9:80"),
    );
    await writeSite(layout, "env.caddy", "# a site\n");
    const { run } = recorder();
    const now = Date.parse("2029-01-01T00:00:00Z");
    assertEquals(
      await withdrawProofForwards(layout, { expiredBeforeMs: now }, { run }),
      1,
    );
    assertEquals(
      await Deno.stat(proofHandlerPath(dir, "a.example.com")).catch(() => null),
      null,
    );
    assertEquals(
      await withdrawProofForwards(layout, { requestId: "req_other" }, { run }),
      0,
    );
    assertEquals(
      await withdrawProofForwards(layout, { requestId: "req_b" }, { run }),
      1,
    );
  });
});

test("a host's import cannot match a longer lookalike name's handler", () => {
  const dir = "/c/hosting/proof";
  const victim = proofImportPattern(dir, "victim.com")!;
  const lookalike = proofHandlerPath(dir, "victim.com.proof.evil.com");
  // Glob `*` does not cross a `/`, and the host folder is spelled out exactly.
  const re = new RegExp(
    `^${victim.replace(/[.]/g, "\\.").replace("*", "[^/]*")}$`,
  );
  assertEquals(re.test(lookalike), false);
  assertEquals(re.test(proofHandlerPath(dir, "victim.com")), true);
});

test("each host gets its own folder and a withdraw removes the folder too", async () => {
  await withLayout(async (layout) => {
    await writeSite(layout, "e.caddy", siteWithProof(layout, "victim.com"));
    await writeSite(
      layout,
      "f.caddy",
      siteWithProof(layout, "victim.com.proof.evil.com"),
    );
    const { run } = recorder();
    for (
      const [id, host] of [["r1", "victim.com"], [
        "r2",
        "victim.com.proof.evil.com",
      ]]
    ) {
      const result = await applyProofRoutes(layout, {
        requestId: id,
        names: [host],
        upstream: `http://203.0.113.${id === "r1" ? 9 : 10}:80`,
        expiresAtIso: EXPIRES,
      }, { run, inspect: onPort80 });
      assertEquals(result, { ok: true });
    }
    const dir = proofDir(layout);
    assertStringIncludes(
      await Deno.readTextFile(proofHandlerPath(dir, "victim.com")),
      "203.0.113.9",
    );
    assertEquals(
      await withdrawProofForwards(layout, { requestId: "r1" }, { run }),
      1,
    );
    assertEquals(
      await Deno.stat(join(dir, "victim.com")).catch(() => null),
      null,
    );
    assertStringIncludes(
      await Deno.readTextFile(
        proofHandlerPath(dir, "victim.com.proof.evil.com"),
      ),
      "203.0.113.10",
    );
  });
});

const LOOPBACK_AND_FRIENDS_IN_ANY_SPELLING = [
  "0:0:0:0:0:ffff:7f00:1",
  "0::ffff:127.0.0.1",
  "0:0:0:0:0:0:0:1",
  "::0:1",
  "0:0::0",
  "::127.0.0.1",
  "0064:ff9b::7f00:1",
  "64:ff9b::7f00:1",
  "64:ff9b:1::1",
  "[::1]",
  "[::ffff:127.0.0.1]",
  "::1%lo",
  "fe80:0:0:0::1",
  "fe80::1%eth0",
  "febf::1",
  "FF02::1",
  "ff00:0:0::1",
  "::ffff:10.0.0.1",
  "::ffff:0:127.0.0.1",
  "127.1",
  "2130706433",
  "0177.0.0.1",
  "255.255.255.255",
  "1::2::3",
  "12345::1",
];

test("no spelling of a loopback, mapped, NAT64, link-local or multicast address gets through", () => {
  for (const bad of LOOPBACK_AND_FRIENDS_IN_ANY_SPELLING) {
    assertEquals(normalizeProofTarget(bad), null, bad);
  }
});

test("public and private LAN addresses stay allowed, brackets and zone ids dropped", () => {
  assertEquals(normalizeProofTarget("2001:db8::1"), "2001:db8::1");
  assertEquals(normalizeProofTarget("[2001:DB8::5]"), "2001:db8::5");
  assertEquals(normalizeProofTarget("fd00::1"), "fd00::1");
  assertEquals(normalizeProofTarget("fc00::1"), "fc00::1");
  assertEquals(normalizeProofTarget("2001:db8::1.2.3.4"), "2001:db8::1.2.3.4");
  assertEquals(normalizeProofTarget("10.0.0.5"), "10.0.0.5");
  assertEquals(normalizeProofTarget("172.16.0.9"), "172.16.0.9");
  assertEquals(normalizeProofTarget("192.168.1.1"), "192.168.1.1");
  assertEquals(normalizeProofTarget("203.0.113.9"), "203.0.113.9");
});
