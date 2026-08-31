import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  parseSensorOverrides,
  resolveAdminSensorOverrides,
  sensorOverridesPath,
} from "./overrides.ts";

it("parseSensorOverrides keeps only non-empty string path fields", () => {
  assertEquals(
    parseSensorOverrides(JSON.stringify({
      cpuTemperature: "/sys/class/hwmon/hwmon0/temp1_input",
      gpuTemperature: "",
      cpuPower: 42,
      unknownField: "/x",
    })),
    { cpuTemperature: "/sys/class/hwmon/hwmon0/temp1_input" },
  );
  assertEquals(parseSensorOverrides("not json"), {});
  assertEquals(parseSensorOverrides("[1,2]"), {});
  assertEquals(parseSensorOverrides("null"), {});
});

it("resolveAdminSensorOverrides reads the state file and defaults to empty", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await resolveAdminSensorOverrides(tempDir), {});

    const path = sensorOverridesPath(tempDir);
    await Deno.mkdir(join(tempDir, "metrics"), { recursive: true });
    await Deno.writeTextFile(
      path,
      JSON.stringify({ gpuPower: "/sys/class/hwmon/hwmon1/power1_average" }),
    );
    assertEquals(await resolveAdminSensorOverrides(tempDir), {
      gpuPower: "/sys/class/hwmon/hwmon1/power1_average",
    });

    await Deno.writeTextFile(path, "{broken");
    assertEquals(await resolveAdminSensorOverrides(tempDir), {});
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
