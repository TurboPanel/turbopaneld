import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import {
  cidrContains,
  foldManagedPublicChain,
  isManagedListenerCovered,
  legacyListeners,
  parseRuleLine,
  uncoveredReasons,
} from "./fold.ts";
import type { FirewallRunFn } from "./run.ts";

/** Sonar typescript:S2187 only recognizes `test()`; see confirm.test.ts. */
const test = Deno.test.bind(Deno);

const DEST = "10.0.0.5/32";
const CHILD = "TP-MGD-abc123";

const LEGACY_PARENT = `-N TP-MANAGED-PUB\n-A TP-MANAGED-PUB -j ${CHILD}\n`;
const LEGACY_CHILD = [
  `-N ${CHILD}`,
  `-A ${CHILD} -s 10.0.0.7/32 -p tcp -m conntrack --ctorigdst ${DEST} --ctorigdstport 3306 -j ACCEPT`,
  `-A ${CHILD} -s 10.0.0.8/32 -p tcp -m conntrack --ctorigdst ${DEST} --ctorigdstport 3306 -j ACCEPT`,
  `-A ${CHILD} -p tcp -m conntrack --ctorigdst ${DEST} --ctorigdstport 3306 -j DROP`,
  "",
].join("\n");

const NEW_FORWARD = [
  "-N TP-FWD",
  '-A TP-FWD -s 10.0.0.0/24 -p tcp -m conntrack --ctorigdstport 3306 --ctorigdst 10.0.0.5/32 -m comment --comment "d:managed" -j RETURN',
  '-A TP-FWD -p tcp -m conntrack --ctorigdstport 3306 --ctorigdst 10.0.0.5/32 -m comment --comment "d:managed" -j DROP',
  "",
].join("\n");

type World = {
  legacy: boolean;
  forward: string | null;
  jump: boolean;
  /** Fail every `-X`, to exercise a partial removal. */
  failDelete?: boolean;
};

/** An in-memory iptables: answers `-S` / `-C` and records every call. */
function fakeIptables(world: World): { run: FirewallRunFn; calls: string[] } {
  const calls: string[] = [];
  const ok = (stdout = "") => ({ success: true, code: 0, stdout, stderr: "" });
  const no = (stderr: string) => ({
    success: false,
    code: 1,
    stdout: "",
    stderr,
  });
  const run: FirewallRunFn = (_cmd, args) => {
    const line = args.join(" ");
    calls.push(line);
    if (line === "-S TP-MANAGED-PUB") {
      return Promise.resolve(
        world.legacy ? ok(LEGACY_PARENT) : no("No chain/target/match"),
      );
    }
    if (line === `-S ${CHILD}`) return Promise.resolve(ok(LEGACY_CHILD));
    if (line === "-S TP-FWD") {
      return Promise.resolve(
        world.forward === null
          ? no("No chain/target/match")
          : ok(world.forward),
      );
    }
    if (line === "-C DOCKER-USER -j TP-FWD") {
      return Promise.resolve(world.jump ? ok() : no("Bad rule"));
    }
    if (line === "-D DOCKER-USER -j TP-MANAGED-PUB") {
      const had = world.legacy;
      world.legacy = false;
      return Promise.resolve(
        had ? ok() : no("Bad rule (does a matching rule exist"),
      );
    }
    if (world.failDelete && args[0] === "-X") {
      return Promise.resolve(no("busy"));
    }
    return Promise.resolve(ok());
  };
  return { run, calls };
}

