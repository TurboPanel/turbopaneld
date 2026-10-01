import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import type { FirewallReconcilePayload } from "../contracts/commands-contracts.ts";
import {
  applyRenderedFirewall,
  FIREWALL_V4_FILENAME,
  FIREWALL_V6_FILENAME,
  FirewallIpv6ApplyError,
  hasDockerUserChain,
  isControlPlaneColocated,
  probeXtables,
  reinstallFirewallForwardingIfEnabled,
  removeFirewall,
  snapshotFirewallChains,
} from "./apply.ts";
import { renderFirewall } from "./render.ts";
import {
  FIREWALL_CONFIRM_WINDOW_SECONDS,
  FIREWALL_GUARD_TIMER,
  FIREWALL_PENDING_V4_FILENAME,
  FIREWALL_PENDING_V6_FILENAME,
  FirewallGuardUnavailableError,
  pendingMarkerPath,
  readPendingMarker,
  rollbackRecordPath,
} from "./pending.ts";
import {
  type FirewallRunFn,
  type FirewallRunResult,
  runFirewallHost,
  setFirewallRunForTests,
  setFirewallSkipRealSyscallsForTests,
  XTABLES_LOCK_WAIT_SECONDS,
} from "./run.ts";
import {
  parseSshdEffectivePorts,
  readSshdEffectivePorts,
} from "./sshd-port.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ok = (stdout = ""): FirewallRunResult => ({
  success: true,
  code: 0,
  stdout,
  stderr: "",
});
const fail = (stderr: string, code = 1): FirewallRunResult => ({
  success: false,
  code,
  stdout: "",
  stderr,
});

type Call = { cmd: string; args: string[]; stdin?: string };

/**
 * A fake host: a recording runner whose answers come from a table keyed on
 * `cmd args...`. Anything unlisted succeeds silently, the way a healthy host
 * would, so a test only names the interesting answers.
 */
function fakeHost(
  answers: Record<string, FirewallRunResult> = {},
): { run: FirewallRunFn; calls: Call[] } {
  const calls: Call[] = [];
  const run: FirewallRunFn = (cmd, args, options) => {
    calls.push({ cmd, args, stdin: options?.stdin });
    const key = `${cmd} ${args.join(" ")}`;
    for (const [pattern, result] of Object.entries(answers)) {
      if (
        key === pattern || key.startsWith(`${pattern} `) ||
        key.endsWith(pattern)
      ) {
        return Promise.resolve(result);
      }
    }
    return Promise.resolve(ok());
  };
  return { run, calls };
}

function payload(
  overrides: Partial<FirewallReconcilePayload> = {},
): FirewallReconcilePayload {
  return {
    generation: 4,
    mode: "managed",
    policy: { inputDefault: "accept", ipv6: "mirror" },
    rules: [],
    ...overrides,
  };
}

const NFT_PROBE = {
  ok: true,
  version: "iptables v1.8.11 (nf_tables)",
  ipv6: true,
};

