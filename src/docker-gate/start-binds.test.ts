import { assertEquals } from "@std/assert";
import { APPROVAL_LABEL } from "../../orchestration/roles/docker-gate/files/approval.ts";
import {
  generateKeys,
  payloadFor,
  signToken,
} from "../testing/docker-gate-approval.ts";
import {
  DEFAULT_POLICY_CONFIG,
  evaluateRequest,
  evaluateStartBinds,
  type ResolvePath,
} from "../../orchestration/roles/docker-gate/files/policy.ts";
import { review } from "../../orchestration/roles/docker-gate/files/review.ts";
import { fetchContainerDoc } from "../../orchestration/roles/docker-gate/files/inspect.ts";
import { GateStats } from "../../orchestration/roles/docker-gate/files/stats.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const same: ResolvePath = (path) => Promise.resolve(path);

function createRules(
  binds: string[],
  resolve: ResolvePath = same,
): Promise<string[]> {
  return evaluateRequest(
    {
      method: "POST",
      path: "/containers/create",
      query: new URLSearchParams(),
      body: {
        Labels: { "com.docker.compose.project": "app" },
        HostConfig: { Binds: binds },
      },
    },
    DEFAULT_POLICY_CONFIG,
    resolve,
  ).then((found) => found.map((v) => v.rule));
}

test("the site owner's data places bind, nothing else under their home does", async () => {
  const ok = [
    "/srv/users/alice/data",
    "/srv/users/alice/data/app/db",
    "/srv/users/alice/tmp",
    "/srv/users/alice/volumes/0f1e",
    "/srv/users/alice/sites/s1/shared",
    "/srv/users/alice/sites/s1/shared/uploads",
    "/srv/users/alice/sites/s1/webroot",
    "/srv/users/alice/sites/s1/releases/r1",
  ];
  for (const source of ok) {
    assertEquals(await createRules([`${source}:/x`]), [], source);
  }
  const refused = [
    "/srv/users",
    "/srv/users/alice",
    "/srv/users/alice/home",
    "/srv/users/alice/home/.ssh",
    "/srv/users/alice/sites",
    "/srv/users/alice/sites/s1",
    "/srv/users/alice/sites/s1/.turbopanel-hosting",
    "/srv/users/alice/sites/s1/current/../x",
    "/srv/users/alice/volumes",
    "/srv/users/.tp-staging/alice.s1.r1/data",
    "/srv/users/alice/datax",
  ];
  for (const source of refused) {
    const rules = await createRules([`${source}:/x`]);
    assertEquals(rules.length, 1, source);
    assertEquals(
      rules[0] === "bind-principal-path" ||
        rules[0] === "bind-noncanonical-path",
      true,
      `${source}: ${rules[0]}`,
    );
  }
});

test("a symlink out of an allowed place is judged by where it lands", async () => {
  const links: Record<string, string> = {
    "/srv/users/alice/data/out": "/etc/turbopanel",
    "/srv/users/alice/data/up": "/srv/users/alice/home",
    "/srv/users/alice/tmp/other": "/srv/users/bob/home",
    "/srv/users/alice/data/in": "/srv/users/alice/tmp/ok",
  };
  const resolve: ResolvePath = (path) => Promise.resolve(links[path] ?? path);
  assertEquals(await createRules(["/srv/users/alice/data/out:/x"], resolve), [
    "bind-forbidden-path",
  ]);
  assertEquals(await createRules(["/srv/users/alice/data/up:/x"], resolve), [
    "bind-principal-path",
  ]);
  assertEquals(await createRules(["/srv/users/alice/tmp/other:/x"], resolve), [
    "bind-principal-path",
  ]);
  assertEquals(await createRules(["/srv/users/alice/data/in:/x"], resolve), []);
});

const doc = (hostConfig: Record<string, unknown>, mounts: unknown[] = []) => ({
  labels: { "com.docker.compose.project": "app" },
  hostConfig,
  mounts,
});

test("the start check applies the bind policy to HostConfig and the live mounts, once per finding", async () => {
  const verdict = await evaluateStartBinds(
    doc({ Binds: ["/etc:/a", "/srv/users/alice/data:/b"] }, [
      { Type: "bind", Source: "/etc", ReadOnly: false },
      { Type: "bind", Source: "/srv/users/alice/home", ReadOnly: false },
    ]),
    DEFAULT_POLICY_CONFIG,
    same,
  );
  assertEquals(verdict.violations, [
    { rule: "start-bind-forbidden-path", detail: "/etc" },
    { rule: "start-bind-principal-path", detail: "/srv/users/alice/home" },
  ]);
});

