import { assertEquals, assertThrows } from "@std/assert";
import { InstallerPresentedFailure } from "./orchestration/install-presenter-context.ts";
import {
  maybeRunDaemonCli,
  parseInstallerFlags,
  type DaemonCliIo,
} from "./daemon-cli.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function captureIo(overrides: Partial<DaemonCliIo> = {}): {
  io: DaemonCliIo;
  exits: number[];
  logs: string[];
  errors: string[];
} {
  const exits: number[] = [];
  const logs: string[] = [];
  const errors: string[] = [];
  return {
    exits,
    logs,
    errors,
    io: {
      exit: (code) => {
        exits.push(code);
      },
      log: (message) => {
        logs.push(message);
      },
      error: (message) => {
        errors.push(message);
      },
      ...overrides,
    },
  };
}

test("maybeRunDaemonCli prints version and exits 0", async () => {
  const { io, exits, logs } = captureIo({
    args: ["--version"],
    getBuildInfo: () => ({
      commit: "abc1234",
      channel: "trunk",
      buildId: "build-1",
      builtAt: "2026-01-01T00:00:00.000Z",
    }),
  });
  await maybeRunDaemonCli(io);
  assertEquals(exits, [0]);
  assertEquals(
    logs[0],
    "turbopaneld abc1234 (trunk, build-1, 2026-01-01T00:00:00.000Z)",
  );

  const verb = captureIo({
    args: ["version"],
    getBuildInfo: () => ({
      commit: "def5678",
      channel: "canary",
      buildId: "build-2",
      builtAt: "2026-02-02T00:00:00.000Z",
    }),
  });
  await maybeRunDaemonCli(verb.io);
  assertEquals(verb.exits, [0]);
  assertEquals(verb.logs[0]?.includes("def5678"), true);
});

test("maybeRunDaemonCli bootstrap success and failure", async () => {
  const ok = captureIo({
    args: ["bootstrap-orchestration"],
    runBootstrapOrchestration: () => Promise.resolve(),
  });
  await maybeRunDaemonCli(ok.io);
  assertEquals(ok.exits, [0]);

  const fail = captureIo({
    args: ["bootstrap-orchestration"],
    runBootstrapOrchestration: () => Promise.reject(new Error("ansible down")),
  });
  await maybeRunDaemonCli(fail.io);
  assertEquals(fail.exits, [1]);
  assertEquals(fail.errors[0]?.includes("[bootstrap]"), true);

  const presented = captureIo({
    args: ["bootstrap-orchestration"],
    runBootstrapOrchestration: () =>
      Promise.reject(new InstallerPresentedFailure()),
  });
  await maybeRunDaemonCli(presented.io);
  assertEquals(presented.exits, [1]);
  assertEquals(presented.errors, []);
});

test("maybeRunDaemonCli unknown verb falls through", async () => {
  const { io, exits } = captureIo({ args: ["start"] });
  await maybeRunDaemonCli(io);
  assertEquals(exits, []);
});

test("parseInstallerFlags reads known flags", () => {
  const { io } = captureIo();
  const flags = parseInstallerFlags([
    "--instance-url",
    "https://panel.example",
    "--start",
    "false",
    "--instance-ca",
    "/tmp/ca.pem",
    "--tunnel-token",
    "tok",
    "--vars-file",
    "/tmp/vars.yml",
  ], io);
  assertEquals(flags, {
    instanceUrl: "https://panel.example",
    start: false,
    instanceCa: "/tmp/ca.pem",
    tunnelToken: "tok",
    varsFile: "/tmp/vars.yml",
  });
});

test("parseInstallerFlags defaults start to true", () => {
  const { io } = captureIo();
  assertEquals(parseInstallerFlags([], io), { start: true });
  assertEquals(
    parseInstallerFlags(["--start", "true"], io).start,
    true,
  );
});

test("parseInstallerFlags exits on --start values that are not true/false", () => {
  const { io, exits, errors } = captureIo();
  assertThrows(
    () => parseInstallerFlags(["--start", "yes"], io),
    TypeError,
    "--start requires true or false",
  );
  assertEquals(exits, [1]);
  assertEquals(errors[0], "[installer] --start requires true or false");
});

test("parseInstallerFlags exits when a value is missing", () => {
  for (const flag of [
    "--instance-url",
    "--instance-ca",
    "--tunnel-token",
    "--vars-file",
    "--start",
  ]) {
    const { io, exits, errors } = captureIo();
    assertThrows(
      () => parseInstallerFlags([flag], io),
      TypeError,
      `${flag} requires a value`,
    );
    assertEquals(exits, [1]);
    assertEquals(errors[0], `[installer] ${flag} requires a value`);
  }
});

test("parseInstallerFlags exits on unknown flags", () => {
  const { io, exits, errors } = captureIo();
  assertThrows(
    () => parseInstallerFlags(["--nope"], io),
    TypeError,
    "unknown installer flag: --nope",
  );
  assertEquals(exits, [1]);
  assertEquals(errors[0]?.includes("unknown flag"), true);
});

test("run-installer requires instance-url or vars-file", async () => {
  const { io, exits, errors } = captureIo({
    args: ["run-installer"],
  });
  await maybeRunDaemonCli(io);
  assertEquals(exits, [1]);
  assertEquals(
    errors[0],
    "[installer] --instance-url or --vars-file is required",
  );
});

test("run-installer success and failure paths", async () => {
  const seen: unknown[] = [];
  const ok = captureIo({
    args: ["run-installer", "--instance-url", "https://panel.example"],
    runInstaller: (flags) => {
      seen.push(flags);
      return Promise.resolve();
    },
  });
  await maybeRunDaemonCli(ok.io);
  assertEquals(ok.exits, [0]);
  assertEquals(
    (seen[0] as { instanceUrl?: string }).instanceUrl,
    "https://panel.example",
  );

  const fail = captureIo({
    args: ["run-installer", "--vars-file", "/tmp/vars.yml"],
    runInstaller: () => Promise.reject(new Error("playbook failed")),
  });
  await maybeRunDaemonCli(fail.io);
  assertEquals(fail.exits, [1]);
  assertEquals(fail.errors[0]?.includes("[installer]"), true);

  const presented = captureIo({
    args: ["run-installer", "--vars-file", "/tmp/vars.yml"],
    runInstaller: () => Promise.reject(new InstallerPresentedFailure()),
  });
  await maybeRunDaemonCli(presented.io);
  assertEquals(presented.exits, [1]);
  assertEquals(presented.errors, []);
});
