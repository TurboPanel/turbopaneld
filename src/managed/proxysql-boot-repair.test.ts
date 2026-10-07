import { assertEquals } from "@std/assert";
import {
  type ProxySqlBootRepairDeps,
  repairProxySqlFrontendAtBoot,
} from "./proxysql-boot-repair.ts";
import type { LayoutPaths } from "../paths/layout.ts";

const layout = { configDir: "/etc/tp" } as unknown as LayoutPaths;
const COMPOSE = `services:
  proxysql:
    ports:
      - "10.10.1.20:13306:13306"
      - "10.10.1.20:15432:15432"
`;

function harness(opts: {
  running?: boolean;
  compose?: string | null;
  addresses: () => string[];
  budgetMs?: number;
}) {
  const calls: string[][] = [];
  let clock = 0;
  const deps: ProxySqlBootRepairDeps = {
    runDocker: (args) => {
      calls.push(args);
      const out = args.includes("ps") && opts.running ? "abc\n" : "";
      return Promise.resolve(
        { success: true, stdout: out, stderr: "" } as never,
      );
    },
    readCompose: () =>
      Promise.resolve(opts.compose === undefined ? COMPOSE : opts.compose),
    localAddresses: opts.addresses,
    sleep: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    budgetMs: opts.budgetMs ?? 60_000,
  };
  return { calls, deps };
}

const ups = (calls: string[][]) => calls.filter((c) => c.includes("up")).length;

Deno.test("boot repair: no compose on disk is a no-op", async () => {
  const h = harness({ compose: null, addresses: () => [] });
  assertEquals(
    await repairProxySqlFrontendAtBoot(layout, h.deps),
    "no-compose",
  );
  assertEquals(h.calls.length, 0);
});

Deno.test("boot repair: running container is left alone", async () => {
  const h = harness({ running: true, addresses: () => [] });
  assertEquals(
    await repairProxySqlFrontendAtBoot(layout, h.deps),
    "already-running",
  );
  assertEquals(ups(h.calls), 0);
});

Deno.test("boot repair: waits for the address, then brings it up", async () => {
  let polls = 0;
  const h = harness({
    addresses:
      () => (++polls < 3 ? ["127.0.0.1"] : ["127.0.0.1", "10.10.1.20"]),
  });
  assertEquals(await repairProxySqlFrontendAtBoot(layout, h.deps), "started");
  assertEquals(ups(h.calls), 1);
  assertEquals(polls, 3);
});

Deno.test("boot repair: gives up when the address never appears", async () => {
  const h = harness({ addresses: () => ["127.0.0.1"], budgetMs: 30_000 });
  assertEquals(await repairProxySqlFrontendAtBoot(layout, h.deps), "gave-up");
  assertEquals(ups(h.calls), 0);
});