async function withTempLayout<T>(
  fn: (layout: ReturnType<typeof resolveLayout>) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-fw-" });
  try {
    const layout = resolveLayout({
      TURBOPANEL_CONFIG_DIR: join(root, "etc"),
      TURBOPANEL_STATE_DIR: join(root, "state"),
      TURBOPANEL_DAEMON_STATE_DIR: join(root, "state"),
      TURBOPANEL_RUN_DIR: join(root, "run"),
    });
    return await fn(layout);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("runFirewallHost prepends -w to every xtables binary and nothing else", async () => {
  const seen: Call[] = [];
  setFirewallRunForTests((cmd, args) => {
    seen.push({ cmd, args });
    return Promise.resolve(ok());
  });
  try {
    await runFirewallHost("iptables", ["-S"]);
    await runFirewallHost("ip6tables-restore", ["--noflush"]);
    await runFirewallHost("sshd", ["-T"]);
  } finally {
    setFirewallRunForTests(null);
  }
  assertEquals(seen[0]!.args, ["-w", String(XTABLES_LOCK_WAIT_SECONDS), "-S"]);
  assertEquals(seen[1]!.args, [
    "-w",
    String(XTABLES_LOCK_WAIT_SECONDS),
    "--noflush",
  ]);
  assertEquals(seen[2]!.args, ["-T"]);
});

test("runFirewallHost skip-real-syscalls answers success without spawning", async () => {
  setFirewallSkipRealSyscallsForTests(true);
  try {
    const result = await runFirewallHost("iptables", ["-V"]);
    assertEquals(result.success, true);
  } finally {
    setFirewallSkipRealSyscallsForTests(false);
  }
});

test("probeXtables reports a missing binary, a legacy backend, and ip6tables availability", async () => {
  const missing = fakeHost({
    "iptables -V": fail("spawn failed: No such file or directory", 127),
  });
  const probe = await probeXtables(missing.run);
  assertEquals(probe.ok, false);
  assertStringIncludes(probe.warning!, "not installed");

  const legacy = fakeHost({
    "iptables -V": ok("iptables v1.8.9 (legacy)"),
    "ip6tables -V": fail("not found", 127),
  });
  const legacyProbe = await probeXtables(legacy.run);
  assertEquals(legacyProbe.ok, true);
  assertEquals(legacyProbe.ipv6, false);
  assertStringIncludes(legacyProbe.warning!, "legacy backend");

  const nft = fakeHost({ "iptables -V": ok("iptables v1.8.11 (nf_tables)") });
  const nftProbe = await probeXtables(nft.run);
  assertEquals(nftProbe, {
    ok: true,
    version: "iptables v1.8.11 (nf_tables)",
    ipv6: true,
  });
});

test("hasDockerUserChain and isControlPlaneColocated read the host's answer", async () => {
  const host = fakeHost({
    "iptables -S DOCKER-USER": ok("-N DOCKER-USER\n-A DOCKER-USER -j RETURN"),
    "ip6tables -S DOCKER-USER": fail(
      "iptables: No chain/target/match by that name.",
    ),
    "systemctl is-active turbopanel-instance.service": ok("active"),
  });
  assertEquals(await hasDockerUserChain(4, host.run), true);
  assertEquals(await hasDockerUserChain(6, host.run), false);
  assertEquals(await isControlPlaneColocated(host.run), true);
  const plain = fakeHost({
    "systemctl is-active turbopanel-instance.service": fail("inactive", 3),
  });
  assertEquals(await isControlPlaneColocated(plain.run), false);
});

test("applyRenderedFirewall: guard armed first, --test then restore per family, jumps ensured only when missing, documents left pending", async () => {
  await withTempLayout(async (layout) => {
    const rendered = renderFirewall({
      payload: payload(),
      sshPorts: [22],
      includeForward: { 4: true, 6: true },
    });
    // v4 INPUT jump already present; DOCKER-USER jump absent; v6 both absent
    const host = fakeHost({
      "iptables -C INPUT -j TP-INPUT": ok(),
      "iptables -C DOCKER-USER -j TP-FWD": fail(
        "iptables: Bad rule (does a matching rule exist in that chain?).",
      ),
      "ip6tables -C INPUT -j TP-INPUT": fail("Bad rule"),
      "ip6tables -C DOCKER-USER -j TP-FWD": fail("Bad rule"),
    });
    const now = new Date("2026-10-01T12:00:00.000Z");
    const outcome = await applyRenderedFirewall(
      rendered,
      { 4: true, 6: true },
      NFT_PROBE,
      { run: host.run, layout, generation: 4, now: () => now },
    );
    assertEquals(outcome, {
      ipv6Applied: true,
      forwardApplied: true,
      warnings: [],
      confirmation: {
        deadlineAt: "2026-10-01T12:02:00.000Z",
        windowSeconds: FIREWALL_CONFIRM_WINDOW_SECONDS,
      },
    });
    const keys = host.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`);
    assertEquals(keys, [
      `systemctl restart ${FIREWALL_GUARD_TIMER}`,
      "iptables-restore --noflush --test",
      "iptables-restore --noflush",
      "iptables -C INPUT -j TP-INPUT",
      "iptables -C DOCKER-USER -j TP-FWD",
      "iptables -I DOCKER-USER 1 -j TP-FWD",
      "ip6tables-restore --noflush --test",
      "ip6tables-restore --noflush",
      "ip6tables -C INPUT -j TP-INPUT",
      "ip6tables -I INPUT 1 -j TP-INPUT",
      "ip6tables -C DOCKER-USER -j TP-FWD",
      "ip6tables -I DOCKER-USER 1 -j TP-FWD",
    ]);
    // the restore documents went in over stdin, byte for byte
    assertEquals(host.calls[1]!.stdin, rendered.v4);
    assertEquals(host.calls[2]!.stdin, rendered.v4);
    assertEquals(host.calls[6]!.stdin, rendered.v6!);
    // Nothing durable yet: the documents wait, pending, for a confirm.
    await assertRejects(
      () => Deno.readTextFile(join(layout.configDir, FIREWALL_V4_FILENAME)),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.readTextFile(join(layout.configDir, FIREWALL_V6_FILENAME)),
      Deno.errors.NotFound,
    );
    assertEquals(
      await Deno.readTextFile(
        join(layout.configDir, FIREWALL_PENDING_V4_FILENAME),
      ),
      rendered.v4,
    );
    assertEquals(
      await Deno.readTextFile(
        join(layout.configDir, FIREWALL_PENDING_V6_FILENAME),
      ),
      rendered.v6!,
    );
    assertEquals(await readPendingMarker(layout), {
      version: 1,
      digest: rendered.digest,
      generation: 4,
      armedAt: "2026-10-01T12:00:00.000Z",
      deadlineAt: "2026-10-01T12:02:00.000Z",
      windowSeconds: FIREWALL_CONFIRM_WINDOW_SECONDS,
      v6: "replace",
    });
  });
});

test("applyRenderedFirewall: when the guard cannot be armed, no rule is loaded and nothing stays staged", async () => {
  await withTempLayout(async (layout) => {
    const rendered = renderFirewall({
      payload: payload(),
      sshPorts: [22],
      includeForward: { 4: false, 6: false },
    });
    const host = fakeHost({
      [`systemctl restart ${FIREWALL_GUARD_TIMER}`]: fail(
        `Unit ${FIREWALL_GUARD_TIMER} not found.`,
        5,
      ),
    });
    const err = await assertRejects(
      () =>
        applyRenderedFirewall(rendered, { 4: false, 6: false }, NFT_PROBE, {
          run: host.run,
          layout,
        }),
      FirewallGuardUnavailableError,
    );
    assertStringIncludes(err.message, "no rules were loaded");
    assertStringIncludes(err.message, "not found");
    assertEquals(host.calls.length, 1, "no iptables call after a failed arm");
    assertEquals(await readPendingMarker(layout), null);
    await assertRejects(
      () =>
        Deno.readTextFile(join(layout.configDir, FIREWALL_PENDING_V4_FILENAME)),
      Deno.errors.NotFound,
    );
  });
});

test("applyRenderedFirewall: a second apply inside the window moves the deadline and forgets an earlier rollback", async () => {
  await withTempLayout(async (layout) => {
    const rendered = renderFirewall({
      payload: payload(),
      sshPorts: [22],
      includeForward: { 4: false, 6: false },
    });
    await Deno.mkdir(layout.stateDir, { recursive: true });
    await Deno.writeTextFile(rollbackRecordPath(layout), "{}");
    const host = fakeHost();
    const first = new Date("2026-10-01T12:00:00.000Z");
    const later = new Date("2026-10-01T12:01:00.000Z");
    for (const now of [first, later]) {
      await applyRenderedFirewall(
        rendered,
        { 4: false, 6: false },
        { ...NFT_PROBE, ipv6: false },
        { run: host.run, layout, now: () => now },
      );
    }
    assertEquals(
      (await readPendingMarker(layout))?.deadlineAt,
      "2026-10-01T12:03:00.000Z",
    );
    assertEquals(
      host.calls.filter((c) => c.cmd === "systemctl").length,
      2,
      "the timer is restarted on every apply, so the deadline really moves",
    );
    await assertRejects(
      () => Deno.readTextFile(rollbackRecordPath(layout)),
      Deno.errors.NotFound,
    );
  });
});

test("applyRenderedFirewall: a refused v4 --test throws before anything is applied", async () => {
  await withTempLayout(async (layout) => {
    const rendered = renderFirewall({
      payload: payload(),
      sshPorts: [22],
      includeForward: { 4: true, 6: false },
    });
    const host = fakeHost({
      "iptables-restore --noflush --test": fail(
        "iptables-restore v1.8.11 (nf_tables): invalid port/service `99999' specified\nError occurred at line: 3",
      ),
    });
    await assertRejects(
      () =>
        applyRenderedFirewall(rendered, { 4: true, 6: false }, NFT_PROBE, {
          run: host.run,
          layout,
        }),
      Error,
      "--test refused the ruleset",
    );
    assertEquals(
      host.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`),
      [
        `systemctl restart ${FIREWALL_GUARD_TIMER}`,
        "iptables-restore --noflush --test",
        `systemctl stop ${FIREWALL_GUARD_TIMER}`,
      ],
      "armed, refused, then disarmed: nothing reached the kernel",
    );
    assertEquals(await readPendingMarker(layout), null);
    await assertRejects(
      () => Deno.readTextFile(join(layout.configDir, FIREWALL_V4_FILENAME)),
      Deno.errors.NotFound,
    );
  });
});

test("applyRenderedFirewall: a v6 failure fails the reconcile, keeps v4 applied and pending under the guard, leaves the durable v6 document alone", async () => {
  await withTempLayout(async (layout) => {
    const rendered = renderFirewall({
      payload: payload(),
      sshPorts: [22],
      includeForward: { 4: false, 6: false },
    });
    // The v6 state the kernel already holds, from an earlier generation.
    await Deno.mkdir(layout.configDir, { recursive: true });
    await Deno.writeTextFile(
      join(layout.configDir, FIREWALL_V6_FILENAME),
      "previous v6 generation\n",
    );
    const host = fakeHost({
      "ip6tables-restore --noflush --test": fail(
        "ip6tables-restore: line 4 failed",
      ),
    });
    const err = await assertRejects(
      () =>
        applyRenderedFirewall(
          rendered,
          { 4: false, 6: false },
          NFT_PROBE,
          { run: host.run, layout },
        ),
      FirewallIpv6ApplyError,
    );
    assertStringIncludes(err.message, "IPv4 is applied");
    assertStringIncludes(err.message, "line 4 failed");
    // v4 went in and is pending: the guard stays armed (it is the net under
    // a half-applied state), and a confirm would leave durable v6 alone.
    assert(host.calls.some((c) => c.cmd === "iptables-restore"));
    assertEquals(
      await Deno.readTextFile(
        join(layout.configDir, FIREWALL_PENDING_V4_FILENAME),
      ),
      rendered.v4,
    );
    assertEquals((await readPendingMarker(layout))?.v6, "keep");
    assert(
      !host.calls.some((c) => c.cmd === "systemctl" && c.args[0] === "stop"),
      "the guard is not disarmed after v4 went in",
    );
    // v6 was never applied, and its durable document still matches the kernel.
    assert(
      !host.calls.some((c) =>
        c.cmd === "ip6tables-restore" && !c.args.includes("--test")
      ),
    );
    assertEquals(
      await Deno.readTextFile(join(layout.configDir, FIREWALL_V6_FILENAME)),
      "previous v6 generation\n",
    );
  });
});

test("applyRenderedFirewall: no ip6tables → v6 left alone with a warning", async () => {
  await withTempLayout(async (layout) => {
    const rendered = renderFirewall({
      payload: payload(),
      sshPorts: [22],
      includeForward: { 4: true, 6: false },
    });
    const host = fakeHost();
    const outcome = await applyRenderedFirewall(
      rendered,
      { 4: true, 6: false },
      { ...NFT_PROBE, ipv6: false },
      { run: host.run, layout },
    );
    assertEquals(outcome.ipv6Applied, false);
    assertStringIncludes(outcome.warnings[0]!, "ip6tables is not available");
    assert(!host.calls.some((c) => c.cmd.startsWith("ip6tables")));
    assertEquals((await readPendingMarker(layout))?.v6, "forget");
  });
});

test("removeFirewall takes every jump, flushes and deletes both chains in both families, forgets the documents, pending state and guard", async () => {
  await withTempLayout(async (layout) => {
    await Deno.mkdir(layout.configDir, { recursive: true });
    await Deno.mkdir(layout.runDir, { recursive: true });
    await Deno.mkdir(layout.stateDir, { recursive: true });
    await Deno.writeTextFile(join(layout.configDir, FIREWALL_V4_FILENAME), "x");
    await Deno.writeTextFile(join(layout.configDir, FIREWALL_V6_FILENAME), "y");
    await Deno.writeTextFile(
      join(layout.configDir, FIREWALL_PENDING_V4_FILENAME),
      "p",
    );
    await Deno.writeTextFile(pendingMarkerPath(layout), "{}");
    await Deno.writeTextFile(rollbackRecordPath(layout), "{}");
    // the INPUT jump was doubled by some older tool; the second -D succeeds, the third says gone
    let inputDeletes = 0;
    const host = fakeHost();
    const run: FirewallRunFn = (cmd, args, options) => {
      if (cmd === "iptables" && args[0] === "-D" && args[1] === "INPUT") {
        inputDeletes += 1;
        return Promise.resolve(
          inputDeletes <= 2 ? ok() : fail(
            "iptables: Bad rule (does a matching rule exist in that chain?).",
          ),
        );
      }
      if (args[0] === "-D") {
        return Promise.resolve(fail("No chain/target/match by that name."));
      }
      return host.run(cmd, args, options);
    };
    await removeFirewall({ run, layout });
    assertEquals(inputDeletes, 3);
    const flushes = host.calls.filter((c) =>
      c.args[0] === "-F" || c.args[0] === "-X"
    );
    assertEquals(flushes.length, 8, "-F and -X for two chains in two families");
    await assertRejects(
      () => Deno.readTextFile(join(layout.configDir, FIREWALL_V4_FILENAME)),
      Deno.errors.NotFound,
    );
    await assertRejects(
      () => Deno.readTextFile(join(layout.configDir, FIREWALL_V6_FILENAME)),
      Deno.errors.NotFound,
    );
    for (
      const path of [
        join(layout.configDir, FIREWALL_PENDING_V4_FILENAME),
        pendingMarkerPath(layout),
        rollbackRecordPath(layout),
      ]
    ) {
      await assertRejects(() => Deno.readTextFile(path), Deno.errors.NotFound);
    }
    assert(
      host.calls.some((c) =>
        c.cmd === "systemctl" && c.args.join(" ") ===
          `stop ${FIREWALL_GUARD_TIMER}`
      ),
      "the guard timer is stopped",
    );
  });
});

test("removeFirewall runs the host commands strictly one at a time, in a fixed order", async () => {
  await withTempLayout(async (layout) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const seen: string[] = [];
    const run: FirewallRunFn = async (cmd, args) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      seen.push(`${cmd} ${args.join(" ")}`);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight--;
      return args[0] === "-D"
        ? fail(
          "iptables: Bad rule (does a matching rule exist in that chain?).",
        )
        : ok();
    };
    await removeFirewall({ run, layout });
    assertEquals(maxInFlight, 1);
    const perFamily = (bin: string) => [
      `${bin} -D INPUT -j TP-INPUT`,
      `${bin} -D DOCKER-USER -j TP-FWD`,
      `${bin} -F TP-INPUT`,
      `${bin} -X TP-INPUT`,
      `${bin} -F TP-FWD`,
      `${bin} -X TP-FWD`,
    ];
    assertEquals(seen, [
      ...perFamily("iptables"),
      ...perFamily("ip6tables"),
      `systemctl stop ${FIREWALL_GUARD_TIMER}`,
    ]);
  });
});

test("removeFirewall stops at the first host command that throws and touches nothing after it", async () => {
  await withTempLayout(async (layout) => {
    const seen: string[] = [];
    const run: FirewallRunFn = (cmd, args) => {
      seen.push(`${cmd} ${args.join(" ")}`);
      return seen.length === 4
        ? Promise.reject(new Error("host went away"))
        : Promise.resolve(ok());
    };
    await assertRejects(
      () => removeFirewall({ run, layout }),
      Error,
      "host went away",
    );
    assertEquals(seen.length, 4);
  });
});

test("snapshotFirewallChains keeps only the TP- lines of iptables-save", async () => {
  const host = fakeHost({
    "iptables-save -t filter": ok([
      "*filter",
      ":INPUT ACCEPT [0:0]",
      ":DOCKER-USER - [0:0]",
      ":TP-INPUT - [0:0]",
      "-A INPUT -j TP-INPUT",
      "-A DOCKER-USER -j RETURN",
      "-A TP-INPUT -i lo -j ACCEPT",
      "COMMIT",
    ].join("\n")),
  });
  assertEquals(
    await snapshotFirewallChains(4, host.run),
    ":TP-INPUT - [0:0]\n-A INPUT -j TP-INPUT\n-A TP-INPUT -i lo -j ACCEPT",
  );
  const broken = fakeHost({ "iptables-save -t filter": fail("boom") });
  assertEquals(await snapshotFirewallChains(4, broken.run), null);
});

test("reinstallFirewallForwardingIfEnabled: no document → nothing; document with TP-FWD and DOCKER-USER present → restore + jump", async () => {
  await withTempLayout(async (layout) => {
    const idle = fakeHost();
    await reinstallFirewallForwardingIfEnabled({ run: idle.run, layout });
    assertEquals(idle.calls, []);

    const rendered = renderFirewall({
      payload: payload(),
      sshPorts: [22],
      includeForward: { 4: true, 6: false },
    });
    await Deno.mkdir(layout.configDir, { recursive: true });
    await Deno.writeTextFile(
      join(layout.configDir, FIREWALL_V4_FILENAME),
      rendered.v4,
    );
    const host = fakeHost({
      "iptables -C DOCKER-USER -j TP-FWD": fail("Bad rule"),
    });
    await reinstallFirewallForwardingIfEnabled({ run: host.run, layout });
    assertEquals(host.calls.map((c) => `${c.cmd} ${c.args.join(" ")}`), [
      "iptables -S DOCKER-USER",
      "iptables-restore --noflush --test",
      "iptables-restore --noflush",
      "iptables -C DOCKER-USER -j TP-FWD",
      "iptables -I DOCKER-USER 1 -j TP-FWD",
    ]);

    // dockerd not back yet: probe only, nothing applied
    const noDocker = fakeHost({ "iptables -S DOCKER-USER": fail("No chain") });
    await reinstallFirewallForwardingIfEnabled({ run: noDocker.run, layout });
    assertEquals(noDocker.calls.length, 1);
  });
});

test("reinstallFirewallForwardingIfEnabled: while a ruleset is pending it re-applies the PENDING document, never the older confirmed one", async () => {
  await withTempLayout(async (layout) => {
    const confirmed = renderFirewall({
      payload: payload({
        rules: [{
          id: "old",
          scope: "published",
          action: "drop",
          proto: "tcp",
          ports: "1111",
          sources: ["any"],
          origin: "user",
        }],
      }),
      sshPorts: [22],
      includeForward: { 4: true, 6: false },
    });
    const pending = renderFirewall({
      payload: payload({
        rules: [{
          id: "new",
          scope: "published",
          action: "drop",
          proto: "tcp",
          ports: "2222",
          sources: ["any"],
          origin: "user",
        }],
      }),
      sshPorts: [22],
      includeForward: { 4: true, 6: false },
    });
    await Deno.mkdir(layout.configDir, { recursive: true });
    await Deno.mkdir(layout.runDir, { recursive: true });
    await Deno.writeTextFile(
      join(layout.configDir, FIREWALL_V4_FILENAME),
      confirmed.v4,
    );
    await Deno.writeTextFile(
      join(layout.configDir, FIREWALL_PENDING_V4_FILENAME),
      pending.v4,
    );
    await Deno.writeTextFile(
      pendingMarkerPath(layout),
      JSON.stringify({
        version: 1,
        digest: pending.digest,
        generation: 9,
        armedAt: "2026-10-01T12:00:00.000Z",
        deadlineAt: "2026-10-01T12:02:00.000Z",
        windowSeconds: 120,
        v6: "keep",
      }),
    );
    const host = fakeHost({
      "iptables -C DOCKER-USER -j TP-FWD": fail("Bad rule"),
    });
    await reinstallFirewallForwardingIfEnabled({ run: host.run, layout });
    const restores = host.calls.filter((c) =>
      c.cmd === "iptables-restore" && !c.args.includes("--test")
    );
    assertEquals(restores.length, 1);
    assertEquals(restores[0]!.stdin, pending.v4);

    // Once the marker is gone (confirmed or rolled back) the durable document
    // is the truth again.
    await Deno.remove(pendingMarkerPath(layout));
    const after = fakeHost();
    await reinstallFirewallForwardingIfEnabled({ run: after.run, layout });
    const durable = after.calls.filter((c) =>
      c.cmd === "iptables-restore" && !c.args.includes("--test")
    );
    assertEquals(durable[0]!.stdin, confirmed.v4);
  });
});

test("reinstallFirewallForwardingIfEnabled: a pending marker with no pending document does nothing and never throws", async () => {
  await withTempLayout(async (layout) => {
    await Deno.mkdir(layout.runDir, { recursive: true });
    await Deno.writeTextFile(
      pendingMarkerPath(layout),
      JSON.stringify({
        version: 1,
        digest: "d".repeat(64),
        generation: 1,
        armedAt: "2026-10-01T12:00:00.000Z",
        deadlineAt: "2026-10-01T12:02:00.000Z",
        windowSeconds: 120,
        v6: "keep",
      }),
    );
    const host = fakeHost();
    await reinstallFirewallForwardingIfEnabled({ run: host.run, layout });
    assertEquals(host.calls, []);
  });
});

test("parseSshdEffectivePorts reads port and pinned listenaddress lines", () => {
  const output = [
    "port 22",
    "port 2222",
    "addressfamily any",
    "listenaddress [::1]:2200",
    "listenaddress 0.0.0.0:2222",
    "listenaddress 10.0.0.1",
    "permitrootlogin no",
  ].join("\n");
  assertEquals(parseSshdEffectivePorts(output), [22, 2200, 2222]);
  assertEquals(parseSshdEffectivePorts(""), []);
});

test("readSshdEffectivePorts fails open with a warning", async () => {
  const good = fakeHost({ "sshd -T": ok("port 2022\nx11forwarding no") });
  assertEquals(await readSshdEffectivePorts(good.run), { ports: [2022] });
  const broken = fakeHost({
    "sshd -T": fail("sshd: no hostkeys available -- exiting."),
  });
  const result = await readSshdEffectivePorts(broken.run);
  assertEquals(result.ports, []);
  assertStringIncludes(result.warning!, "sshd -T failed");
  const empty = fakeHost({ "sshd -T": ok("x11forwarding no") });
  assertStringIncludes(
    (await readSshdEffectivePorts(empty.run)).warning!,
    "no port line",
  );
});
