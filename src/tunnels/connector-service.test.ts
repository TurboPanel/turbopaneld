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
  reportConnectors,
  updateAllConnectors,
  updateConnector,
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

type Harness = {
  io: ConnectorIo;
  calls: string[];
  /** Mode and text of the staged token at the moment tp-host was asked to copy it. */
  stagedEnv: { mode: number; text: string }[];
  /** Unit text at the moment tp-host was asked to install it. */
  installedUnits: string[];
  state: { unit: string; unchanged: boolean; fail: Set<string> };
  probe: { value: ReadyProbe; byPort: Map<number, ReadyProbe> };
  binaryCalls: { count: number };
  /** Unit paths `io.unitExists` reports as present. */
  onDisk: Set<string>;
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
  const probe = {
    value: { kind: "ready", connections: 4 } as ReadyProbe,
    byPort: new Map<number, ReadyProbe>(),
  };
  const binaryCalls = { count: 0 };
  const onDisk = new Set<string>();
  const io: ConnectorIo = {
    layout: { configDir: join(root, "etc") },
    workDir,
    version: "2026.5.2",
    ensureBinary: () => {
      binaryCalls.count++;
      return Promise.resolve(
        `/opt/turbopanel/vendor/cloudflared/${io.version}/cloudflared`,
      );
    },
    probe: (port) => Promise.resolve(probe.byPort.get(port) ?? probe.value),
    unitExists: (path) => Promise.resolve(onDisk.has(path)),
    readyTimeoutMs: 4,
    readyPollMs: 2,
    sleep: () => Promise.resolve(),
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
      onDisk,
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
    const second = `turbopanel-tunnel-${ID_A}-b.service`;
    assertEquals(h.calls, [
      `systemctl disable --now ${unit}`,
      `rm -f /etc/systemd/system/${unit}`,
      `systemctl reset-failed ${unit}`,
      `systemctl disable --now ${second}`,
      `rm -f /etc/systemd/system/${second}`,
      `systemctl reset-failed ${second}`,
      "systemctl daemon-reload",
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

test("the record is written only after the service starts, and a retry restarts it", async () => {
  await withHarness(async (h) => {
    h.state.fail.add("systemctl restart");
    await assertRejects(() => installConnector(h.io, ID_A, TOKEN));
    assertEquals(await listConnectorIds(h.io), []);
    h.state.fail.clear();
    h.state.unchanged = true;
    h.calls.length = 0;
    await installConnector(h.io, ID_A, TOKEN);
    assert(h.calls.some((c) => c.startsWith("systemctl restart")));
    assertEquals(await listConnectorIds(h.io), [ID_A]);
  });
});

test("a retry after a failed token change restarts even though the unit is unchanged", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.state.unchanged = true;
    h.state.fail.add("systemctl restart");
    await assertRejects(() => installConnector(h.io, ID_A, `${TOKEN}AA`));
    h.state.fail.clear();
    h.calls.length = 0;
    await installConnector(h.io, ID_A, `${TOKEN}AA`);
    assert(h.calls.some((c) => c.startsWith("systemctl restart")));
  });
});

test("a failed unit install removes the token copy of a tunnel that never ran", async () => {
  await withHarness(async (h) => {
    h.state.fail.add("install ");
    await assertRejects(() => installConnector(h.io, ID_A, TOKEN));
    assert(h.calls.includes(`tunnel-env-remove ${ID_A}`));
    assertEquals([...Deno.readDirSync(h.io.workDir)].length, 0);
  });
});

test("a failed unit install keeps the token copy of a tunnel that already runs", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.calls.length = 0;
    h.state.fail.add("install ");
    await assertRejects(() => installConnector(h.io, ID_A, `${TOKEN}AA`));
    assert(!h.calls.includes(`tunnel-env-remove ${ID_A}`));
  });
});

const unitOf = (id: string, slot: "a" | "b" = "a") =>
  `turbopanel-tunnel-${id}${slot === "b" ? "-b" : ""}.service`;
const NEW = "2026.6.0";

async function readRecordFile(h: Harness, id: string) {
  return JSON.parse(await Deno.readTextFile(join(h.io.workDir, `${id}.json`)));
}

test("an update starts the new version in the other slot and moves only after it connects", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.io.version = NEW;
    h.calls.length = 0;
    h.installedUnits.length = 0;

    const outcome = await updateConnector(h.io, ID_A);
    assertEquals(outcome, { kind: "updated", from: "2026.5.2", to: NEW });

    assertEquals(h.installedUnits.length, 1);
    assertStringIncludes(
      h.installedUnits[0],
      `ExecStart=/opt/turbopanel/vendor/cloudflared/${NEW}/cloudflared tunnel run --no-autoupdate --metrics 127.0.0.1:20301`,
    );
    assertStringIncludes(
      h.installedUnits[0],
      `SyslogIdentifier=turbopanel-tunnel-${ID_A}-b`,
    );
    // The new unit reads the same root-only token copy; no token is handled.
    assertStringIncludes(
      h.installedUnits[0],
      `EnvironmentFile=${h.io.layout.configDir}/tunnel-env/${ID_A}.env`,
    );
    assert(h.calls.every((c) => !c.startsWith("tunnel-env-install")));
    assert(h.calls.every((c) => !c.includes(TOKEN)));

    const second = unitOf(ID_A, "b");
    const first = unitOf(ID_A);
    const order = h.calls.filter((c) => c.startsWith("systemctl"));
    const startNew = order.indexOf(`systemctl start ${second}`);
    const stopOld = order.indexOf(`systemctl disable --now ${first}`);
    assert(startNew >= 0 && stopOld > startNew, order.join("\n"));

    const record = await readRecordFile(h, ID_A);
    assertEquals(record.slot, "b");
    assertEquals(record.version, NEW);
    assertEquals(record.port, 20301);
    assertEquals(await listConnectorIds(h.io), [ID_A]);
  });
});

