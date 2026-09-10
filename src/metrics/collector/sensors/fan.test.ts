import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import type { SensorCandidate } from "../types.ts";
import { readFanValue, resolveFan } from "./fan.ts";

const CANDIDATE: SensorCandidate = {
  chip: "nct6798",
  label: "fan1",
  path: "/sys/class/hwmon/hwmon2/fan1_input",
};

function io(raw: string | undefined) {
  return {
    listDir: () => [],
    readFile: () => raw,
  };
}

it("readFanValue returns null for a missing or non-numeric sysfs value", async () => {
  assertEquals(await readFanValue(CANDIDATE.path, io(undefined)), null);
  assertEquals(await readFanValue(CANDIDATE.path, io("nope")), null);
});

it("readFanValue returns null for an RPM outside the plausible window", async () => {
  assertEquals(await readFanValue(CANDIDATE.path, io("25000")), null);
  assertEquals(await readFanValue(CANDIDATE.path, io("-1")), null);
});

it("resolveFan keeps the sensor identity when the selected candidate is unreadable", async () => {
  const resolved = await resolveFan([CANDIDATE], undefined, io("nope"));
  assertEquals(resolved, { rpm: null, sensor: "nct6798:fan1" });
});

it("resolveFan returns a plausible RPM", async () => {
  const resolved = await resolveFan([CANDIDATE], undefined, io("1200"));
  assertEquals(resolved, { rpm: 1200, sensor: "nct6798:fan1" });
});
