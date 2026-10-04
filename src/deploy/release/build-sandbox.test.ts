import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import { join } from "@std/path";
import { DAEMON_ROOT } from "../../orchestration/assets.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  buildSandboxEnabled,
  buildSpecCwd,
  type BuildWork,
  createBuildWorkDir,
  removeBuildTree,
  removeBuildWork,
  renderBuildSpec,
  resolveBuildWork,
  runSandboxedBuild,
  type SandboxSpawn,
  sweepStaleBuildWork,
} from "./build-sandbox.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

const RUNNER = join(DAEMON_ROOT, "orchestration/scripts/tp-build-runner");
const PROJECT = "01a0e39d-0418-7852-bc47-bc2f8422d404";
const TP_HOST = "/opt/turbopanel/lib/tp-host";

/** What the daemon sends: always the managed tp-host, whatever the layout guess. */
function managed(...argv: string[]): string[] {
  return ["-n", "--", TP_HOST, ...argv];
}

async function work(root = "/var/lib/turbopanel-build"): Promise<BuildWork> {
  return await resolveBuildWork(
    { serviceId: "svc1", releaseId: "20260927-120000", projectId: PROJECT },
    root,
  );
}

type FakeChild = {
  spawn: SandboxSpawn;
  argv: string[][];
  stdin: () => string;
  killed: string[];
};

/** A `sudo tp-host build-run` client that exits once `gate` settles. */
function fakeChild(
  result: { code: number; stdout?: string; stderr?: string },
  gate: Promise<void> = Promise.resolve(),
  onKill?: () => void,
): FakeChild {
  const argv: string[][] = [];
  const killed: string[] = [];
  const chunks: Uint8Array[] = [];
  const text = (value = "") =>
    new ReadableStream<Uint8Array>({
      async start(controller) {
        await gate;
        controller.enqueue(new TextEncoder().encode(value));
        controller.close();
      },
    });
  const spawn: SandboxSpawn = (args) => {
    argv.push(args);
    return {
      stdin: new WritableStream<Uint8Array>({
        write(chunk) {
          chunks.push(chunk);
        },
      }),
      stdout: text(result.stdout),
      stderr: text(result.stderr),
      status: gate.then(() => ({
        success: result.code === 0,
        code: result.code,
        signal: null,
      })),
      kill: (signal: string) => {
        killed.push(signal);
        onKill?.();
      },
    } as unknown as Deno.ChildProcess;
  };
  return {
    spawn,
    argv,
    killed,
    stdin: () =>
      chunks.map((chunk) => new TextDecoder().decode(chunk)).join(""),
  };
}

function recordingRunFn(
  failing: Record<string, string> = {},
): { runFn: RunFn; calls: string[][] } {
  const calls: string[][] = [];
  const runFn: RunFn = (_command, args) => {
    calls.push(args);
    const verb = args.find((arg) => arg in failing);
    return Promise.resolve(
      verb
        ? { success: false, stdout: "", stderr: failing[verb] }
        : { success: true, stdout: "", stderr: "" },
    );
  };
  return { runFn, calls };
}

