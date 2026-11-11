import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../../paths/layout.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import { RESERVED_HOST_PORT_RANGES } from "../compose-final-policy.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  installReachPorts,
  REACH_LIST_MAX_LINES,
  REACH_PORT_MAX,
  REACH_PORT_MIN,
  reachListPath,
  reachStageDir,
  removeReachPorts,
  renderReachList,
} from "./reach-ports.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ENV = "env-0123";

async function withLayout(
  fn: (layout: ReturnType<typeof resolveLayout>) => Promise<void>,
): Promise<void> {
  const fixture = await createTempLayout();
  try {
    await fn(resolveLayout(fixture.env, { forceMode: "production" }));
  } finally {
    await fixture.cleanup();
  }
}

const ok = { success: true, stdout: "", stderr: "" };

test("the list is sorted, a repeated pair is kept once, and it ends in a newline", () => {
  assertEquals(
    renderReachList([
      { username: "bob", port: 18200 },
      { username: "alice", port: 18100 },
      { username: "alice", port: 18100 },
    ]),
    "alice 18100\nbob 18200\n",
  );
});

test("a port outside the listen band, a bad user name or too many lines is refused here", () => {
  for (const port of [0, 80, 18079, 19000, 65536, 18100.5, Number.NaN]) {
    assertThrows(
      () => renderReachList([{ username: "alice", port }]),
      Error,
      "outside",
    );
  }
  for (const username of ["", "a b", "a/b", "-x".repeat(20), "al\nice"]) {
    assertThrows(
      () => renderReachList([{ username, port: 18100 }]),
      Error,
      "user name",
    );
  }
  const many = Array.from(
    { length: REACH_LIST_MAX_LINES + 1 },
    (_, i) => ({ username: `u${i}`, port: 18100 }),
  );
  assertThrows(() => renderReachList(many), Error, "more than");
});

test("the band is the reserved listen range of the compose policy", () => {
  assert(
    RESERVED_HOST_PORT_RANGES.some(([lo, hi]) =>
      lo === REACH_PORT_MIN && hi === REACH_PORT_MAX
    ),
  );
});

test("install stages a 0600 list in a 0700 folder, asks tp-host to copy it, deletes it, then syncs the walls", async () => {
  await withLayout(async (layout) => {
    const seen: Array<{ args: string[]; text?: string; mode?: number }> = [];
    const staged = join(reachStageDir(layout), `${ENV}.list`);
    const run: RunFn = async (_command, args) => {
      const verb = args.find((a) => a.startsWith("reach-ports-"));
      if (verb) {
        seen.push({
          args: args.slice(args.indexOf(verb)),
          text: await Deno.readTextFile(staged),
          mode: ((await Deno.stat(staged)).mode ?? 0) & 0o777,
        });
      } else {
        seen.push({ args: args.slice(-1) });
      }
      return ok;
    };
    await installReachPorts(layout, run, ENV, [
      { username: "alice", port: 18100 },
    ]);
    assertEquals(seen, [
      {
        args: ["reach-ports-install", ENV],
        text: "alice 18100\n",
        mode: 0o600,
      },
      { args: ["php-loopback-sync"] },
    ]);
    assertEquals(
      ((await Deno.stat(reachStageDir(layout))).mode ?? 0) & 0o777,
      0o700,
    );
    const left = await Deno.lstat(staged).then(() => true, () => false);
    assertEquals(left, false);
  });
});

test("an empty list removes the environment's list instead, then syncs", async () => {
  await withLayout(async (layout) => {
    const verbs: string[] = [];
    const run: RunFn = (_command, args) => {
      verbs.push(args.filter((a) => a !== "-n").join(" "));
      return Promise.resolve(ok);
    };
    await installReachPorts(layout, run, ENV, []);
    assertEquals(verbs.length, 2);
    assert(verbs[0].endsWith(`reach-ports-remove ${ENV}`), verbs[0]);
    assert(verbs[1].endsWith("php-loopback-sync"), verbs[1]);
  });
});

test("a refused install fails, leaves no staged file and does not sync", async () => {
  await withLayout(async (layout) => {
    let calls = 0;
    const run: RunFn = () => {
      calls++;
      return Promise.resolve({ success: false, stdout: "", stderr: "no" });
    };
    await assertRejects(
      () =>
        installReachPorts(layout, run, ENV, [
          { username: "alice", port: 18100 },
        ]),
      Error,
      "installing the list failed: no",
    );
    assertEquals(calls, 1);
    const left = await Deno.lstat(join(reachStageDir(layout), `${ENV}.list`))
      .then(() => true, () => false);
    assertEquals(left, false);
  });
});

test("a failed sync is an error, never a warning: the port must not stay unguarded", async () => {
  await withLayout(async (layout) => {
    const run: RunFn = (_command, args) =>
      Promise.resolve(
        args.includes("php-loopback-sync")
          ? { success: false, stdout: "", stderr: "nft refused" }
          : ok,
      );
    await assertRejects(
      () =>
        installReachPorts(layout, run, ENV, [
          { username: "alice", port: 18100 },
        ]),
      Error,
      "not reloaded: nft refused",
    );
    await assertRejects(
      () => removeReachPorts(run, ENV),
      Error,
      "not reloaded: nft refused",
    );
  });
});

test("an environment id outside the daemon's alphabet is refused before anything runs", async () => {
  await withLayout(async (layout) => {
    const run: RunFn = () => {
      throw new Error("must not run");
    };
    for (const id of ["", "../x", "a b", "a.b", "x".repeat(129)]) {
      await assertRejects(
        () =>
          installReachPorts(layout, run, id, [
            { username: "alice", port: 18100 },
          ]),
        Error,
        "environment id",
      );
      await assertRejects(() => removeReachPorts(run, id), Error);
    }
  });
});

test("the copy lives in the config root's reach-ports folder", async () => {
  await withLayout((layout) => {
    assertEquals(
      reachListPath(layout, ENV),
      join(layout.configDir, "reach-ports", `${ENV}.list`),
    );
    return Promise.resolve();
  });
});