async function withLayout<T>(
  fn: (layout: ReturnType<typeof resolveLayout>) => Promise<T>,
  pending = false,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-fold-" });
  try {
    const layout = resolveLayout({
      TURBOPANEL_CONFIG_DIR: join(root, "etc"),
      TURBOPANEL_STATE_DIR: join(root, "state"),
      TURBOPANEL_DAEMON_STATE_DIR: join(root, "state"),
      TURBOPANEL_RUN_DIR: join(root, "run"),
    });
    await Deno.mkdir(layout.runDir, { recursive: true });
    if (pending) {
      await Deno.writeTextFile(
        join(layout.runDir, "firewall-pending.json"),
        JSON.stringify({
          version: 1,
          digest: "a".repeat(64),
          generation: 1,
          armedAt: "2099-01-01T00:00:00.000Z",
          windowSeconds: 120,
          deadlineAt: "2099-01-01T00:00:00.000Z",
          v6: "keep",
        }),
      );
    }
    return await fn(layout);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const mutating = (calls: string[]) =>
  calls.filter((c) => /^-(D|F|X|A|I|N) /.test(c));

test("parseRuleLine reads source, original destination, port and target", () => {
  const rule = parseRuleLine(
    `-A ${CHILD} -s 10.0.0.7/32 -p tcp -m conntrack --ctorigdst ${DEST} --ctorigdstport 3306 -j ACCEPT`,
  );
  assertEquals(rule?.source, "10.0.0.7/32");
  assertEquals(rule?.dest, DEST);
  assertEquals(rule?.port, "3306");
  assertEquals(rule?.target, "ACCEPT");
  assertEquals(parseRuleLine("-N TP-FWD"), null);
});

test("cidrContains handles bare addresses, CIDRs and rejects a wider inner", () => {
  assert(cidrContains("10.0.0.0/24", "10.0.0.7/32"));
  assert(cidrContains("10.0.0.7", "10.0.0.7/32"));
  assert(!cidrContains("10.0.0.7/32", "10.0.0.0/24"));
  assert(!cidrContains("10.0.1.0/24", "10.0.0.7"));
  assert(!cidrContains("junk", "10.0.0.7"));
});

test("legacy chain lines group into one listener with its sources and drop", () => {
  const rules = LEGACY_CHILD.split("\n").map(parseRuleLine).filter((r) =>
    r !== null
  );
  assertEquals(legacyListeners(rules), [{
    dest: DEST,
    port: "3306",
    hasDrop: true,
    sources: ["10.0.0.7/32", "10.0.0.8/32"],
  }]);
});

test("a listener without a DROP or with an unlisted source is uncovered", () => {
  const forward = NEW_FORWARD.split("\n").map(parseRuleLine).filter((r) =>
    r !== null
  );
  const base = {
    dest: DEST,
    port: "3306",
    hasDrop: true,
    sources: ["10.0.0.7/32"],
  };
  assertEquals(uncoveredReasons(base, forward), []);
  assertEquals(
    uncoveredReasons({ ...base, sources: ["192.0.2.9/32"] }, forward).length,
    1,
  );
  assertEquals(uncoveredReasons(base, forward.slice(0, 1)).length, 1);
  assertEquals(uncoveredReasons({ ...base, port: "3307" }, forward).length, 2);
});

test("fold removes the legacy chain only after verifying TP-FWD covers it, jump first", async () => {
  await withLayout(async (layout) => {
    const world: World = { legacy: true, forward: NEW_FORWARD, jump: true };
    const { run, calls } = fakeIptables(world);
    const outcome = await foldManagedPublicChain({ run, layout });
    assertEquals(outcome.state, "folded");
    assertEquals(outcome.listeners, 1);
    const verify = calls.indexOf("-S TP-FWD");
    const unhook = calls.indexOf("-D DOCKER-USER -j TP-MANAGED-PUB");
    assert(verify >= 0 && verify < unhook, "verified before removing");
    assertEquals(mutating(calls), [
      "-D DOCKER-USER -j TP-MANAGED-PUB",
      "-D DOCKER-USER -j TP-MANAGED-PUB",
      "-F TP-MANAGED-PUB",
      "-X TP-MANAGED-PUB",
      `-F ${CHILD}`,
      `-X ${CHILD}`,
    ]);
  });
});

test("fold is idempotent: a second run finds nothing", async () => {
  await withLayout(async (layout) => {
    const world: World = { legacy: true, forward: NEW_FORWARD, jump: true };
    const { run } = fakeIptables(world);
    await foldManagedPublicChain({ run, layout });
    const second = fakeIptables({ ...world, legacy: false });
    const outcome = await foldManagedPublicChain({ run: second.run, layout });
    assertEquals(outcome.state, "nothing_to_fold");
    assertEquals(mutating(second.calls), []);
  });
});

test("fold keeps the legacy chain when TP-FWD is missing, unhooked or narrower", async () => {
  const cases: World[] = [
    { legacy: true, forward: null, jump: true },
    { legacy: true, forward: NEW_FORWARD, jump: false },
    {
      legacy: true,
      forward: NEW_FORWARD.replace("10.0.0.0/24", "10.0.0.7/32"),
      jump: true,
    },
  ];
  for (const world of cases) {
    await withLayout(async (layout) => {
      const { run, calls } = fakeIptables(world);
      const outcome = await foldManagedPublicChain({ run, layout });
      assertEquals(outcome.state, "kept_legacy");
      assert(outcome.reasons.length > 0);
      assertEquals(mutating(calls), []);
    });
  }
});

test("fold defers while a ruleset is pending, touching nothing", async () => {
  await withLayout(async (layout) => {
    const { run, calls } = fakeIptables({
      legacy: true,
      forward: NEW_FORWARD,
      jump: true,
    });
    const outcome = await foldManagedPublicChain({ run, layout });
    assertEquals(outcome.state, "deferred");
    assertEquals(calls, []);
  }, true);
});

test("a failed delete reports partial instead of folded", async () => {
  await withLayout(async (layout) => {
    const { run } = fakeIptables({
      legacy: true,
      forward: NEW_FORWARD,
      jump: true,
      failDelete: true,
    });
    const outcome = await foldManagedPublicChain({ run, layout });
    assertEquals(outcome.state, "partial");
  });
});

test("isManagedListenerCovered gates the legacy installer and fails closed", async () => {
  const listener = {
    dest: "10.0.0.5",
    port: "3306",
    hasDrop: true,
    sources: ["10.0.0.7"],
  };
  await withLayout(async (layout) => {
    const covered = fakeIptables({
      legacy: false,
      forward: NEW_FORWARD,
      jump: true,
    });
    assert(
      await isManagedListenerCovered(listener, { run: covered.run, layout }),
    );
    const unhooked = fakeIptables({
      legacy: false,
      forward: NEW_FORWARD,
      jump: false,
    });
    assert(
      !await isManagedListenerCovered(listener, { run: unhooked.run, layout }),
    );
    const boom: FirewallRunFn = () => Promise.reject(new Error("boom"));
    assert(!await isManagedListenerCovered(listener, { run: boom, layout }));
  });
  await withLayout(async (layout) => {
    const { run } = fakeIptables({
      legacy: false,
      forward: NEW_FORWARD,
      jump: true,
    });
    assert(
      !await isManagedListenerCovered(listener, { run, layout }),
      "pending",
    );
  }, true);
});