test("the sandbox is decided by root-owned facts, not by the guessed install mode", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-sandbox-markers-" });
  try {
    const passwd = join(dir, "passwd");
    const tpHost = join(dir, "tp-host");
    const markers = { passwd, tpHost };
    await Deno.writeTextFile(passwd, "root:x:0:0::/root:/bin/sh\n");
    // A developer's machine: no build account, no managed tp-host.
    assertEquals(await buildSandboxEnabled(markers), false);
    // This suite runs in a "development" layout (what a planted main.ts or
    // ansible.cfg would make the daemon guess); the account alone wins.
    await Deno.writeTextFile(
      passwd,
      "tpbuild:x:9994:9994::/nonexistent:/usr/sbin/nologin\n",
      { append: true },
    );
    assertEquals(await buildSandboxEnabled(markers), true);
    // So does the managed tp-host alone (the role not yet converged).
    await Deno.writeTextFile(passwd, "root:x:0:0::/root:/bin/sh\n");
    await Deno.writeTextFile(tpHost, "#!/bin/sh\n");
    assertEquals(await buildSandboxEnabled(markers), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("a build's work tree is derived from its release and named the way tp-host accepts", async () => {
  const first = await work();
  const again = await work();
  assertEquals(first, again);
  assert(/^[a-z0-9]{32}$/.test(first.buildId));
  assertEquals(
    first.workDir,
    `/var/lib/turbopanel-build/work/${first.buildId}`,
  );
  assertEquals(first.checkoutDir, `${first.workDir}/source`);
  assertEquals(first.cacheDir, `/var/lib/turbopanel-build/cache/${PROJECT}`);
  await assertRejects(
    () =>
      resolveBuildWork({
        serviceId: "svc1",
        releaseId: "r1",
        projectId: "../etc",
      }),
    Error,
    "cannot name a build cache directory",
  );
});

test("the spec cwd stays inside the checkout", () => {
  assertEquals(buildSpecCwd(undefined), "source");
  assertEquals(buildSpecCwd("apps/web/"), "source/apps/web");
  for (
    const bad of ["../x", "/abs", "a/../../b", "a b", ".", "a/./b", "$(id)"]
  ) {
    assertThrows(() => buildSpecCwd(bad), Error, "cannot be built");
  }
});

test("a variable name no shell can carry never reaches the runner", () => {
  assertThrows(
    () =>
      renderBuildSpec({
        cwd: "source",
        env: { "BAD-NAME": "x" },
        commands: ["true"],
      }),
    Error,
    "not a shell name",
  );
});

test("the rendered spec runs through the real runner: cwd, env, order, stop at first failure", async () => {
  const workDir = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "tp-build-spec-" }),
  );
  try {
    await Deno.mkdir(join(workDir, "source/app"), { recursive: true });
    const spec = renderBuildSpec({
      cwd: "source/app",
      env: { GREETING: "multi\nline 'quoted' $HOME", CI: "1" },
      commands: [
        'printf "%s|%s|%s\\n" "$(pwd)" "$GREETING" "$CI" > out.txt',
        "echo second >> out.txt; exit 7",
        "echo never >> out.txt",
      ],
    });
    const child = new Deno.Command("sh", {
      args: [RUNNER, workDir],
      clearEnv: true,
      env: { PATH: "/usr/bin:/bin" },
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(spec));
    await writer.close();
    const out = await child.output();
    assertEquals(out.code, 7);
    assertStringIncludes(
      new TextDecoder().decode(out.stderr),
      "step 2 of 3 failed (exit 7)",
    );
    assertEquals(
      await Deno.readTextFile(join(workDir, "source/app/out.txt")),
      `${workDir}/source/app|multi\nline 'quoted' $HOME|1\nsecond\n`,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

test("a build is the fixed build-run argv with the spec on stdin, then build-return", async () => {
  const target = await work();
  const child = fakeChild({ code: 0, stdout: "built\n" });
  const { runFn, calls } = recordingRunFn();
  const lines: string[] = [];
  await runSandboxedBuild({
    work: target,
    spec: "tp-build-spec 1\nrun dHJ1ZQ==\nend\n",
    spawn: child.spawn,
    runFn,
    onOutput: (_stream, line) => lines.push(line),
  });
  assertEquals(child.argv, [
    managed("build-run", target.buildId, PROJECT),
  ]);
  assertEquals(child.stdin(), "tp-build-spec 1\nrun dHJ1ZQ==\nend\n");
  assertEquals(lines, ["built"]);
  assertEquals(calls, [managed("build-return", target.buildId)]);
});

test("a failed build reports its own stderr, and the tree still comes back", async () => {
  const target = await work();
  const child = fakeChild({
    code: 1,
    stderr: "npm ERR! missing script: build\n" +
      "tp-build-runner: step 2 of 2 failed (exit 1)\n",
  });
  const { runFn, calls } = recordingRunFn();
  await assertRejects(
    () =>
      runSandboxedBuild({ work: target, spec: "", spawn: child.spawn, runFn }),
    Error,
    "missing script: build",
  );
  assertEquals(calls, [managed("build-return", target.buildId)]);
});

test("a spec the runner refuses is reported as the sandbox's refusal", async () => {
  const target = await work();
  const child = fakeChild({
    code: 65,
    stderr: "tp-build-runner: bad spec: no end line\n",
  });
  const { runFn } = recordingRunFn();
  await assertRejects(
    () =>
      runSandboxedBuild({ work: target, spec: "", spawn: child.spawn, runFn }),
    Error,
    "the build sandbox refused the build spec (exit 65)",
  );
});

test("a timed-out build stops its unit before the tree is taken back", async () => {
  const target = await work();
  let finish = () => {};
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  // The client (sudo tp-host, maybe still waiting on the host lock) exits
  // only when it is killed.
  const child = fakeChild({ code: 143 }, gate, finish);
  const calls: string[][] = [];
  const runFn: RunFn = (_command, args) => {
    calls.push(args);
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  await assertRejects(
    () =>
      runSandboxedBuild({
        work: target,
        spec: "",
        spawn: child.spawn,
        runFn,
        timeoutMs: 10,
      }),
    Error,
    "build timed out after 10ms; the build unit was stopped",
  );
  assertEquals(child.killed, ["SIGTERM"]);
  assertEquals(calls, [
    managed("systemctl", "stop", `turbopanel-build-${target.buildId}.service`),
    managed("build-return", target.buildId),
  ]);
});

test("losing the client stops the unit and kills the client", async () => {
  const target = await work();
  const { runFn, calls } = recordingRunFn();
  const killed: string[] = [];
  const spawn: SandboxSpawn = () =>
    ({
      stdin: new WritableStream(),
      stdout: new ReadableStream({
        start(controller) {
          controller.error(new Error("stream torn"));
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close();
        },
      }),
      status: Promise.resolve({ success: false, code: 1, signal: null }),
      kill: (signal: string) => killed.push(signal),
    }) as unknown as Deno.ChildProcess;
  await assertRejects(
    () => runSandboxedBuild({ work: target, spec: "", spawn, runFn }),
    Error,
    "stream torn",
  );
  assertEquals(killed, ["SIGTERM"]);
  assertEquals(calls.map((args) => args.at(-2)), ["stop", "build-return"]);
});

test("a tree that cannot be taken back fails an otherwise good build", async () => {
  const target = await work();
  const child = fakeChild({ code: 0 });
  const { runFn } = recordingRunFn({
    "build-return": "turbopanel-build-x.service is still active",
  });
  await assertRejects(
    () =>
      runSandboxedBuild({ work: target, spec: "", spawn: child.spawn, runFn }),
    Error,
    "could not take the build tree back: turbopanel-build-x.service is still active",
  );
});

test("builds on one host run one at a time, and a waiting one says so", async () => {
  const first = await work();
  let finishFirst = () => {};
  const gate = new Promise<void>((resolve) => {
    finishFirst = resolve;
  });
  const order: string[] = [];
  const lines: string[] = [];
  const { runFn } = recordingRunFn();
  const one = runSandboxedBuild({
    work: first,
    spec: "",
    runFn,
    spawn: (args) => {
      order.push("start-1");
      return fakeChild(
        { code: 0 },
        gate.then(() => {
          order.push("end-1");
        }),
      ).spawn(args);
    },
  });
  const two = runSandboxedBuild({
    work: first,
    spec: "",
    runFn,
    onOutput: (_stream, line) => lines.push(line),
    spawn: (args) => {
      order.push("start-2");
      return fakeChild({ code: 0 }).spawn(args);
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assertEquals(order, ["start-1"]);
  finishFirst();
  await Promise.all([one, two]);
  assertEquals(order, ["start-1", "end-1", "start-2"]);
  assertEquals(lines, ["waiting for another build on this host to finish"]);
});

test("the work tree is created fresh, a stale one is taken back first, and a missing root names the role", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-build-root-" });
  try {
    await Deno.mkdir(join(root, "work"));
    const target = await work(root);
    const { runFn, calls } = recordingRunFn();
    await createBuildWorkDir(target, runFn);
    assertEquals((await Deno.stat(target.workDir)).mode! & 0o777, 0o700);
    assertEquals(calls, []);

    await Deno.writeTextFile(join(target.workDir, "left-behind"), "x");
    await createBuildWorkDir(target, runFn);
    assertEquals(calls, [
      managed(
        "systemctl",
        "stop",
        `turbopanel-build-${target.buildId}.service`,
      ),
      managed("build-return", target.buildId),
    ]);
    assertEquals([...Deno.readDirSync(target.workDir)], []);

    await removeBuildWork(target);
    await removeBuildWork(target);
    await Deno.remove(join(root, "work"));
    await assertRejects(
      () => createBuildWorkDir(target, runFn),
      Error,
      "run the build-user role",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("trees left by a dead daemon are stopped, taken back and removed; live ones are left", async () => {
  const root = await Deno.makeTempDir({ prefix: "tp-build-sweep-" });
  try {
    const old = join(root, "work", "0ld");
    const fresh = join(root, "work", "fresh");
    await Deno.mkdir(old, { recursive: true });
    await Deno.mkdir(fresh);
    await Deno.mkdir(join(root, "work", "Not-An-Id"));
    await Deno.writeTextFile(join(old, "left"), "x");
    const hourAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
    await Deno.utime(old, hourAgo, hourAgo);
    const { runFn, calls } = recordingRunFn();
    const lines: string[] = [];
    await sweepStaleBuildWork(root, {
      runFn,
      onOutput: (_stream, line) => lines.push(line),
    });
    assertEquals(calls, [
      managed("systemctl", "stop", "turbopanel-build-0ld.service"),
      managed("build-return", "0ld"),
    ]);
    assertEquals(await Deno.lstat(old).then(() => true, () => false), false);
    assertEquals((await Deno.lstat(fresh)).isDirectory, true);
    assertEquals(lines, [`reclaimed a stale build tree ${old}`]);

    // A tree tp-host will not hand back is reported and left.
    await Deno.utime(fresh, hourAgo, hourAgo);
    const refusing = recordingRunFn({ "build-return": "still active" });
    await sweepStaleBuildWork(root, {
      runFn: refusing.runFn,
      onOutput: (_stream, line) => lines.push(line),
    });
    assertStringIncludes(lines.at(-1) ?? "", "could not reclaim");
    assertEquals((await Deno.lstat(fresh)).isDirectory, true);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("a tree a build locked with mode 000 is still removed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-sandbox-locked-" });
  try {
    const tree = join(dir, "work1");
    await Deno.mkdir(join(tree, "d", "e"), { recursive: true });
    await Deno.writeTextFile(join(tree, "d", "e", "f"), "x");
    await Deno.symlink("/nonexistent", join(tree, "d", "link"));
    await Deno.chmod(join(tree, "d", "e"), 0o000);
    await Deno.chmod(join(tree, "d"), 0o000);
    assertEquals(await removeBuildTree(tree), true);
    assertEquals(await Deno.stat(tree).catch(() => null), null);
    // Removing what is already gone is not an error.
    assertEquals(await removeBuildTree(tree), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("removeBuildWork reports nothing for a locked tree and clears it", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-sandbox-locked-" });
  try {
    const target = { ...(await work(dir)), workDir: join(dir, "w") };
    await Deno.mkdir(join(target.workDir, "d"), { recursive: true });
    await Deno.chmod(join(target.workDir, "d"), 0o000);
    const messages: string[] = [];
    await removeBuildWork(target, (_s, line) => messages.push(line));
    assertEquals(messages, []);
    assertEquals(await Deno.stat(target.workDir).catch(() => null), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

const stuck: typeof Deno.remove = () =>
  Promise.reject(new Deno.errors.PermissionDenied("stuck"));

test("a tree that cannot be removed is renamed aside so the release can build again", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-sandbox-aside-" });
  try {
    const tree = join(dir, "abc123");
    await Deno.mkdir(join(tree, "d"), { recursive: true });
    assertEquals(await removeBuildTree(tree, stuck), false);
    assertEquals(await Deno.stat(tree).catch(() => null), null);
    const names = (await Array.fromAsync(Deno.readDir(dir))).map((e) => e.name);
    assertEquals(names.length, 1);
    assert(names[0].startsWith("q-") && names[0].endsWith("-abc123"));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("removeBuildWork says when it had to move a tree aside", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-sandbox-aside-" });
  try {
    const target = { ...(await work(dir)), workDir: join(dir, "w1") };
    await Deno.mkdir(target.workDir);
    const original = Deno.remove;
    Deno.remove = stuck;
    const messages: string[] = [];
    try {
      await removeBuildWork(target, (_s, line) => messages.push(line));
    } finally {
      Deno.remove = original;
    }
    assertEquals(messages.length, 1);
    assertStringIncludes(messages[0], "moved aside");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("the stale sweep retries a tree that was moved aside, without a unit stop", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-sandbox-sweep-" });
  try {
    await Deno.mkdir(join(dir, "work", "q-k1-abc123", "d"), {
      recursive: true,
    });
    await Deno.chmod(join(dir, "work", "q-k1-abc123", "d"), 0o000);
    const { runFn, calls } = recordingRunFn();
    const out: string[] = [];
    await sweepStaleBuildWork(dir, {
      runFn,
      maxAgeMs: -1000,
      onOutput: (_s, line) => out.push(line),
    });
    assertEquals(calls, []);
    assertEquals(out.length, 1);
    assertStringIncludes(out[0], "reclaimed");
    assertEquals(
      await Deno.stat(join(dir, "work", "q-k1-abc123")).catch(() => null),
      null,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