test("a new connector that never connects is removed and the old one is not touched", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.io.version = NEW;
    h.probe.byPort.set(20301, { kind: "not-ready", connections: 0 });
    h.calls.length = 0;

    const outcome = await updateConnector(h.io, ID_A);
    assertEquals(outcome.kind, "rolled-back");
    if (outcome.kind === "rolled-back") {
      assertEquals(outcome.version, "2026.5.2");
      assertStringIncludes(outcome.reason, "did not report connected");
    }
    const second = unitOf(ID_A, "b");
    assert(h.calls.includes(`systemctl disable --now ${second}`));
    assert(h.calls.includes(`rm -f /etc/systemd/system/${second}`));
    // Nothing was done to the running unit.
    assert(h.calls.every((c) => !c.includes(unitOf(ID_A))));
    const record = await readRecordFile(h, ID_A);
    assertEquals(record.slot, "a");
    assertEquals(record.version, "2026.5.2");
    assertEquals(record.port, 20300);
  });
});

test("a new unit that cannot start rolls back and keeps the old connector", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.io.version = NEW;
    h.state.fail.add(`systemctl start ${unitOf(ID_A, "b")}`);
    const outcome = await updateConnector(h.io, ID_A);
    assertEquals(outcome.kind, "rolled-back");
    assertEquals((await readRecordFile(h, ID_A)).slot, "a");
  });
});

test("an update that cannot be installed rolls back", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.io.version = NEW;
    h.state.fail.add("install ");
    const outcome = await updateConnector(h.io, ID_A);
    assertEquals(outcome.kind, "rolled-back");
    assertEquals((await readRecordFile(h, ID_A)).version, "2026.5.2");
  });
});

test("a connector already on the pinned version is left alone, and an unknown tunnel is reported", async () => {
  await withHarness(async (h) => {
    assertEquals(await updateConnector(h.io, ID_A), { kind: "not-installed" });
    await installConnector(h.io, ID_A, TOKEN);
    h.calls.length = 0;
    assertEquals(await updateConnector(h.io, ID_A), {
      kind: "current",
      version: "2026.5.2",
    });
    assertEquals(h.calls, []);
  });
});

test("a second unit left by an interrupted switch is removed first", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    const second = unitOf(ID_A, "b");
    h.onDisk.add(`/etc/systemd/system/${second}`);
    h.calls.length = 0;
    const outcome = await updateConnector(h.io, ID_A);
    assertEquals(outcome.kind, "current");
    assert(h.calls.includes(`systemctl disable --now ${second}`));
    assert(h.calls.includes(`rm -f /etc/systemd/system/${second}`));
    assert(h.calls.includes("systemctl daemon-reload"));
  });
});

test("the verbs follow the recorded slot, and the next update goes back to slot a", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.io.version = NEW;
    await updateConnector(h.io, ID_A);
    h.calls.length = 0;
    await controlConnector(h.io, ID_A, "restart");
    await connectorStatus(h.io, ID_A);
    assertEquals(h.calls, [
      `systemctl restart ${unitOf(ID_A, "b")}`,
      `systemctl is-active ${unitOf(ID_A, "b")}`,
    ]);

    h.io.version = "2026.7.0";
    const outcome = await updateConnector(h.io, ID_A);
    assertEquals(outcome, { kind: "updated", from: NEW, to: "2026.7.0" });
    const record = await readRecordFile(h, ID_A);
    assertEquals(record.slot, "a");
    assertEquals(record.port, 20300);
  });
});

test("a token change on an updated tunnel restarts the unit in the slot that carries it", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    h.io.version = NEW;
    await updateConnector(h.io, ID_A);
    h.calls.length = 0;
    await installConnector(h.io, ID_A, "b3RoZXI".repeat(6));
    const second = unitOf(ID_A, "b");
    assert(h.calls.includes(`systemctl restart ${second}`), h.calls.join("\n"));
    assertEquals((await readRecordFile(h, ID_A)).slot, "b");
  });
});

test("updating every tunnel goes one at a time and one failure does not stop the others", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    await installConnector(h.io, ID_B, TOKEN);
    h.io.version = NEW;
    h.state.fail.add(`systemctl start ${unitOf(ID_A, "b")}`);
    const results = await updateAllConnectors(h.io);
    assertEquals(results.map((r) => [r.id, r.outcome.kind]), [
      [ID_A, "rolled-back"],
      [ID_B, "updated"],
    ]);
  });
});

test("the report lists each connector with status, version and slot, and the pinned version", async () => {
  await withHarness(async (h) => {
    await installConnector(h.io, ID_A, TOKEN);
    await installConnector(h.io, ID_B, TOKEN);
    h.io.version = NEW;
    await updateConnector(h.io, ID_B);
    const report = await reportConnectors(h.io);
    assertEquals(report, {
      pinnedVersion: NEW,
      connectors: [
        { tunnelId: ID_A, status: "connected", version: "2026.5.2", slot: "a" },
        { tunnelId: ID_B, status: "connected", version: NEW, slot: "b" },
      ],
    });
  });
});
