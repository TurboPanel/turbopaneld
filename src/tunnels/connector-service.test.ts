import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import type { RunResult } from "../deploy/ensure-principal.ts";
import {
  type ConnectorIo,
  connectorStatus,
  controlConnector,
  installConnector,
  listConnectorIds,
  removeConnector,
} from "./connector-service.ts";
import type { ReadyProbe } from "./connector-unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID_A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const ID_B = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
const TOKEN = "dGVzdA".repeat(8);
const BIN = "/opt/turbopanel/vendor/cloudflared/2026.5.2/cloudflared";

type Harness = {
  io: ConnectorIo;
  calls: string[];
  /** Mode and text of the staged token at the moment tp-host was asked to copy it. */
  stagedEnv: { mode: number; text: string }[];
  /** Unit text at the moment tp-host was asked to install it. */
  installedUnits: string[];
  state: { unit: string; unchanged: boolean; fail: Set<string> };
  probe: { value: ReadyProbe };
  binaryCalls: { count: number };
};

/** Command text without the sudo / tp-host wrapping. */
function describeCall(command: string, args: string[]): string {
  return [command, ...args].filter((a) =>
    a !== "-n" && a !== "--" && a !== "sudo" && !a.endsWith("/tp-host")
  ).join(" ");
}

async function withHarness(
  fn: (h: Harness) => Promise<void>,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "connector-test-" });
  const workDir = join(root, "tunnels");
  const calls: string[] = [];
  const stagedEnv: { mode: number; text: string }[] = [];
  const installedUnits: string[] = [];
  const state = { unit: "active", unchanged: false, fail: new Set<string>() };
  const probe = { value: { kind: "ready", connections: 4 } as ReadyProbe };
  const binaryCalls = { count: 0 };
  const io: ConnectorIo = {
    layout: { configDir: join(root, "etc") },
    workDir,
    version: "2026.5.2",
    ensureBinary: () => {
      binaryCalls.count++;
      return Promise.resolve(BIN);
    },
    probe: () => Promise.resolve(probe.value),
    run: async (command, args): Promise<RunResult> => {
      const text = describeCall(command, args);
      calls.push(text);
      const ok: RunResult = { success: true, stdout: "", stderr: "" };
      for (const verb of state.fail) {
        if (text.startsWith(verb)) {
          return { success: false, stdout: "", stderr: `${verb} refused` };
        }
      }
      if (text.startsWith("tunnel-env-install ")) {
        const id = text.split(" ")[1];
        const path = join(workDir, `${id}.env`);
        stagedEnv.push({
          mode: (await Deno.stat(path)).mode! & 0o777,
          text: await Deno.readTextFile(path),
        });
      }
      if (text.startsWith("install ")) {
        installedUnits.push(await Deno.readTextFile(text.split(" ").at(-2)!));
      }
      if (text.startsWith("cmp ")) return { ...ok, success: state.unchanged };
      if (text.startsWith("systemctl is-active")) {
        return { ...ok, success: state.unit === "active", stdout: state.unit };
      }
      return ok;
    },
  };
  try {
    await fn({
      io,
      calls,
      stagedEnv,
      installedUnits,
      state,
      probe,
      binaryCalls,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("install stages a 0600 token, hands it to tp-host, installs the unit and starts it", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);

    assertEquals(h.stagedEnv.length, 1);
    assertEquals(h.stagedEnv[0].mode, 0o600);
    assertEquals(h.stagedEnv[0].text, `TUNNEL_TOKEN='${TOKEN}'\n`);
    // The staged copy is gone once root has its own.
    const left = [...Deno.readDirSync(h.io.workDir)].map((e) => e.name);
    assertEquals(left, [`${ID_A}.json`]);

    assertEquals(h.installedUnits.length, 1);
    assertStringIncludes(
      h.installedUnits[0],
      `EnvironmentFile=${h.io.layout.configDir}/tunnel-env/${ID_A}.env`,
    );
    assertStringIncludes(h.installedUnits[0], "--metrics 127.0.0.1:20300");

    const unit = `turbopanel-tunnel-${ID_A}.service`;
    assertEquals(h.calls.filter((c) => c.startsWith("systemctl")), [
      "systemctl daemon-reload",
      `systemctl reset-failed ${unit}`,
      `systemctl enable ${unit}`,
      `systemctl restart ${unit}`,
    ]);
    // The token is never in any command.
    assert(h.calls.every((c) => !c.includes(TOKEN)));
  });
});

test("installing again with the same token and unit does not restart the service", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.calls.length = 0;
    h.state.unchanged = true;
    await installConnector(h.io, ID_A, TOKEN);
    const unit = `turbopanel-tunnel-${ID_A}.service`;
    assert(h.calls.includes(`systemctl enable --now ${unit}`));
    assert(!h.calls.some((c) => c.startsWith("systemctl restart")));
    assert(!h.calls.includes("systemctl daemon-reload"));
  });
});

