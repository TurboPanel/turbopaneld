import { assertEquals } from "@std/assert";
import { parseNetDev, parseNetDevDetailedCounters } from "./parse-net-dev.ts";
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

it("parseNetDev skips header rows whose iface name contains a pipe", () => {
  assertEquals(
    parseNetDev("face|bytes: 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16\n"),
    null,
  );
  assertEquals(
    parseNetDev("  : 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16\n"),
    null,
  );
});

it("parseNetDevDetailedCounters parses rx/tx errors and drops", () => {
  const text = "  eth0: 100 1 2 3 0 0 0 0 200 4 5 6 0 0 0 0\n";
  assertEquals(parseNetDevDetailedCounters(text), {
    eth0: {
      rx: 100,
      tx: 200,
      rxErrors: 2,
      txErrors: 5,
      rxDropped: 3,
      txDropped: 6,
    },
  });
});

it("parseNetDevDetailedCounters skips header, short, and non-finite rows", () => {
  assertEquals(
    parseNetDevDetailedCounters("Inter-| Receive\n  eth0: 1 2 3\n"),
    {},
  );
  assertEquals(
    parseNetDevDetailedCounters(
      "  eth0: NaN 1 2 3 0 0 0 0 200 4 5 6 0 0 0 0\n",
    ),
    {},
  );
});
