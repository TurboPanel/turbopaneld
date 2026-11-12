import { assert, assertEquals } from "@std/assert";
import type {
  DevHostJob,
  DevHostPart,
  DevHostStatus,
} from "../contracts/cell-messages.ts";
import type { CommandResult, RunCommand } from "./commands.ts";
import {
  aheadOfTrunk,
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

function status(
  parts: DevHostPart[] = [],
  job: DevHostJob | null = null,
): DevHostStatus {
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
    job,
  };
}

function job(id: string, state: DevHostJob["state"]): DevHostJob {
  return {
    id,
    action: "update",
    state,
    step: "migrate",
    steps: [],
    startedAt: new Date(NOW).toISOString(),
    endedAt: state === "running" ? null : new Date(NOW + 1000).toISOString(),
    logTail: [],
  };
}

function controlPlaneReason(s: DevHostStatus): string | undefined {
  return s.parts.find((p) => p.name === "control-plane")?.blockedReason;
}

type State = {
  key: string;
  trunk: string[];
  applied: string[];
  ahead: string[];
  started: boolean;
  saved: string | null;
};

type Harness = {
  auto: AutoMigrate;
  starts: () => number;
  reads: () => number;
  state: State;
  advance: (ms: number) => void;
};

function harness(
  overrides: Partial<AutoMigrateDeps> = {},
  initial: Partial<State> = {},
): Harness {
  const state: State = {
    key: "t1..h1",
    trunk: ["h0", "h1", "h2"],
    applied: ["h0"],
    ahead: [],
    started: true,
    saved: null,
    ...initial,
  };
  let now = NOW;
  let starts = 0;
  let reads = 0;
  const auto = new AutoMigrate({
    refsKey: () => Promise.resolve(state.key),
    trunkHashes: () => {
      reads++;
      return Promise.resolve(state.trunk);
    },
    appliedHashes: () => Promise.resolve(state.applied),
    partsAheadOfTrunk: () => Promise.resolve(state.ahead),
    startUpdate: () => {
      if (state.started) starts++;
      return Promise.resolve(state.started);
    },
    loadTried: () => Promise.resolve(state.saved),
    saveTried: (key) => {
      state.saved = key;
      return Promise.resolve();
    },
    nowMs: () => now,
    ...overrides,
  });
  return {
    auto,
    starts: () => starts,
    reads: () => reads,
    state,
    advance: (ms) => {
      now += ms;
    },
  };
}

test("the gap follows the control plane's rule: applied must be trunk's start", () => {
  assertEquals(migrationGap(["a", "b"], ["a", "b"]), { kind: "none" });
  assertEquals(migrationGap(["a", "b", "c"], ["a"]), {
    kind: "pending",
    count: 2,
  });
  assertEquals(migrationGap(["a", "b"], []), { kind: "pending", count: 2 });
  assertEquals(migrationGap(["a"], ["a", "x"]), { kind: "foreign" });
  // A gap or a different order is what pnpm migrate calls diverged.
  assertEquals(migrationGap(["a", "b", "c"], ["a", "c"]), { kind: "foreign" });
  assertEquals(migrationGap(["a", "b"], ["b"]), { kind: "foreign" });
});

