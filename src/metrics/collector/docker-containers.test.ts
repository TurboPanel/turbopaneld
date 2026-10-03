import { assertEquals } from "@std/assert";

import type { ContainerSummary, DockerEvent } from "../../docker/client.ts";
import { CounterBaselineTracker } from "./baseline.ts";
import {
  ContainerHealthSampler,
  summarizeContainers,
  toContainerHealthSample,
  UnexpectedExitTracker,
} from "./docker-containers.ts";

const test = Deno.test.bind(Deno);

function c(
  name: string,
  state: string,
  status: string,
  labels: Record<string, string> = {},
): ContainerSummary {
  return {
    Id: `${name}-id`,
    Names: [`/${name}`],
    Image: "img:secret",
    State: state,
    Status: status,
    Labels: labels,
    Ports: [],
  };
}

test("counts running, unhealthy and restarting containers by short name", () => {
  const out = summarizeContainers([
    c("web", "running", "Up 2 hours (healthy)"),
    c("api", "running", "Up 1 hour (unhealthy)"),
    c("job", "restarting", "Restarting (1) 5 seconds ago"),
    c("old", "exited", "Exited (0) 2 days ago"),
  ]);
  assertEquals(out.running, 2);
  assertEquals(out.unhealthy, 1);
  assertEquals(out.restarting, 1);
  assertEquals(out.unhealthyNames, ["api"]);
});

test("Traefik backend health is derived from Docker state, not scraped", () => {
  const t = { "traefik.enable": "true" };
  const out = summarizeContainers([
    c("a", "running", "Up (healthy)", t),
    c("b", "running", "Up (unhealthy)", t),
    c("d", "exited", "Exited (1)", t),
    c("plain", "running", "Up"),
  ]);
  assertEquals(out.traefik, { total: 3, up: 1, unhealthyNames: ["b"] });
});

function ev(action: string, id: string, exitCode?: string): DockerEvent {
  return {
    Type: "container",
    Action: action,
    Actor: { ID: id, Attributes: exitCode ? { exitCode } : {} },
  };
}

test("only unexpected exits count: a stop/deploy kill-then-die does not", () => {
  const t = new UnexpectedExitTracker();
  t.observe(ev("kill", "x"), 0);
  t.observe(ev("die", "x", "137"), 100); // docker stop / deploy
  assertEquals(t.total(), 0);
  t.observe(ev("die", "y", "1"), 200); // crash
  assertEquals(t.total(), 1);
  t.observe(ev("die", "z", "137"), 300); // OOM: no kill event
  assertEquals(t.total(), 2);
  t.observe(ev("die", "w", "0"), 400); // clean one-shot exit
  assertEquals(t.total(), 2);
  // A stale kill (outside the window) does not excuse a later crash.
  t.observe(ev("kill", "v"), 0);
  t.observe(ev("die", "v", "1"), 10 * 60_000);
  assertEquals(t.total(), 3);
});

test("the sampler reads cgroup CPU, memory and OOM and divides by real elapsed time", async () => {
  let clock = 0;
  let usage = 0;
  const files = (): Record<string, string> => ({
    "cpu.stat": `usage_usec ${usage}\n`,
    "memory.events": "oom_kill 4\n",
    "memory.current": "1000\n",
    "memory.stat": "inactive_file 400\n",
  });
  const sampler = new ContainerHealthSampler({
    listContainers: () =>
      Promise.resolve([c("web", "running", "Up (healthy)")]),
    streamEvents: async function* () {},
    readCgroupFile: (n) => Promise.resolve(files()[n]),
    cpuCount: () => 2,
    now: () => clock,
  });
  await sampler.refresh();
  assertEquals(sampler.latest()?.cpuPercent, null);
  clock = 120_000; // a missed tick: 120 s elapsed
  usage = 120_000_000; // 120 s CPU on 2 CPUs
  await sampler.refresh();
  const r = sampler.latest()!;
  assertEquals(r.cpuPercent, 50);
  assertEquals(r.memoryBytes, 600);
  assertEquals(r.oomKillsTotal, 4);
});

test("without the cgroup slice CPU, memory and OOM are null, never zero", async () => {
  const sampler = new ContainerHealthSampler({
    listContainers: () => Promise.resolve([]),
    streamEvents: async function* () {},
    readCgroupFile: () => Promise.resolve(undefined),
    cpuCount: () => 2,
  });
  await sampler.refresh();
  const r = sampler.latest()!;
  assertEquals([r.cpuPercent, r.memoryBytes, r.oomKillsTotal], [
    null,
    null,
    null,
  ]);
});

test("OOM kills and exits become per-sample deltas", () => {
  const tracker = new CounterBaselineTracker();
  const base = {
    running: 0,
    unhealthy: 0,
    restarting: 0,
    unhealthyNames: [],
    traefik: { total: 0, up: 0, unhealthyNames: [] },
    cpuPercent: null,
    memoryBytes: null,
  };
  const first = toContainerHealthSample(
    { ...base, unexpectedExitsTotal: 1, oomKillsTotal: 5 },
    tracker,
    1,
  );
  assertEquals([first.oomKills, first.unexpectedExits], [null, null]);
  const second = toContainerHealthSample(
    { ...base, unexpectedExitsTotal: 3, oomKillsTotal: 6 },
    tracker,
    1,
  );
  assertEquals([second.oomKills, second.unexpectedExits], [1, 2]);
});
