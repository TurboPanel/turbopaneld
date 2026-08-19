import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  resetTunnelsRuntimeForTests,
  setTunnelsTestHooks,
  startTunnels,
  writeInstanceTunnelToken,
} from "./tunnels.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function withTempTunnelsDir<T>(
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "tunnels-test-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function cleanupHooks(): void {
  resetTunnelsRuntimeForTests();
  setTunnelsTestHooks(null);
}

test("startTunnels is a no-op while Cloudflare tunnels stay disabled", async () => {
  cleanupHooks();
  const controller = new AbortController();
  await startTunnels(controller.signal);
  controller.abort();
  assertEquals(controller.signal.aborted, true);
});

test("writeInstanceTunnelToken ignores tokens while tunnels stay disabled", async () => {
  cleanupHooks();
  await writeInstanceTunnelToken("example-token");
  await writeInstanceTunnelToken("");
  assertEquals(true, true);
});

test("startTunnels skips when the tunnels dir is missing", async () => {
  await withTempTunnelsDir(async (dir) => {
    const missing = join(dir, "missing-tunnels");
    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: missing,
      ensureCloudflared: () => {
        throw new TypeError("ensureCloudflared must not run with no tokens");
      },
    });
    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      controller.abort();
    } finally {
      cleanupHooks();
    }
  });
});

test("startTunnels skips empty token files and non-token entries", async () => {
  await withTempTunnelsDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "empty.token"), "  \n");
    await Deno.writeTextFile(join(dir, "notes.txt"), "not-a-token");
    await Deno.mkdir(join(dir, "subdir"));

    let ensureCalls = 0;
    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      ensureCloudflared: () => {
        ensureCalls += 1;
        return Promise.resolve("/fake/cloudflared");
      },
    });
    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      assertEquals(ensureCalls, 0);
      controller.abort();
    } finally {
      cleanupHooks();
    }
  });
});

test("startTunnels logs and returns when cloudflared install fails", async () => {
  await withTempTunnelsDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "edge.token"), "tok-edge\n");
    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      ensureCloudflared: () => Promise.reject(new Error("download failed")),
    });
    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      controller.abort();
    } finally {
      cleanupHooks();
    }
  });
});

test("startTunnels supervises configured tunnels until aborted", async () => {
  await withTempTunnelsDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "a.token"), "token-a\n");
    await Deno.writeTextFile(join(dir, "b.token"), "token-b\n");

    const runs: string[] = [];
    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      delay: () => Promise.resolve(),
      ensureCloudflared: () => Promise.resolve("/opt/fake/cloudflared"),
      runTunnel: (bin, args, signal) => {
        runs.push(`${bin} ${args.join(" ")}`);
        return new Promise((resolve) => {
          if (signal.aborted) {
            resolve({ code: 0 });
            return;
          }
          const onAbort = () => {
            signal.removeEventListener("abort", onAbort);
            resolve({ code: 0 });
          };
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    });

    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      assertEquals(runs.length, 2);
      assertEquals(
        runs.some((line) => line.includes("--token token-a")),
        true,
      );
      assertEquals(
        runs.some((line) => line.includes("--token token-b")),
        true,
      );
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      cleanupHooks();
    }
  });
});

test("startTunnels restarts after a tunnel exits while still enabled", async () => {
  await withTempTunnelsDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "loop.token"), "token-loop\n");

    let runCount = 0;
    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      delay: () => Promise.resolve(),
      ensureCloudflared: () => Promise.resolve("/fake/cloudflared"),
      runTunnel: (_bin, _args, signal) => {
        runCount += 1;
        if (runCount === 1) return Promise.resolve({ code: 1 });
        return new Promise((resolve) => {
          const onAbort = () => resolve({ code: 0 });
          if (signal.aborted) {
            resolve({ code: 0 });
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    });

    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      await waitFor(() => runCount >= 2);
      assertEquals(runCount >= 2, true);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      cleanupHooks();
    }
  });
});

test("writeInstanceTunnelToken writes, relaunches, then clears the token", async () => {
  await withTempTunnelsDir(async (dir) => {
    const tokenPath = join(dir, "instance.token");
    const launches: number[] = [];

    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      delay: () => Promise.resolve(),
      ensureCloudflared: () => Promise.resolve("/fake/cloudflared"),
      runTunnel: (_bin, _args, signal) => {
        launches.push(Date.now());
        return new Promise((resolve) => {
          const onAbort = () => resolve({ code: 0 });
          if (signal.aborted) {
            resolve({ code: 0 });
            return;
          }
          signal.addEventListener("abort", onAbort, { once: true });
        });
      },
    });

    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      assertEquals(launches.length, 0);

      await writeInstanceTunnelToken("  instance-tok  ");
      const written = await Deno.readTextFile(tokenPath);
      assertEquals(written, "instance-tok\n");
      await waitFor(() => launches.length >= 1);

      await writeInstanceTunnelToken("");
      await assertRejects(
        () => Deno.stat(tokenPath),
        Deno.errors.NotFound,
      );

      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      cleanupHooks();
    }
  });
});

