import { assertEquals } from "@std/assert";
import {
  ensureNamedVolumeOwners,
  type NamedVolumeOwnerPlan,
  namedVolumeOwnerTargets,
} from "./named-volume-owner.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const OWNER = "30001:30001";

function vol(source: string, target: string, extra: object = {}) {
  return { type: "volume", source, target, ...extra };
}

const resolved = {
  web: {
    image: "nginx:1",
    volumes: [vol("data", "/usr/share/nginx/html")],
  },
  root: { image: "alpine", volumes: [vol("r", "/r")] },
};

test("a service the daemon runs as the owner gets its named volume mount path, once", () => {
  const plan = namedVolumeOwnerTargets(
    {
      web: { user: OWNER, volumes: [vol("uploads", "/uploads")] },
      root: { user: "0:0" },
    },
    resolved,
    {},
    "proj",
  );
  assertEquals(plan.skipped, []);
  assertEquals(
    plan.targets.map((t) => [t.composeServiceName, t.target, t.image]),
    [
      ["web", "/usr/share/nginx/html", "nginx:1"],
      ["web", "/uploads", "nginx:1"],
    ],
  );
});

test("a service with no daemon-set user, or a non-numeric one, is left alone", () => {
  assertEquals(namedVolumeOwnerTargets({ web: {} }, resolved, {}).targets, []);
  assertEquals(
    namedVolumeOwnerTargets({ web: { user: "app" } }, resolved, {}).targets,
    [],
  );
  assertEquals(
    namedVolumeOwnerTargets(undefined, resolved, undefined).targets,
    [],
  );
});

test("root as uid or gid is refused", () => {
  for (
    const user of [
      "0:30001",
      "30001:0",
      "0:0",
      "00:1000",
      "1000:000",
      "01:1000",
    ]
  ) {
    assertEquals(
      namedVolumeOwnerTargets({ web: { user } }, resolved, {}).targets,
      [],
      user,
    );
  }
});

test("an external volume is skipped, with a reason", () => {
  const plan = namedVolumeOwnerTargets(
    { web: { user: OWNER } },
    resolved,
    { data: { external: true } },
  );
  assertEquals(plan.targets, []);
  assertEquals(plan.skipped.length, 1);
  assertEquals(plan.skipped[0]!.target, "/usr/share/nginx/html");
});

test("a read-only mount is skipped, with a reason", () => {
  const plan = namedVolumeOwnerTargets(
    { web: { user: OWNER } },
    {
      web: {
        image: "nginx:1",
        volumes: [vol("data", "/html", { read_only: true })],
      },
    },
    {},
  );
  assertEquals(plan.targets, []);
  assertEquals(plan.skipped[0]!.reason, "the mount is read-only");
});

test("a volume another service mounts as a different user is skipped", () => {
  const shared = {
    web: { image: "nginx:1", volumes: [vol("data", "/html")] },
    db: { image: "postgres", user: "999:999", volumes: [vol("data", "/d")] },
  };
  const plan = namedVolumeOwnerTargets({ web: { user: OWNER } }, shared, {});
  assertEquals(plan.targets, []);
  assertEquals(plan.skipped.length, 1);
  // The same volume shared with another service run as the same user is fine.
  const same = namedVolumeOwnerTargets(
    { web: { user: OWNER }, db: { user: OWNER } },
    shared,
    {},
  );
  assertEquals(same.targets.map((t) => t.composeServiceName), ["db"]);
});

test("the volume of a plain compose file, as the control plane sends it, is selected once", () => {
  // The canary shape: the authored key is replaced by the storage id and pinned
  // with `name`; the daemon's overlay adds a long-form duplicate mount.
  const id = "01a15611-eee5-7af5-988a-917c1a5d3a6a";
  const plan = namedVolumeOwnerTargets(
    {
      store: {
        user: "30002:30002",
        volumes: [vol(id, "/vol")],
      },
    },
    {
      store: {
        image: "busybox:1.36",
        volumes: [
          vol(id, "/vol", { volume: {} }),
          {
            type: "bind",
            source: "/srv/users/o/production/volumes/b",
            target: "/bind",
          },
        ],
      },
    },
    { [id]: { name: id } },
    "proj",
    new Set([id]),
  );
  assertEquals(plan.skipped, []);
  assertEquals(
    plan.targets.map((t) => [t.composeServiceName, t.target, t.user]),
    [
      ["store", "/vol", "30002:30002"],
    ],
  );
});

