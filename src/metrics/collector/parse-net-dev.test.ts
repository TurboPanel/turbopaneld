import { assertEquals } from "@std/assert";
import { parseNetDev } from "./parse-net-dev.ts";
import { it } from "@std/testing/bdd";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("parseNetDev returns every interface, virtual and loopback included", () => {
  const net = parseNetDev(fixture("proc-net-dev.txt"));
  assertEquals(net !== null, true);
  assertEquals(
    Object.keys(net!).sort((a, b) => a.localeCompare(b)),
    ["docker0", "eth0", "lo", "veth123", "wlan0"],
  );
  assertEquals(net!.eth0, {
    receiveBytes: 5_000_000,
    transmitBytes: 3_000_000,
  });
  assertEquals(net!.docker0, {
    receiveBytes: 7_777_777,
    transmitBytes: 6_666_666,
  });
  assertEquals(net!.lo, {
    receiveBytes: 1_000_000,
    transmitBytes: 1_000_000,
  });
});

it("parseNetDev parses the fabric-tunnel fixture without excluding anything", () => {
  const net = parseNetDev(fixture("proc-net-dev-with-fabric-tunnel.txt"));
  assertEquals(
    Object.keys(net!).sort((a, b) => a.localeCompare(b)),
    ["docker0", "eth0", "lo", "tp0", "veth123"],
  );
  assertEquals(net!.tp0, { receiveBytes: 400_000, transmitBytes: 300_000 });
});

it("parseNetDev returns null for empty, short, or non-finite rows", () => {
  assertEquals(parseNetDev(""), null);
  assertEquals(parseNetDev("Inter-| Receive\n"), null);
  assertEquals(parseNetDev("  eth0: 5000000 1000\n"), null);
  assertEquals(
    parseNetDev(
      "  eth0: NaN 1000 0 0 0 0 0 0 3000000 2000 0 0 0 0 0 0\n",
    ),
    null,
  );
});