test("a source that resolves elsewhere by start time is refused (symlink swapped after create)", async () => {
  let swapped = false;
  const resolve: ResolvePath = (path) =>
    Promise.resolve(
      swapped && path === "/srv/users/alice/data/x" ? "/etc/turbopanel" : path,
    );
  const binds = ["/srv/users/alice/data/x:/x"];
  assertEquals(await createRules(binds, resolve), []);
  swapped = true;
  const verdict = await evaluateStartBinds(
    doc({ Binds: binds }),
    DEFAULT_POLICY_CONFIG,
    resolve,
  );
  assertEquals(verdict.violations.map((v) => v.rule), [
    "start-bind-forbidden-path",
  ]);
});

/** One-shot engine answering every connection with `body` as the inspect answer. */
async function withInspect<T = void>(
  body: unknown,
  fn: (connect: () => Promise<Deno.Conn>) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "tp-gate-start-" });
  const path = `${dir}/engine.sock`;
  const listener = Deno.listen({ transport: "unix", path });
  const payload = JSON.stringify(body);
  const serving = (async () => {
    for await (const conn of listener) {
      const buf = new Uint8Array(4096);
      await conn.read(buf);
      await conn.write(
        new TextEncoder().encode(
          `HTTP/1.1 200 OK\r\nContent-Length: ${payload.length}\r\n\r\n${payload}`,
        ),
      );
      conn.close();
    }
  })();
  try {
    return await fn(() => Deno.connect({ transport: "unix", path }));
  } finally {
    listener.close();
    await serving.catch(() => {});
    await Deno.remove(dir, { recursive: true });
  }
}

const opts = { sanitizeOps: false, sanitizeResources: false };

test({
  name: "inspect keeps live bind mounts only, as specs",
  ...opts,
  fn: () =>
    withInspect(
      {
        Config: { Labels: { a: "b" } },
        HostConfig: { Binds: ["/x:/y"] },
        Mounts: [
          { Type: "bind", Source: "/m", RW: false },
          { Type: "volume", Source: "/var/lib/docker/volumes/v", RW: true },
        ],
      },
      async (connect) => {
        assertEquals(await fetchContainerDoc(connect, "c"), {
          labels: { a: "b" },
          hostConfig: { Binds: ["/x:/y"] },
          mounts: [{ Type: "bind", Source: "/m", ReadOnly: true }],
        });
      },
    ),
});

test({
  name:
    "a start review inspects once: unlabeled owner and bad binds both surface",
  ...opts,
  fn: () =>
    withInspect(
      { Config: { Labels: {} }, HostConfig: { Binds: ["/root:/r"] } },
      async (connect) => {
        const findings = await review(
          {
            method: "POST",
            path: "/containers/c/start",
            query: new URLSearchParams(),
          },
          "containers.action",
          {
            policy: DEFAULT_POLICY_CONFIG,
            resolvePath: same,
            log: () => {},
            stats: new GateStats(),
            connectUpstream: connect,
          },
        );
        assertEquals(findings.map((f) => f.rule), [
          "unowned-container",
          "start-bind-forbidden-path",
        ]);
      },
    ),
});

test({
  name:
    "a container's own signed approval still covers its approved feature at restart, long after the token expired",
  ...opts,
  fn: async () => {
    const keys = await generateKeys();
    const now = 1_000_000;
    const token = await signToken(
      keys,
      payloadFor(now, { project: "app", features: ["host-paths"] }),
    );
    const forged = await signToken(
      keys,
      payloadFor(now, { project: "other", features: ["host-paths"] }),
    );
    const run = (label: string) =>
      withInspect(
        {
          Config: {
            Labels: {
              "com.docker.compose.project": "app",
              [APPROVAL_LABEL]: label,
            },
          },
          HostConfig: { Binds: ["/mnt/shared:/s", "/root:/r"] },
        },
        async (connect) => {
          const findings = await review(
            {
              method: "POST",
              path: "/containers/c/restart",
              query: new URLSearchParams(),
            },
            "containers.action",
            {
              policy: DEFAULT_POLICY_CONFIG,
              resolvePath: same,
              log: () => {},
              stats: new GateStats(),
              connectUpstream: connect,
              approvalKeys: [keys.publicKey],
              nowSec: () => now + 10 * 86400,
            },
          );
          return findings.map((f) => f.rule);
        },
      );
    // `host-paths` covers the outside-roots bind, never the denied tree.
    assertEquals(await run(token), ["start-bind-forbidden-path"]);
    assertEquals(await run(forged), [
      "start-bind-outside-roots",
      "start-bind-forbidden-path",
    ]);
  },
});
