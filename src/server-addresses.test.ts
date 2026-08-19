/**
 * Host-free coverage for Deno interface address classification.
 */

import { assertEquals } from "@std/assert";
import { collectServerIps } from "./server-addresses.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type FakeIface = {
  name: string;
  family: "IPv4" | "IPv6";
  address: string;
  cidr?: string;
  netmask?: string;
};

function withNetworkInterfaces(
  ifaces: FakeIface[],
  fn: () => void,
): void {
  const original = Deno.networkInterfaces;
  // deno-lint-ignore no-explicit-any
  (Deno as any).networkInterfaces = () => ifaces;
  try {
    fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).networkInterfaces = original;
  }
}

test("collectServerIps classifies private/public IPv4 and skips virtual NICS", () => {
  withNetworkInterfaces(
    [
      { name: "lo", family: "IPv4", address: "127.0.0.1" },
      { name: "docker0", family: "IPv4", address: "172.17.0.1" },
      { name: "eth0", family: "IPv4", address: "10.0.0.5" },
      { name: "eth0", family: "IPv4", address: "203.0.113.9" },
    ],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: "10.0.0.5",
          version: 4,
          scope: "private",
          interface: "eth0",
        },
        {
          address: "203.0.113.9",
          version: 4,
          scope: "public",
          interface: "eth0",
        },
      ]);
    },
  );
});

test("collectServerIps records the interface CIDR when known", () => {
  withNetworkInterfaces(
    [
      {
        name: "eth0",
        family: "IPv4",
        address: "10.0.0.5",
        cidr: "10.0.0.5/24",
      },
      {
        name: "eth0",
        family: "IPv4",
        address: "192.168.1.10",
        netmask: "255.255.255.0",
      },
      {
        name: "eth0",
        family: "IPv4",
        address: "203.0.113.9",
        cidr: "203.0.113.9/24",
      },
    ],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: "10.0.0.5",
          version: 4,
          scope: "private",
          cidr: "10.0.0.5/24",
          interface: "eth0",
        },
        {
          address: "192.168.1.10",
          version: 4,
          scope: "private",
          cidr: "192.168.1.10/24",
          interface: "eth0",
        },
        {
          address: "203.0.113.9",
          version: 4,
          scope: "public",
          cidr: "203.0.113.9/24",
          interface: "eth0",
        },
      ]);
    },
  );
});
