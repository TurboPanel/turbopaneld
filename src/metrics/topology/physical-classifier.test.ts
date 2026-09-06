import { assertEquals } from "@std/assert";
import { fromFileUrl } from "@std/path";
import { defaultSensorIo } from "../collector/sensors/discovery.ts";
import { collectGpuTopology } from "./gpu-topology.ts";
import { isPhysicalMachine } from "./physical-classifier.ts";

const test = Deno.test.bind(Deno);

function fixtureRoot(name: string): string {
  return fromFileUrl(new URL(`./testdata/${name}`, import.meta.url));
}

test("isPhysicalMachine: bare-metal-shaped DMI vendor reads true", async () => {
  const result = await isPhysicalMachine({
    readFile: defaultSensorIo().readFile,
    sysRoot: fixtureRoot("physical-bare-metal"),
  });
  assertEquals(result, true);
});

test("isPhysicalMachine: a common hypervisor DMI vendor string reads false", async () => {
  const result = await isPhysicalMachine({
    readFile: defaultSensorIo().readFile,
    sysRoot: fixtureRoot("physical-vm-qemu"),
  });
  assertEquals(result, false);
});

test("isPhysicalMachine: /sys/hypervisor/type presence reads false even with a bare-metal-shaped vendor string", async () => {
  const result = await isPhysicalMachine({
    readFile: defaultSensorIo().readFile,
    sysRoot: fixtureRoot("physical-vm-hypervisor-flag"),
  });
  assertEquals(result, false);
});

test("GPU topology enumeration never consults the physical classifier — no shared dependency", async () => {
  let classifierCalled = false;
  const io = defaultSensorIo();
  const spyingIo = {
    listDir: io.listDir,
    readFile: (path: string) => {
      if (
        path.includes("dmi/id/sys_vendor") || path.includes("hypervisor/type")
      ) {
        classifierCalled = true;
      }
      return io.readFile(path);
    },
  };
  await collectGpuTopology({
    io: spyingIo,
    sysRoot: fixtureRoot("physical-bare-metal"),
  });
  assertEquals(classifierCalled, false);
});
