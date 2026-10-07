import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  type ProxySqlBootRepairDeps,
  repairProxySqlFrontendAtBoot,
} from "./proxysql-boot-repair.ts";
import {
  markProxySqlReconciled,
  resetProxySqlLockForTests,
  withProxySqlLock,
} from "./proxysql-lock.ts";
import type { LayoutPaths } from "../paths/layout.ts";

const layout = { configDir: "/etc/tp" } as unknown as LayoutPaths;
const compose = (ip: string) =>
  `services:
  proxysql:
    ports:
      - "${ip}:13306:13306"
      - "${ip}:15432:15432"
`;
const COMPOSE = compose("10.10.1.20");

type Step = { success: boolean; stdout?: string; stderr?: string };

function harness(opts: {
  /** Compose text per read; the last entry repeats. */
  composes?: Array<string | null>;
  psSteps?: Step[];
  upSteps?: Step[];
  addresses?: () => string[];
  budgetMs?: number;
  onSleep?: (n: number) => void;
}) {
  const calls: string[][] = [];
  const warns: string[] = [];
  const infos: string[] = [];
  let clock = 0;
  let reads = 0;
  let sleeps = 0;
  const psSteps = [...(opts.psSteps ?? [{ success: true, stdout: "" }])];
  const upSteps = [...(opts.upSteps ?? [{ success: true }])];
  const next = (steps: Step[]) => steps.length > 1 ? steps.shift()! : steps[0]!;
  const composes = opts.composes ?? [COMPOSE];
  const deps: ProxySqlBootRepairDeps = {
    runDocker: (args) => {
      calls.push(args);
      const step = next(args.includes("ps") ? psSteps : upSteps);
      return Promise.resolve(
        { stdout: "", stderr: "", ...step } as never,
      );
    },
    readCompose: () =>
      Promise.resolve(composes[Math.min(reads++, composes.length - 1)] ?? null),
    localAddresses: opts.addresses ?? (() => ["10.10.1.20"]),
    sleep: (ms) => {
      clock += ms;
      opts.onSleep?.(++sleeps);
      return Promise.resolve();
    },
    now: () => clock,
    budgetMs: opts.budgetMs ?? 60_000,
    info: (m) => infos.push(m),
    warn: (m) => warns.push(m),
  };
  return { calls, deps, warns, infos };
}

const ups = (calls: string[][]) => calls.filter((c) => c.includes("up")).length;
const run = (h: ReturnType<typeof harness>) => {
  resetProxySqlLockForTests();
  return repairProxySqlFrontendAtBoot(layout, h.deps);
};

Deno.test("boot repair: no compose on disk is a no-op", async () => {
  const h = harness({ composes: [null] });
  assertEquals(await run(h), "no-compose");
  assertEquals(h.calls.length, 0);
});

Deno.test("boot repair: running container is left alone", async () => {
  const h = harness({ psSteps: [{ success: true, stdout: "abc\n" }] });
  assertEquals(await run(h), "already-running");
  assertEquals(ups(h.calls), 0);
});

Deno.test("boot repair: waits for the address, then brings it up", async () => {
  let polls = 0;
  const h = harness({
    addresses:
      () => (++polls < 3 ? ["127.0.0.1"] : ["127.0.0.1", "10.10.1.20"]),
  });
  assertEquals(await run(h), "started");
  assertEquals(ups(h.calls), 1);
  assertEquals(polls, 3);
});

Deno.test("boot repair: gives up and logs when the address never appears", async () => {
  const h = harness({ addresses: () => ["127.0.0.1"], budgetMs: 30_000 });
  assertEquals(await run(h), "gave-up");
  assertEquals(ups(h.calls), 0);
  assertEquals(h.warns.length, 1);
  assertStringIncludes(h.warns[0]!, "gave up after 30s");
  assertStringIncludes(h.warns[0]!, "10.10.1.20");
});

Deno.test("boot repair: compose file changing mid-wait aborts", async () => {
  const h = harness({ composes: [COMPOSE, compose("10.10.1.21")] });
  assertEquals(await run(h), "aborted");
  assertEquals(ups(h.calls), 0);
  assertStringIncludes(h.warns[0]!, "addresses changed");
});

Deno.test("boot repair: compose file vanishing mid-wait aborts", async () => {
  const h = harness({ composes: [COMPOSE, null] });
  assertEquals(await run(h), "aborted");
  assertEquals(ups(h.calls), 0);
  assertStringIncludes(h.warns[0]!, "removed");
});

Deno.test("boot repair: docker ps failing then recovering still starts", async () => {
  const h = harness({
    psSteps: [{ success: false, stderr: "cannot connect" }, {
      success: true,
      stdout: "",
    }],
  });
  assertEquals(await run(h), "started");
  assertEquals(ups(h.calls), 1);
});

Deno.test("boot repair: a failed up is retried", async () => {
  const h = harness({
    upSteps: [{ success: false, stderr: "boom" }, { success: true }],
  });
  assertEquals(await run(h), "started");
  assertEquals(ups(h.calls), 2);
});

Deno.test("boot repair: stands down once a reconcile has run", async () => {
  const h = harness({
    addresses: () => [],
    onSleep: () => markProxySqlReconciled(),
  });
  assertEquals(await run(h), "superseded");
  assertEquals(ups(h.calls), 0);
});

Deno.test("boot repair: waits behind a running reconcile, then stands down", async () => {
  const h = harness({});
  resetProxySqlLockForTests();
  let release!: () => void;
  const held = withProxySqlLock(() =>
    new Promise<void>((resolve) => release = resolve)
  );
  const repair = repairProxySqlFrontendAtBoot(layout, h.deps);
  await new Promise((r) => setTimeout(r, 10));
  assertEquals(ups(h.calls), 0);
  markProxySqlReconciled();
  release();
  await held;
  assertEquals(await repair, "superseded");
  assertEquals(ups(h.calls), 0);
});

Deno.test("boot repair: IPv6 addresses match by normalised form", async () => {
  const h = harness({
    composes: [
      `    ports:\n      - "[FD00::1]:13306:13306"\n      - "[FD00::1]:15432:15432"\n`,
    ],
    addresses: () => ["fd00::1"],
  });
  assertEquals(await run(h), "started");
});
