import {
  collectHostSummary,
  createHostSummaryCollector,
  parseDfOutput,
} from "./host-summary.ts";
import type { MonitorInstanceSummary } from "./protocol.ts";
import { assert, assertEquals, assertExists } from "@std/assert";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("collectHostSummary returns contract-shaped sections", async () => {
  const summary = await collectHostSummary();

  assert(
    typeof summary === "object" && summary !== null && !Array.isArray(summary),
    "summary must be a plain record",
  );

  assertSectionShape(summary);

  let hasProcStat = true;
  try {
    await Deno.stat("/proc/stat");
  } catch {
    // Non-Linux hosts rely on the generic shape checks above.
    hasProcStat = false;
  }
  if (!hasProcStat) return;

  assertExists(summary.cpu);
  assert(typeof summary.cpu.cores === "number");
  assertExists(summary.memory);
  assert(typeof summary.memory.totalBytes === "number");
  assertExists(summary.load);
  assert(typeof summary.load.one === "number");
  assert(typeof summary.load.five === "number");
  assert(typeof summary.load.fifteen === "number");
});

test("createHostSummaryCollector can compute cpu usage across samples", async () => {
  let hasProcStat = true;
  try {
    await Deno.stat("/proc/stat");
  } catch {
    hasProcStat = false;
  }
  if (!hasProcStat) return;

  const collector = createHostSummaryCollector();
  const first = await collector.collect();
  assertExists(first.cpu);
  const second = await collector.collect();
  assertExists(second.cpu);
  if (second.cpu.usagePercent != null) {
    assert(typeof second.cpu.usagePercent === "number");
  }
});

test("injected proc/df sources cover parse edge cases host-free", async () => {
  const files = new Map<string, string>([
    [
      "/proc/stat",
      "cpu  10 0 5 85 0 0 0 0\ncpu0 5 0 2 40 0 0 0 0\ncpu1 5 0 3 45 0 0 0 0\n",
    ],
    [
      "/proc/meminfo",
      "MemTotal:       2000 kB\nMemAvailable:   500 kB\n",
    ],
    ["/proc/loadavg", "0.10 0.20 0.30 1/100 1\n"],
    ["/proc/uptime", "12.34 56.78\n"],
    ["/proc/sys/kernel/random/boot_id", " boot-id-1 \n"],
  ]);

  const collector = createHostSummaryCollector({
    readProcFile: (path) => files.get(path),
    readDfOutput: () =>
      Promise.resolve(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
          "/dev/root 1000 250 750 25% /\n",
      ),
  });

  const first = await collector.collect();
  assertEquals(first.cpu?.cores, 2);
  assertEquals(first.memory?.totalBytes, 2000 * 1024);
  assertEquals(first.memory?.usedBytes, 1500 * 1024);
  assertEquals(first.load, { one: 0.1, five: 0.2, fifteen: 0.3 });
  assertEquals(first.uptimeSeconds, 12);
  assertEquals(first.bootId, "boot-id-1");
  assertEquals(first.disk?.totalBytes, 1000 * 1024);
  assertEquals(first.disk?.usedBytes, 250 * 1024);

  files.set(
    "/proc/stat",
    "cpu  20 0 10 170 0 0 0 0\ncpu0 10 0 5 80 0 0 0 0\ncpu1 10 0 5 90 0 0 0 0\n",
  );
  const second = await collector.collect();
  assertExists(second.cpu?.usagePercent);

  const empty = await createHostSummaryCollector({
    readProcFile: (path) => {
      if (path === "/proc/stat") return "not-cpu 1 2 3\n";
      if (path === "/proc/meminfo") return "Buffers: 1 kB\n";
      if (path === "/proc/loadavg") return "only-two 1.0\n";
      if (path === "/proc/uptime") return "   \n";
      return undefined;
    },
    readDfOutput: () => Promise.resolve(undefined),
  }).collect();
  assertEquals(empty.cpu, undefined);
  assertEquals(empty.memory, undefined);
  assertEquals(empty.load, undefined);
  assertEquals(empty.uptimeSeconds, undefined);
  assertEquals(empty.disk, undefined);
});

test("parseDfOutput rejects short and non-numeric rows", () => {
  assertEquals(parseDfOutput("header only\n"), undefined);
  assertEquals(parseDfOutput("Filesystem\n/dev/root 1 2\n"), undefined);
  assertEquals(
    parseDfOutput("Filesystem\n/dev/root NaN NaN 0 0% /\n"),
    undefined,
  );
  assertEquals(
    parseDfOutput("Filesystem\n/dev/root 0 0 0 0% /\n"),
    { usedBytes: 0, totalBytes: 0, usagePercent: undefined },
  );
});