test("a volume the platform created is not external to it, an authored external one still is", () => {
  const id = "01a15611-eee5-7af5-988a-917c1a5d3a6a";
  const services = {
    store: { image: "busybox:1.36", volumes: [vol(id, "/vol")] },
  };
  const overlay = { store: { user: "30002:30002" } };
  const external = { [id]: { name: id, external: true } };
  assertEquals(
    namedVolumeOwnerTargets(overlay, services, external, "p", new Set([id]))
      .targets.length,
    1,
  );
  assertEquals(
    namedVolumeOwnerTargets(overlay, services, external, "p", new Set())
      .targets.length,
    0,
  );
});

const target = {
  composeServiceName: "web",
  user: OWNER,
  target: "/a",
  image: "nginx:1",
  buildOnly: false,
};

function options(
  run: (args: string[]) => Promise<
    { success: boolean; code: number; stdout: string; stderr: string }
  >,
  lines: string[],
) {
  return {
    projectName: "proj",
    composePaths: ["/c/compose.yaml"],
    run,
    log: (line: string) => lines.push(line),
  };
}

const done = { success: true, code: 0, stdout: "", stderr: "" };
const failed = { success: false, code: 1, stdout: "", stderr: "no such\n" };

test("each target is chowned once through the service's own image, never pulling or building in the run", async () => {
  const calls: string[][] = [];
  const lines: string[] = [];
  const plan: NamedVolumeOwnerPlan = {
    targets: [target, { ...target, target: "/b" }],
    skipped: [],
  };
  await ensureNamedVolumeOwners(
    plan,
    options((args) => {
      calls.push(args);
      return Promise.resolve(done);
    }, lines),
  );
  const runs = calls.filter((c) => c.includes("run"));
  assertEquals(runs.length, 2);
  assertEquals(runs[0]!.slice(0, 5), [
    "compose",
    "-p",
    "proj",
    "-f",
    "/c/compose.yaml",
  ]);
  assertEquals(runs[0]!.slice(5, 14), [
    "run",
    "--pull",
    "never",
    "--rm",
    "--no-deps",
    "-T",
    "--user",
    "0",
    "--entrypoint",
  ]);
  assertEquals(runs[0]!.slice(-3), ["web", OWNER, "/a"]);
  assertEquals(lines, [
    `gave /a of web to ${OWNER}`,
    `gave /b of web to ${OWNER}`,
  ]);
});

test("a failed chown only logs, and the next target still runs", async () => {
  const lines: string[] = [];
  let runs = 0;
  await ensureNamedVolumeOwners(
    { targets: [target, { ...target, target: "/b" }], skipped: [] },
    options((args) => {
      if (!args.includes("run")) return Promise.resolve(done);
      runs += 1;
      return Promise.resolve(runs === 1 ? failed : done);
    }, lines),
  );
  assertEquals(runs, 2);
  assertEquals(lines.length, 2);
  assertEquals(lines[1], `gave /b of web to ${OWNER}`);
});

test("a missing image only logs: a registry image is pulled once, a built one never", async () => {
  const lines: string[] = [];
  const calls: string[][] = [];
  const missing = (args: string[]) => {
    calls.push(args);
    return Promise.resolve(failed);
  };
  await ensureNamedVolumeOwners(
    { targets: [target], skipped: [] },
    options(missing, lines),
  );
  assertEquals(calls.filter((c) => c.includes("pull")).length, 1);
  assertEquals(calls.some((c) => c.includes("run")), false);
  assertEquals(lines.length, 1);

  calls.length = 0;
  await ensureNamedVolumeOwners(
    { targets: [{ ...target, buildOnly: true }], skipped: [] },
    options(missing, []),
  );
  assertEquals(
    calls.some((c) => c.includes("pull") || c.includes("run")),
    false,
  );
});

test("a skipped mount is reported in the log and not run", async () => {
  const lines: string[] = [];
  const calls: string[][] = [];
  await ensureNamedVolumeOwners(
    {
      targets: [],
      skipped: [{
        composeServiceName: "web",
        target: "/html",
        reason: "the mount is read-only",
      }],
    },
    options((args) => {
      calls.push(args);
      return Promise.resolve(done);
    }, lines),
  );
  assertEquals(calls, []);
  assertEquals(lines.length, 1);
});