test("a new token restarts the service on the same port", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.calls.length = 0;
    h.state.unchanged = true;
    await installConnector(h.io, ID_A, `${TOKEN}AA`);
    assert(h.calls.some((c) => c.startsWith("systemctl restart")));
    const record = JSON.parse(
      await Deno.readTextFile(join(h.io.workDir, `${ID_A}.json`)),
    );
    assertEquals(record.port, 20300);
  });
});

test("two tunnels get two different metrics ports", async () => {
  await withHarness(async (h) => {
    await Promise.all([
      installConnector(h.io, ID_A, TOKEN),
      installConnector(h.io, ID_B, TOKEN),
    ]);
    assertEquals(await listConnectorIds(h.io), [ID_A, ID_B]);
    const ports = h.installedUnits.map((u) =>
      /--metrics 127\.0\.0\.1:(\d+)/.exec(u)![1]
    );
    assertEquals(new Set(ports).size, 2);
  });
});

test("a bad id or token is refused before anything runs", async () => {
  await withHarness(async (h) => {
    for (const id of ["", "../etc", `${ID_A}/x`, "x".repeat(36)]) {
      await assertRejects(() => installConnector(h.io, id, TOKEN), TypeError);
      await assertRejects(() => removeConnector(h.io, id), TypeError);
      await assertRejects(() => controlConnector(h.io, id, "stop"), TypeError);
      await assertRejects(() => connectorStatus(h.io, id), TypeError);
    }
    await assertRejects(
      () => installConnector(h.io, ID_A, "bad token"),
      TypeError,
    );
    assertEquals(h.calls, []);
    assertEquals(h.binaryCalls.count, 0);
  });
});

test("a refused token copy fails the install, names no token and leaves nothing staged", async () => {
  await withHarness(async (h) => {
    h.state.fail.add("tunnel-env-install");
    const err = await assertRejects(() => installConnector(h.io, ID_A, TOKEN));
    assert(!String(err).includes(TOKEN));
    assertEquals([...Deno.readDirSync(h.io.workDir)].length, 0);
    assert(!h.calls.some((c) => c.startsWith("install ")));
  });
});

test("remove stops the service, deletes the unit and the token copy, and forgets the tunnel", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.calls.length = 0;
    await removeConnector(h.io, ID_A);
    const unit = `turbopanel-tunnel-${ID_A}.service`;
    assertEquals(h.calls, [
      `systemctl disable --now ${unit}`,
      `rm -f /etc/systemd/system/${unit}`,
      "systemctl daemon-reload",
      `systemctl reset-failed ${unit}`,
      `tunnel-env-remove ${ID_A}`,
    ]);
    assertEquals(await listConnectorIds(h.io), []);
  });
});

test("remove fails loudly when the token copy cannot be removed", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.state.fail.add("tunnel-env-remove");
    await assertRejects(() => removeConnector(h.io, ID_A));
  });
});

test("start, stop and restart act on the tunnel's own unit and need an installed tunnel", async () => {
  await withHarness(async (h) => {
    await assertRejects(() => controlConnector(h.io, ID_A, "stop"));
    await installConnector(h.io, ID_A, TOKEN);
    h.calls.length = 0;
    for (
      const action of ["start", "stop", "restart", "enable", "disable"] as const
    ) {
      await controlConnector(h.io, ID_A, action);
    }
    const unit = `turbopanel-tunnel-${ID_A}.service`;
    assertEquals(h.calls, [
      `systemctl start ${unit}`,
      `systemctl stop ${unit}`,
      `systemctl restart ${unit}`,
      `systemctl enable ${unit}`,
      `systemctl disable ${unit}`,
    ]);
  });
});

test("status is connected only when the connector says it is ready", async () => {
  await withHarness(async (h) => {
    assertEquals(await connectorStatus(h.io, ID_A), "not-installed");
    await installConnector(h.io, ID_A, TOKEN);
    assertEquals(await connectorStatus(h.io, ID_A), "connected");
    h.probe.value = { kind: "not-ready", connections: 0 };
    assertEquals(await connectorStatus(h.io, ID_A), "connecting");
    h.state.unit = "failed";
    assertEquals(await connectorStatus(h.io, ID_A), "failed");
    h.state.unit = "inactive";
    assertEquals(await connectorStatus(h.io, ID_A), "stopped");
  });
});

test("the list ignores files that are not records of a tunnel id", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_B, TOKEN);
    await Deno.writeTextFile(join(h.io.workDir, "notes.json"), "{}");
    await Deno.writeTextFile(join(h.io.workDir, "..json"), "{}");
    await Deno.writeTextFile(join(h.io.workDir, `${ID_A}.json`), "garbage");
    assertEquals(await listConnectorIds(h.io), [ID_B]);
  });
});