test("collectHostSummary uses cat and df when direct proc reads fail", async () => {
  const procFiles = new Map<string, string>([
    [
      "/proc/stat",
      "cpu  10 0 5 85 0 0 0 0\ncpu0 5 0 2 40 0 0 0 0\n",
    ],
    [
      "/proc/meminfo",
      "MemTotal:       2000 kB\nMemAvailable:   500 kB\n",
    ],
    ["/proc/loadavg", "0.10 0.20 0.30 1/100 1\n"],
    ["/proc/uptime", "12.34 56.78\n"],
    ["/proc/sys/kernel/random/boot_id", " boot-id-cat \n"],
  ]);

  const originalRead = Deno.readTextFileSync.bind(Deno);
  Deno.readTextFileSync = () => {
    throw new Error("direct proc read blocked");
  };

  const originalCommand = Deno.Command;
  Deno.Command = class {
    #cmd: string;
    #args: string[];
    constructor(cmd: string, opts: Deno.CommandOptions) {
      this.#cmd = cmd;
      this.#args = (opts.args ?? []) as string[];
    }
    outputSync() {
      if (this.#cmd === "cat") {
        const path = this.#args[0];
        const text = procFiles.get(path);
        if (!text) return { code: 1, stdout: new Uint8Array() };
        return { code: 0, stdout: new TextEncoder().encode(text) };
      }
      return new originalCommand(this.#cmd, { args: this.#args }).outputSync();
    }
    output() {
      if (this.#cmd === "df") {
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: new TextEncoder().encode(
            "Filesystem 1024-blocks Used Available Capacity Mounted on\n" +
              "/dev/root 1000 250 750 25% /\n",
          ),
          stderr: new Uint8Array(),
        });
      }
      return new originalCommand(this.#cmd, { args: this.#args }).output();
    }
  } as unknown as typeof Deno.Command;

  try {
    const summary = await collectHostSummary();
    assertEquals(summary.cpu?.cores, 1);
    assertEquals(summary.memory?.totalBytes, 2000 * 1024);
    assertEquals(summary.bootId, "boot-id-cat");
    assertEquals(summary.disk?.totalBytes, 1000 * 1024);
  } finally {
    Deno.readTextFileSync = originalRead;
    Deno.Command = originalCommand;
  }
});

test("injected sources skip blank stat first lines and zero total mem", async () => {
  const collector = createHostSummaryCollector({
    readProcFile: (path) => {
      if (path === "/proc/stat") return "\ncpu  10 0 5 85 0 0 0 0\n";
      if (path === "/proc/meminfo") {
        return "MemTotal:       0 kB\nMemAvailable:   0 kB\n";
      }
      return undefined;
    },
    readDfOutput: () => Promise.resolve(undefined),
  });
  const summary = await collector.collect();
  assertEquals(summary.cpu, undefined);
  assertEquals(summary.memory?.totalBytes, 0);
  assertEquals(summary.memory?.usedBytes, 0);
});

test("injected sources skip NaN cpu lines and zero-delta samples", async () => {
  const collector = createHostSummaryCollector({
    readProcFile: (path) => {
      if (path === "/proc/stat") return "cpu  a b c d e\n";
      return undefined;
    },
    readDfOutput: () => Promise.resolve("Filesystem\n"),
  });
  const summary = await collector.collect();
  assertEquals(summary.cpu, undefined);

  const stable = createHostSummaryCollector({
    readProcFile: (path) => {
      if (path === "/proc/stat") {
        return "cpu  10 0 5 85 0 0 0 0\n";
      }
      return undefined;
    },
    readDfOutput: () => Promise.reject(new Error("df unavailable")),
  });
  await stable.collect();
  const again = await stable.collect();
  assertEquals(again.cpu?.cores, 0);
  assertEquals(again.cpu?.usagePercent, undefined);
  assertEquals(again.disk, undefined);
});

function assertSectionShape(summary: MonitorInstanceSummary): void {
  if (summary.cpu) {
    assert(typeof summary.cpu === "object" && !Array.isArray(summary.cpu));
    if (summary.cpu.cores != null) {
      assert(typeof summary.cpu.cores === "number");
    }
    if (summary.cpu.usagePercent != null) {
      assert(typeof summary.cpu.usagePercent === "number");
    }
  }

  if (summary.memory) {
    assert(
      typeof summary.memory === "object" && !Array.isArray(summary.memory),
    );
    for (const field of ["usedBytes", "totalBytes", "usagePercent"] as const) {
      const value = summary.memory[field];
      if (value != null) assert(typeof value === "number");
    }
  }

  if (summary.load) {
    assert(typeof summary.load === "object" && !Array.isArray(summary.load));
    assert(typeof summary.load.one === "number");
    assert(typeof summary.load.five === "number");
    assert(typeof summary.load.fifteen === "number");
  }

  if (summary.disk) {
    assert(typeof summary.disk === "object" && !Array.isArray(summary.disk));
  }

  if (summary.uptimeSeconds != null) {
    assert(typeof summary.uptimeSeconds === "number");
  }

  if (summary.bootId != null) {
    assert(typeof summary.bootId === "string");
  }
}