test("launchTunnels is a no-op when parent signal is already aborted", async () => {
  await withTempTunnelsDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "a.token"), "tok\n");
    let ensureCalls = 0;
    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      ensureCloudflared: () => {
        ensureCalls += 1;
        return Promise.resolve("/fake/cloudflared");
      },
    });
    try {
      const controller = new AbortController();
      controller.abort();
      await startTunnels(controller.signal);
      assertEquals(ensureCalls, 0);
    } finally {
      cleanupHooks();
    }
  });
});

test("startTunnels spawns a real local stub binary without network", async () => {
  await withTempTunnelsDir(async (dir) => {
    const stub = join(dir, "cloudflared-stub.sh");
    await Deno.writeTextFile(
      stub,
      "#!/bin/sh\n# host-free tunnel stub — exits after a short wait or on signal\ntrap 'exit 0' TERM INT\nsleep 30\nexit 0\n",
    );
    await Deno.chmod(stub, 0o700);
    await Deno.writeTextFile(join(dir, "stub.token"), "stub-token\n");

    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      delay: () => Promise.resolve(),
      ensureCloudflared: () => Promise.resolve(stub),
    });

    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 50));
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 50));
    } finally {
      cleanupHooks();
    }
  });
});

test("startTunnels handles an immediately-exiting stub then aborts on restart", async () => {
  await withTempTunnelsDir(async (dir) => {
    const stub = join(dir, "cloudflared-exit.sh");
    await Deno.writeTextFile(stub, "#!/bin/sh\nexit 7\n");
    await Deno.chmod(stub, 0o700);
    await Deno.writeTextFile(join(dir, "exit.token"), "exit-token\n");

    let delayCalls = 0;
    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      delay: () => {
        delayCalls += 1;
        return Promise.resolve();
      },
      ensureCloudflared: () => Promise.resolve(stub),
    });

    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      await waitFor(() => delayCalls >= 1);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 30));
    } finally {
      cleanupHooks();
    }
  });
});

test("startTunnels rethrows unexpected tunnel directory errors", async () => {
  await withTempTunnelsDir(async (dir) => {
    const blocked = join(dir, "blocked");
    await Deno.writeTextFile(blocked, "not-a-directory\n");
    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: blocked,
      ensureCloudflared: () => Promise.resolve("/fake/cloudflared"),
    });
    try {
      const controller = new AbortController();
      await assertRejects(
        () => startTunnels(controller.signal),
        Error,
      );
      controller.abort();
    } finally {
      cleanupHooks();
    }
  });
});

test("startTunnels uses the default restart delay without a hook", async () => {
  await withTempTunnelsDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "delay.token"), "delay-token\n");

    const originalSetTimeout = globalThis.setTimeout;
    let capturedMs = -1;
    globalThis.setTimeout = ((handler: () => void, ms?: number) => {
      capturedMs = ms ?? 0;
      return originalSetTimeout(handler, 0);
    }) as typeof setTimeout;

    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      ensureCloudflared: () => Promise.resolve("/fake/cloudflared"),
      runTunnel: (_bin, _args, signal) => {
        if (signal.aborted) return Promise.resolve({ code: 0 });
        return Promise.resolve({ code: 1 });
      },
    });

    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      await waitFor(() => capturedMs === 5_000);
      assertEquals(capturedMs, 5_000);
      controller.abort();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      cleanupHooks();
    }
  });
});

test("startTunnels logs non-Error ensureCloudflared failures", async () => {
  await withTempTunnelsDir(async (dir) => {
    await Deno.writeTextFile(join(dir, "edge.token"), "tok\n");
    setTunnelsTestHooks({
      enabled: true,
      tunnelsDir: dir,
      ensureCloudflared: () => Promise.reject("string-failure"),
    });
    try {
      const controller = new AbortController();
      await startTunnels(controller.signal);
      controller.abort();
    } finally {
      cleanupHooks();
    }
  });
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new TypeError("timed out waiting for tunnels condition");
}
