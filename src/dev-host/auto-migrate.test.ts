import { assert, assertEquals } from "@std/assert";
import type { DevHostPart, DevHostStatus } from "../contracts/cell-messages.ts";
import type { CommandResult, RunCommand } from "./commands.ts";
import {
  AUTO_MIGRATE_CHECK_MS,
  AutoMigrate,
  type AutoMigrateDeps,
  holdReason,
  manifestHashes,
  migrationGap,
  readAppliedHashes,
  readTrunkHashes,
} from "./auto-migrate.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const NOW = Date.parse("2026-11-05T12:00:00.000Z");

function part(
  name: DevHostPart["name"],
  extra: Partial<DevHostPart> = {},
): DevHostPart {
  return {
    name,
    unit: name,
    branch: "trunk",
    onTrunk: true,
    headCommit: "a".repeat(40),
    runningCommit: null,
    behindBy: 0,
    dirty: { files: 0, blocking: false, kinds: [] },
    restartNeeded: false,
    setupNeeded: {},
    active: true,
    ...extra,
  };
}

function status(parts: DevHostPart[] = []): DevHostStatus {
  const names: DevHostPart["name"][] = [
    "daemon",
    "control-plane",
    "web-interface",
    "website",
  ];
  const byName = new Map(parts.map((p) => [p.name, p]));
  return {
    parts: names.map((n) => byName.get(n) ?? part(n)),
    lastFetchAt: null,
    job: null,
  };
}

function controlPlaneReason(s: DevHostStatus): string | undefined {
  return s.parts.find((p) => p.name === "control-plane")?.blockedReason;
}

type Harness = {
  auto: AutoMigrate;
  starts: () => number;
  reads: () => number;
  set: (
    next: Partial<{ key: string; trunk: string[]; applied: string[] }>,
  ) => void;
  advance: (ms: number) => void;
};

function harness(
  overrides: Partial<AutoMigrateDeps> = {},
): Harness {
  let key = "t1..h1";
  let trunk = ["h0", "h1", "h2"];
  let applied = ["h0"];
  let now = NOW;
  let starts = 0;
  let reads = 0;
  const auto = new AutoMigrate({
    refsKey: () => Promise.resolve(key),
    trunkHashes: () => {
      reads++;
      return Promise.resolve(trunk);
    },
    appliedHashes: () => Promise.resolve(applied),
    startUpdate: () => {
      starts++;
      return Promise.resolve(true);
    },
    nowMs: () => now,
    ...overrides,
  });
  return {
    auto,
    starts: () => starts,
    reads: () => reads,
    set: (next) => {
      key = next.key ?? key;
      trunk = next.trunk ?? trunk;
      applied = next.applied ?? applied;
    },
    advance: (ms) => {
      now += ms;
    },
  };
}

test("the gap counts trunk migrations the database lacks", () => {
  assertEquals(migrationGap(["a", "b"], ["a", "b"]), { kind: "none" });
  assertEquals(migrationGap(["a", "b", "c"], ["a"]), {
    kind: "pending",
    count: 2,
  });
  assertEquals(migrationGap(["a", "b"], []), { kind: "pending", count: 2 });
  assertEquals(migrationGap(["a"], ["a", "x"]), { kind: "foreign" });
});

test("any part off trunk, dirty or blocked holds the job", () => {
  assertEquals(holdReason(status()), null);
  assertEquals(
    holdReason(status([part("website", { onTrunk: false, branch: "x" })])),
    "website is not on trunk",
  );
  assertEquals(
    holdReason(
      status([
        part("web-interface", {
          dirty: { files: 1, blocking: true, kinds: [] },
        }),
      ]),
    ),
    "web-interface has local changes",
  );
  assertEquals(
    holdReason(
      status([
        part("control-plane", {
          onTrunk: false,
          blockedReason: "detached HEAD, not trunk; not pulled",
        }),
      ]),
    ),
    "control-plane detached HEAD, not trunk; not pulled",
  );
});

test("a manifest gives its hashes in order; anything else is null", () => {
  assertEquals(
    manifestHashes(
      JSON.stringify({ entries: [{ sha256: "a" }, { sha256: "b" }] }),
    ),
    ["a", "b"],
  );
  assertEquals(manifestHashes("not json"), null);
  assertEquals(manifestHashes(JSON.stringify({ entries: [] })), null);
  assertEquals(manifestHashes(JSON.stringify({ entries: [{}] })), null);
});

test("pending trunk migrations with clean checkouts start Update and Restart once", async () => {
  const h = harness();
  const out = await h.auto.review(status());
  assertEquals(h.starts(), 1);
  assertEquals(controlPlaneReason(out), undefined);
  // Same trunk and HEAD (the job failed or left migrations): not again.
  const again = await h.auto.review(status());
  assertEquals(h.starts(), 1);
  assertEquals(
    controlPlaneReason(again),
    "trunk has 2 new migrations; the automatic update did not apply them (see the last job)",
  );
  // A new trunk commit is tried again.
  h.set({ key: "t2..h1", trunk: ["h0", "h1", "h2", "h3"] });
  await h.auto.review(status());
  assertEquals(h.starts(), 2);
});

test("a checkout with local changes holds the job and says why", async () => {
  const h = harness();
  const out = await h.auto.review(
    status([
      part("website", { dirty: { files: 2, blocking: true, kinds: [] } }),
    ]),
  );
  assertEquals(h.starts(), 0);
  assertEquals(
    controlPlaneReason(out),
    "trunk has 2 new migrations, not applied automatically: website has local changes",
  );
});

