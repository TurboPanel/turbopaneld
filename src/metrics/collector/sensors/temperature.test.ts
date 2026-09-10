import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import type { SensorCandidate } from "../types.ts";
import { readTemperatureValue, resolveTemperature } from "./temperature.ts";

const CANDIDATE: SensorCandidate = {
  chip: "coretemp",
  label: "Package id 0",
  path: "/sys/class/hwmon/hwmon0/temp1_input",
};

function io(raw: string | undefined) {
  return {
    listDir: () => [],
    readFile: () => raw,
  };
}

it("readTemperatureValue returns null for a missing or non-numeric sysfs value", async () => {
  assertEquals(await readTemperatureValue(CANDIDATE.path, io(undefined)), null);
  assertEquals(await readTemperatureValue(CANDIDATE.path, io("nope")), null);
});

it("readTemperatureValue returns null for a reading outside the plausible window", async () => {
  assertEquals(await readTemperatureValue(CANDIDATE.path, io("200000")), null);
  assertEquals(await readTemperatureValue(CANDIDATE.path, io("-70000")), null);
});

it("resolveTemperature keeps the sensor identity when the selected candidate is unreadable", async () => {
  const resolved = await resolveTemperature([CANDIDATE], undefined, io("nope"));
  assertEquals(resolved, {
    celsius: null,
    sensor: "coretemp:Package id 0",
  });
});

it("resolveTemperature converts millidegrees when the candidate is readable", async () => {
  const resolved = await resolveTemperature(
    [CANDIDATE],
    undefined,
    io("45000"),
  );
  assertEquals(resolved, {
    celsius: 45,
    sensor: "coretemp:Package id 0",
  });
});
