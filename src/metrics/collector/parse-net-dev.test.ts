import { assertEquals } from "@std/assert";
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
  assertEquals(isExcludedNetInterface("virbr0"), true);
  assertEquals(isExcludedNetInterface("vnet0"), true);
  assertEquals(isExcludedNetInterface("tap0"), true);
  assertEquals(isExcludedNetInterface("tun0"), true);
  assertEquals(isExcludedNetInterface("eth0"), false);
});

it("parseNetDev drops remaining virtual prefixes", () => {
  const row = (name: string, rx: number, tx: number) =>
    `  ${name}: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0`;
  const net = parseNetDev(
    [
      row("virbr0", 1, 1),
      row("vnet0", 1, 1),
      row("tap0", 1, 1),
      row("tun0", 1, 1),
      row("eth0", 10, 20),
    ].join("\n"),
  );
  if (!net) throw new TypeError("expected eth0 after virtual filters");
  assertEquals(Object.keys(net.interfaces), ["eth0"]);
  assertEquals(net.interfaces.eth0, { receiveBytes: 10, transmitBytes: 20 });
});

it("parseNetDev returns null for empty, short, or non-finite rows", () => {
  assertEquals(parseNetDev(""), null);
  assertEquals(parseNetDev("Inter-| Receive\n"), null);
  assertEquals(
    parseNetDev("  eth0: 5000000 1000\n"),
    null,
  );
  assertEquals(
    parseNetDev(
      "  eth0: NaN 1000 0 0 0 0 0 0 3000000 2000 0 0 0 0 0 0\n",
    ),
    null,
  );
});