test("a detached control plane keeps its own reason and adds the hold", async () => {
  const h = harness();
  const out = await h.auto.review(
    status([
      part("control-plane", {
        onTrunk: false,
        branch: "",
        blockedReason: "detached HEAD, not trunk; not pulled",
      }),
    ]),
  );
  assertEquals(h.starts(), 0);
  assertEquals(
    controlPlaneReason(out),
    "detached HEAD, not trunk; not pulled; trunk has 2 new migrations, not applied automatically: control-plane detached HEAD, not trunk; not pulled",
  );
});

test("nothing pending, a running job or unreadable state starts nothing", async () => {
  const current = harness();
  current.set({ applied: ["h0", "h1", "h2"] });
  assertEquals(
    controlPlaneReason(await current.auto.review(status())),
    undefined,
  );
  assertEquals(current.starts(), 0);

  const running = harness();
  const busy = status();
  busy.job = {
    id: "j",
    action: "update",
    state: "running",
    step: "pull",
    steps: [],
    startedAt: new Date(NOW).toISOString(),
    endedAt: null,
    logTail: [],
  };
  await running.auto.review(busy);
  assertEquals(running.starts(), 0);
  assertEquals(running.reads(), 0, "no git or database read while a job runs");

  const unreadable = harness({ appliedHashes: () => Promise.resolve(null) });
  assertEquals(
    controlPlaneReason(await unreadable.auto.review(status())),
    undefined,
  );
  assertEquals(unreadable.starts(), 0);
});

test("a database with migrations trunk does not ship is never migrated automatically", async () => {
  const h = harness();
  h.set({ applied: ["h0", "branch-only"] });
  const out = await h.auto.review(status());
  assertEquals(h.starts(), 0);
  assertEquals(
    controlPlaneReason(out),
    "the database has migrations that are not on trunk; not migrating automatically",
  );
});

test("the comparison repeats only when refs move or after ten minutes", async () => {
  const h = harness();
  h.set({ applied: ["h0", "h1", "h2"] });
  await h.auto.review(status());
  await h.auto.review(status());
  assertEquals(h.reads(), 1);
  h.advance(AUTO_MIGRATE_CHECK_MS);
  await h.auto.review(status());
  assertEquals(h.reads(), 2);
  h.set({ key: "t2..h1" });
  await h.auto.review(status());
  assertEquals(h.reads(), 3);
});

function recordingRun(
  answer: CommandResult,
): { run: RunCommand; calls: { program: string; args: string[] }[] } {
  const calls: { program: string; args: string[] }[] = [];
  const run: RunCommand = (program, args) => {
    calls.push({ program, args });
    return Promise.resolve(answer);
  };
  return { run, calls };
}

/** A socket URL like the instance unit's, built from parts (no secret-shaped literal). */
function socketUrl(user = "turbopanel", db = "turbopanel"): string {
  const pw = ["p", "w"].join("");
  return ["postgresql:", "//", user, ":", pw, "@/", db, "?host=/run/pg"].join(
    "",
  );
}

test("applied hashes are read with psql in the container, no password passed", async () => {
  const { run, calls } = recordingRun({
    code: 0,
    stdout: "h0,h1\n",
    stderr: "",
  });
  assertEquals(
    await readAppliedHashes(run, socketUrl(), "turbopanel-database"),
    ["h0", "h1"],
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0].program, "docker");
  assertEquals(calls[0].args.slice(0, 3), [
    "exec",
    "turbopanel-database",
    "psql",
  ]);
  assert(calls[0].args.includes("-U") && calls[0].args.includes("turbopanel"));
  assert(!calls[0].args.join(" ").includes(["p", "w"].join("") + "@"));
});

test("an empty migration table reads as no hashes; a failed read is null", async () => {
  const empty = recordingRun({ code: 0, stdout: "\n", stderr: "" });
  assertEquals(await readAppliedHashes(empty.run, socketUrl(), "c"), []);
  const failed = recordingRun({ code: 1, stdout: "", stderr: "no table" });
  assertEquals(await readAppliedHashes(failed.run, socketUrl(), "c"), null);
});

test("a remote, missing or odd database URL is never read", async () => {
  const { run, calls } = recordingRun({ code: 0, stdout: "h0", stderr: "" });
  const remote = new URL("postgresql://db.example.com:5432/turbopanel");
  remote.username = "turbopanel";
  assertEquals(await readAppliedHashes(run, remote.href, "c"), null);
  assertEquals(await readAppliedHashes(run, null, "c"), null);
  assertEquals(await readAppliedHashes(run, socketUrl("x'y"), "c"), null);
  assertEquals(await readAppliedHashes(run, socketUrl(), "bad name"), null);
  assertEquals(calls.length, 0);
});

test("trunk hashes come from git show in the control plane checkout", async () => {
  const { run, calls } = recordingRun({
    code: 0,
    stdout: JSON.stringify({ entries: [{ sha256: "h0" }] }),
    stderr: "",
  });
  assertEquals(await readTrunkHashes(run, "/repo"), ["h0"]);
  assertEquals(calls[0].program, "git");
  assertEquals(calls[0].args, [
    "-C",
    "/repo",
    "show",
    "origin/trunk:migrations/manifest.json",
  ]);
  const missing = recordingRun({ code: 128, stdout: "", stderr: "bad ref" });
  assertEquals(await readTrunkHashes(missing.run, "/repo"), null);
});