test("any part off trunk, dirty or blocked holds the job", () => {
  assertEquals(holdReason(status()), null);
  assertEquals(
    holdReason(status([part("website", { onTrunk: false, branch: "x" })])),
    { part: "website", reason: "is not on trunk" },
  );
  assertEquals(
    holdReason(
      status([
        part("web-interface", {
          dirty: { files: 1, blocking: true, kinds: [] },
        }),
      ]),
    ),
    { part: "web-interface", reason: "has local changes" },
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
    { part: "control-plane", reason: "detached HEAD, not trunk; not pulled" },
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

test("pending trunk migrations with clean checkouts start Update and Restart once per trunk list", async () => {
  const h = harness();
  const out = await h.auto.review(status());
  assertEquals(h.starts(), 1);
  assertEquals(controlPlaneReason(out), undefined);
  assertEquals(h.state.saved, "h0,h1,h2");
  // The job pulled (refs moved) but failed before migrating: not again.
  h.state.key = "t1..t1";
  const again = await h.auto.review(status([], job("j1", "failed")));
  assertEquals(h.starts(), 1);
  assertEquals(
    controlPlaneReason(again),
    "trunk has 2 new migrations; the automatic update did not apply them (see the last job, or run Update and Restart)",
  );
  // Trunk ships another migration: tried again.
  h.state.key = "t2..t1";
  h.state.trunk = ["h0", "h1", "h2", "h3"];
  await h.auto.review(status([], job("j1", "failed")));
  assertEquals(h.starts(), 2);
});

test("the tried list survives a daemon restart", async () => {
  const h = harness({}, { saved: "h0,h1,h2" });
  const out = await h.auto.review(status());
  assertEquals(h.starts(), 0);
  assert(controlPlaneReason(out)?.includes("did not apply them"));
});

test("a job that ends is followed by a fresh comparison (no stale failure note)", async () => {
  const h = harness();
  await h.auto.review(status());
  assertEquals(h.starts(), 1);
  // The job migrated without moving any ref (checkouts were already current).
  h.state.applied = ["h0", "h1", "h2"];
  const out = await h.auto.review(status([], job("j1", "done")));
  assertEquals(h.reads(), 2);
  assertEquals(controlPlaneReason(out), undefined);
});

test("a start refused because a job is running is not counted as tried", async () => {
  const h = harness({}, { started: false });
  await h.auto.review(status());
  assertEquals(h.state.saved, null);
  h.state.started = true;
  await h.auto.review(status());
  assertEquals(h.starts(), 1);
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

test("a detached control plane keeps its own reason and adds the hold once", async () => {
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
    "detached HEAD, not trunk; not pulled; trunk has 2 new migrations, not applied automatically until this is fixed",
  );
});

test("a checkout with commits not on origin/trunk holds the job", async () => {
  const h = harness({}, { ahead: ["control-plane"] });
  const out = await h.auto.review(status());
  assertEquals(h.starts(), 0);
  assertEquals(
    controlPlaneReason(out),
    "trunk has 2 new migrations, not applied automatically: control-plane has commits not on origin/trunk",
  );
});

test("nothing pending, a running job or unreadable state starts nothing", async () => {
  const current = harness({}, { applied: ["h0", "h1", "h2"] });
  assertEquals(
    controlPlaneReason(await current.auto.review(status())),
    undefined,
  );
  assertEquals(current.starts(), 0);

  const running = harness();
  await running.auto.review(status([], job("j", "running")));
  assertEquals(running.starts(), 0);
  assertEquals(running.reads(), 0, "no git or database read while a job runs");

  const unreadable = harness({ appliedHashes: () => Promise.resolve(null) });
  assertEquals(
    controlPlaneReason(await unreadable.auto.review(status())),
    undefined,
  );
  assertEquals(unreadable.starts(), 0);
});

test("a database whose migrations are not trunk's start is never migrated automatically", async () => {
  const h = harness({}, { applied: ["h0", "branch-only"] });
  const out = await h.auto.review(status());
  assertEquals(h.starts(), 0);
  assertEquals(
    controlPlaneReason(out),
    "the database's migrations are not the start of trunk's; not migrating automatically",
  );
});

test("the comparison repeats only when refs move, a job ends, or after ten minutes", async () => {
  const h = harness({}, { applied: ["h0", "h1", "h2"] });
  await h.auto.review(status());
  await h.auto.review(status());
  assertEquals(h.reads(), 1);
  h.advance(AUTO_MIGRATE_CHECK_MS);
  await h.auto.review(status());
  assertEquals(h.reads(), 2);
  h.state.key = "t2..h1";
  await h.auto.review(status());
  assertEquals(h.reads(), 3);
  await h.auto.review(status([], job("j9", "done")));
  assertEquals(h.reads(), 4);
  await h.auto.review(status([], job("j9", "done")));
  assertEquals(h.reads(), 4);
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

test("a HEAD that is not an ancestor of origin/trunk counts as ahead", async () => {
  const onTrunk = recordingRun({ code: 0, stdout: "", stderr: "" });
  assertEquals(await aheadOfTrunk(onTrunk.run, "/repo"), false);
  assertEquals(onTrunk.calls[0].args, [
    "-C",
    "/repo",
    "merge-base",
    "--is-ancestor",
    "HEAD",
    "refs/remotes/origin/trunk",
  ]);
  const ahead = recordingRun({ code: 1, stdout: "", stderr: "" });
  assertEquals(await aheadOfTrunk(ahead.run, "/repo"), true);
});
