import { assertEquals } from "jsr:@std/assert";
import { isExcludedNetInterface, parseNetDev } from "./parse-net-dev.ts";
import { it } from "@std/testing/bdd";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("parseNetDev excludes loopback and virtual interfaces", () => {
  const net = parseNetDev(fixture("proc-net-dev.txt"));
  assertEquals(net !== null, true);
  assertEquals(
    Object.keys(net!.interfaces).sort((a, b) => a.localeCompare(b)),
    ["eth0", "wlan0"],
  );
  assertEquals(net!.interfaces.eth0, {
    receiveBytes: 5_000_000,
    transmitBytes: 3_000_000,
  });
  assertEquals(net!.interfaces.wlan0, {
    receiveBytes: 2_000_000,
    transmitBytes: 1_500_000,
  });
});

it("isExcludedNetInterface covers lo and container prefixes", () => {
  assertEquals(isExcludedNetInterface("lo"), true);
  assertEquals(isExcludedNetInterface("veth123"), true);
  assertEquals(isExcludedNetInterface("docker0"), true);
  assertEquals(isExcludedNetInterface("br-abc"), true);
  assertEquals(isExcludedNetInterface("eth0"), false);
});
