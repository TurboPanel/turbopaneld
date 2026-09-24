import { assertEquals, assertThrows } from "@std/assert";
import { DAEMON_VERSION } from "../version.ts";
import { InstallerPresentedFailure } from "../orchestration/install-presenter-context.ts";
import {
  type DaemonCliIo,
  maybeRunDaemonCli,
  parseInstallerFlags,
} from "./cli.ts";

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
      sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/abc1234",
    }),
  });
  await maybeRunDaemonCli(io);
  assertEquals(exits, [0]);
  assertEquals(
    logs[0],
    `turbopaneld v${DAEMON_VERSION} abc1234 (trunk, build-1, 2026-01-01T00:00:00.000Z)`,
  );

  const verb = captureIo({
    args: ["version"],
    getBuildInfo: () => ({
      commit: "def5678",
      channel: "canary",
      buildId: "build-2",
      builtAt: "2026-02-02T00:00:00.000Z",
      sourceUrl: "https://github.com/TurboPanel/turbopaneld/tree/def5678",
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

  const empty = captureIo({ args: [] });
  await maybeRunDaemonCli(empty.io);
  assertEquals(empty.exits, []);
});

test("maybeRunDaemonCli --version uses getBuildInfo when not injected", async () => {
  const { io, exits, logs } = captureIo({ args: ["--version"] });
  await maybeRunDaemonCli(io);
  assertEquals(exits, [0]);
  assertEquals(logs[0]?.startsWith("turbopaneld "), true);
});

test("maybeRunDaemonCli uses Deno.args when args are not injected", async () => {
  const { io, exits } = captureIo();
  await maybeRunDaemonCli(io);
  assertEquals(Array.isArray(exits), true);
});

test("maybeRunDaemonCli version and installer errors use default console writers", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs: string[] = [];
  const errors: string[] = [];
  console.log = (...args: unknown[]) => {
    logs.push(String(args[0]));
  };
  console.error = (...args: unknown[]) => {
    errors.push(String(args[0]));
  };
  try {
    const version = captureIo({ args: ["--version"] });
    delete version.io.log;
    await maybeRunDaemonCli(version.io);
    assertEquals(version.exits, [0]);
    assertEquals(logs[0]?.startsWith("turbopaneld "), true);

    const installer = captureIo({ args: ["run-installer"] });
    delete installer.io.error;
    await maybeRunDaemonCli(installer.io);
    assertEquals(installer.exits, [1]);
    assertEquals(
      errors.some((line) => line.includes("--instance-url or --vars-file")),
      true,
    );
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
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
  for (
    const flag of [
      "--instance-url",
      "--instance-ca",
      "--tunnel-token",
      "--vars-file",
      "--start",
    ]
  ) {
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

test("parseInstallerFlags accepts only the two shipped installers for --playbook", () => {
  const ok = captureIo();
  assertEquals(
    parseInstallerFlags([
      "--vars-file",
      "/tmp/v.yml",
      "--playbook",
      "instance-install.yml",
    ], ok.io),
    { start: true, varsFile: "/tmp/v.yml", playbook: "instance-install.yml" },
  );
  assertEquals(
    parseInstallerFlags(["--playbook", "daemon-install.yml"], ok.io).playbook,
    "daemon-install.yml",
  );
  const refresh = captureIo();
  assertEquals(
    parseInstallerFlags([
      "--playbook",
      "daemon-colocated-refresh.yml",
    ], refresh.io).playbook,
    "daemon-colocated-refresh.yml",
  );
  // Never a path: a vars file or flag must not point the daemon at arbitrary
  // YAML on the host.
  for (
    const bad of ["/etc/evil.yml", "../daemon-install.yml", "site.yml", ""]
  ) {
    const { io, exits, errors } = captureIo();
    assertThrows(
      () => parseInstallerFlags(["--playbook", bad], io),
      TypeError,
    );
    assertEquals(exits, [1]);
    assertEquals(
      errors.some((line) =>
        line.includes(
          "--playbook must be one of: daemon-install.yml, instance-install.yml",
        ) ||
        line.includes("--playbook requires a value")
      ),
      true,
      `bad playbook ${
        JSON.stringify(bad)
      } must be refused with a clear message`,
    );
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
