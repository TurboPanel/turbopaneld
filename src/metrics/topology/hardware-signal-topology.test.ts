import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import {
  collectHardwareSignals,
  CPU_HOTTEST_CORE_SIGNAL_ID,
  CPU_THERMAL_THROTTLED_SIGNAL_ID,
} from "./hardware-signal-topology.ts";

const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

test("collectHardwareSignals maps hwmon/RAPL candidates into stable signal identities", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-basic"),
  });

  assertEquals(signals.length, 2);

  const temp = signals.find((s) => s.kind === "temperature");
  assertEquals(temp?.signalId, "signal:coretemp:Package id 0");
  assertEquals(temp?.unit, "celsius");
  assertEquals(temp?.component, "cpu");
  assertEquals(temp?.label, "Package id 0");
  // hwmon's sibling tempN_max/tempN_crit files, converted to celsius same as the reading.
  assertEquals(temp?.thresholds, { warning: 90, critical: 100 });

  const power = signals.find((s) => s.kind === "power");
  assertEquals(power?.signalId, "signal:intel-rapl:package-0");
  assertEquals(power?.unit, "watts");
  assertEquals(power?.component, "cpu");
  // RAPL energy counters expose no threshold files.
  assertEquals(power?.thresholds, undefined);
});

test("collectHardwareSignals yields nothing on a sensorless host", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fromFileUrl(
      new URL(`../collector/testdata/sensors-none`, import.meta.url),
    ),
  });
  assertEquals(signals, []);
});

test("collectHardwareSignals: the full conservative catalog — fan-free, GPU-free, only trustworthy board labels, both synthetic CPU signals present", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-full"),
  });

  // 1 CPU package temp + 1 disk temp + 2 trusted board temps (SYSTIN,
  // PCH_CHIP_TEMP — AUXTIN is dropped) + 1 CPU power + hottest-core +
  // thermal-throttled. No fan, no GPU temp/power.
  assertEquals(signals.length, 7);
  assertEquals(signals.some((s) => s.kind === "fan"), false);
  assertEquals(signals.some((s) => s.component === "gpu"), false);
  assertEquals(signals.some((s) => s.label === "AUXTIN"), false);

  const packageTemp = signals.find((s) =>
    s.signalId === "signal:coretemp:Package id 0"
  );
  assertEquals(packageTemp?.component, "cpu");
  assertEquals(packageTemp?.thresholds, { warning: 90, critical: 100 });
  // Individual per-core entries (Core 0/Core 1) are not separate physical
  // signals — they only feed the hottest-core synthetic below.
  assertEquals(
    signals.some((s) => s.label === "Core 0" || s.label === "Core 1"),
    false,
  );

  const diskTemp = signals.find((s) => s.component === "disk");
  assertEquals(diskTemp?.label, "Composite");

  const boardLabels = signals.filter((s) => s.component === "board").map((
    s,
  ) => s.label).sort();
  assertEquals(boardLabels, ["PCH_CHIP_TEMP", "SYSTIN"]);

  const power = signals.find((s) => s.kind === "power");
  assertEquals(power?.component, "cpu");
  assertEquals(power?.signalId, "signal:intel-rapl:package-0");

  const hottestCore = signals.find((s) =>
    s.signalId === CPU_HOTTEST_CORE_SIGNAL_ID
  );
  assertEquals(hottestCore?.kind, "temperature");
  assertEquals(hottestCore?.component, "cpu");
  // Same threshold files as the package (coretemp is uniform per-package).
  assertEquals(hottestCore?.thresholds, { warning: 90, critical: 100 });

  const throttled = signals.find((s) =>
    s.signalId === CPU_THERMAL_THROTTLED_SIGNAL_ID
  );
  assertEquals(throttled?.kind, "percent");
  assertEquals(throttled?.component, "cpu");
});

test("collectHardwareSignals: no per-core candidates and no throttle file omits both synthetic entries (never fabricated identity)", async () => {
  const signals = await collectHardwareSignals({
    io: defaultSensorIo(),
    sysRoot: fixtureRoot("physical-signals-basic"),
  });
  assertEquals(
    signals.some((s) => s.signalId === CPU_HOTTEST_CORE_SIGNAL_ID),
    false,
  );
  assertEquals(
    signals.some((s) => s.signalId === CPU_THERMAL_THROTTLED_SIGNAL_ID),
    false,
  );
});
