/**
 * Host-free coverage for Deno interface address classification.
 */

import { assertEquals } from "@std/assert";
import {
  collectServerIps,
  readDefaultRouteInterfaces,
} from "./server-addresses.ts";

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

test("collectServerIps classifies RFC1918 IPv4 ranges and skips unusable IPv4", () => {
  withNetworkInterfaces(
    [
      { name: "eth0", family: "IPv4", address: "172.16.0.1" },
      { name: "eth0", family: "IPv4", address: "172.31.255.1" },
      { name: "eth0", family: "IPv4", address: "0.1.2.3" },
      { name: "eth0", family: "IPv4", address: "127.1.2.3" },
      { name: "eth0", family: "IPv4", address: "169.254.10.1" },
      { name: "eth0", family: "IPv4", address: "224.0.0.1" },
      { name: "eth0", family: "IPv4", address: "255.255.255.255" },
      { name: "eth0", family: "IPv4", address: "10.0.0.256" },
      { name: "eth0", family: "IPv4", address: "10.0.0" },
      { name: "eth0", family: "IPv4", address: "10.a.0.1" },
      { name: "eth0", family: "IPv4", address: "198.51.100.8" },
    ],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: "172.16.0.1",
          version: 4,
          scope: "private",
          interface: "eth0",
        },
        {
          address: "172.31.255.1",
          version: 4,
          scope: "private",
          interface: "eth0",
        },
        {
          address: "198.51.100.8",
          version: 4,
          scope: "public",
          interface: "eth0",
        },
      ]);
    },
  );
});

test("collectServerIps classifies IPv6 ULA / global unicast and skips unusable IPv6", () => {
  withNetworkInterfaces(
    [
      { name: "eth0", family: "IPv6", address: "fd12:3456:789a:1::1" },
      { name: "eth0", family: "IPv6", address: "FC00::1" },
      { name: "eth0", family: "IPv6", address: "2001:db8::1" },
      { name: "eth0", family: "IPv6", address: "3ffe::1" },
      { name: "eth0", family: "IPv6", address: "2001:db8::2%eth0" },
      { name: "eth0", family: "IPv6", address: "::1" },
      { name: "eth0", family: "IPv6", address: "0:0:0:0:0:0:0:1" },
      { name: "eth0", family: "IPv6", address: "fe80::1" },
      { name: "eth0", family: "IPv6", address: "ff02::1" },
      { name: "eth0", family: "IPv6", address: "::" },
    ],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: "2001:db8::1",
          version: 6,
          scope: "public",
          interface: "eth0",
        },
        {
          address: "2001:db8::2%eth0",
          version: 6,
          scope: "public",
          interface: "eth0",
        },
        {
          address: "3ffe::1",
          version: 6,
          scope: "public",
          interface: "eth0",
        },
        {
          address: "FC00::1",
          version: 6,
          scope: "private",
          interface: "eth0",
        },
        {
          address: "fd12:3456:789a:1::1",
          version: 6,
          scope: "private",
          interface: "eth0",
        },
      ]);
    },
  );
});

test("collectServerIps skips virtual interface names", () => {
  const virtual = [
    "lo",
    "docker",
    "docker1",
    "br-abc123",
    "veth0",
    "virbr0",
    "tun0",
    "tap0",
    "wg0",
    "cni0",
    "flannel.1",
    "cali1234",
    "kube-ipvs0",
    "tailscale0",
    "ifb0",
    "dummy0",
  ];
  withNetworkInterfaces(
    [
      ...virtual.map((name) => ({
        name,
        family: "IPv4" as const,
        address: "10.0.0.5",
      })),
      { name: "enp1s0", family: "IPv4", address: "10.1.2.3" },
    ],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: "10.1.2.3",
          version: 4,
          scope: "private",
          interface: "enp1s0",
        },
      ]);
    },
  );
});

test("collectServerIps derives prefix from netmask and ignores invalid CIDR/netmask", () => {
  withNetworkInterfaces(
    [
      {
        name: "eth0",
        family: "IPv4",
        address: "10.2.0.1",
        netmask: "255.255.0.0",
      },
      {
        name: "eth0",
        family: "IPv4",
        address: "10.3.0.1",
        netmask: "255.255.255.128",
      },
      {
        name: "eth0",
        family: "IPv4",
        address: "10.4.0.1",
        netmask: "255.255.0.255",
      },
      {
        name: "eth0",
        family: "IPv4",
        address: "10.5.0.1",
        netmask: "not-a-mask",
      },
      {
        name: "eth0",
        family: "IPv4",
        address: "10.6.0.1",
        cidr: "10.6.0.1/33",
      },
      {
        name: "eth0",
        family: "IPv4",
        address: "10.7.0.1",
        cidr: "10.7.0.1/abc",
      },
      {
        name: "eth0",
        family: "IPv4",
        address: "10.8.0.1",
        cidr: "10.8.0.1",
      },
      {
        name: "eth0",
        family: "IPv6",
        address: "2001:db8::10",
        cidr: "2001:db8::10/64",
      },
      {
        name: "eth0",
        family: "IPv6",
        address: "2001:db8::11",
        cidr: "2001:db8::11/129",
      },
    ],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: "10.2.0.1",
          version: 4,
          scope: "private",
          cidr: "10.2.0.1/16",
          interface: "eth0",
        },
        {
          address: "10.3.0.1",
          version: 4,
          scope: "private",
          cidr: "10.3.0.1/25",
          interface: "eth0",
        },
        {
          address: "10.4.0.1",
          version: 4,
          scope: "private",
          interface: "eth0",
        },
        {
          address: "10.5.0.1",
          version: 4,
          scope: "private",
          interface: "eth0",
        },
        {
          address: "10.6.0.1",
          version: 4,
          scope: "private",
          interface: "eth0",
        },
        {
          address: "10.7.0.1",
          version: 4,
          scope: "private",
          interface: "eth0",
        },
        {
          address: "10.8.0.1",
          version: 4,
          scope: "private",
          interface: "eth0",
        },
        {
          address: "2001:db8::10",
          version: 6,
          scope: "public",
          cidr: "2001:db8::10/64",
          interface: "eth0",
        },
        {
          address: "2001:db8::11",
          version: 6,
          scope: "public",
          interface: "eth0",
        },
      ]);
    },
  );
});

test("collectServerIps prefers a later CIDR and omits empty or overlong interface names", () => {
  const longName = "n".repeat(65);
  const maxName = "n".repeat(64);
  withNetworkInterfaces(
    [
      { name: "eth0", family: "IPv4", address: "10.9.0.1" },
      {
        name: "eth0",
        family: "IPv4",
        address: "10.9.0.1",
        cidr: "10.9.0.1/24",
      },
      {
        name: "eth1",
        family: "IPv4",
        address: "10.10.0.1",
        cidr: "10.10.0.1/24",
      },
      { name: "eth1", family: "IPv4", address: "10.10.0.1" },
      { name: "   ", family: "IPv4", address: "10.11.0.1" },
      { name: longName, family: "IPv4", address: "10.12.0.1" },
      { name: maxName, family: "IPv4", address: "10.13.0.1" },
    ],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: "10.10.0.1",
          version: 4,
          scope: "private",
          cidr: "10.10.0.1/24",
          interface: "eth1",
        },
        {
          address: "10.11.0.1",
          version: 4,
          scope: "private",
        },
        {
          address: "10.12.0.1",
          version: 4,
          scope: "private",
        },
        {
          address: "10.13.0.1",
          version: 4,
          scope: "private",
          interface: maxName,
        },
        {
          address: "10.9.0.1",
          version: 4,
          scope: "private",
          cidr: "10.9.0.1/24",
          interface: "eth0",
        },
      ]);
    },
  );
});

/**
 * `/proc/net/route`, tab-separated with a header row. Destination and mask are
 * little-endian hex; `00000000` for both marks the default route.
 */
const PROC_NET_ROUTE = [
  "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\t\tMTU\tWindow\tIRTT",
  "eth1\t00000000\t0102A8C0\t0003\t0\t0\t600\t00000000\t0\t0\t0",
  "eth0\t00000000\t0101A8C0\t0003\t0\t0\t100\t00000000\t0\t0\t0",
  "eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF\t0\t0\t0",
  "",
].join("\n");

const PROC_NET_IPV6_ROUTE = [
  "fe800000000000000000000000000000 40 00000000000000000000000000000000 00 00000000000000000000000000000000 00000100 00000003 00000000 00000001       eth0",
  "00000000000000000000000000000000 00 00000000000000000000000000000000 00 fe800000000000000000000000000001 00000400 00000001 00000000 00000003       eth0",
  "",
].join("\n");

function withProcRoutes(
  files: Record<string, string>,
  fn: () => void,
): void {
  const original = Deno.readTextFileSync;
  // deno-lint-ignore no-explicit-any
  (Deno as any).readTextFileSync = (path: string | URL) => {
    const key = String(path);
    if (key in files) return files[key];
    throw new Deno.errors.NotFound(key);
  };
  try {
    fn();
  } finally {
    // deno-lint-ignore no-explicit-any
    (Deno as any).readTextFileSync = original;
  }
}

test("readDefaultRouteInterfaces picks the lowest-metric default route", () => {
  withProcRoutes(
    {
      "/proc/net/route": PROC_NET_ROUTE,
      "/proc/net/ipv6_route": PROC_NET_IPV6_ROUTE,
    },
    () => {
      assertEquals(readDefaultRouteInterfaces(), { v4: "eth0", v6: "eth0" });
    },
  );
});

test("readDefaultRouteInterfaces is empty when /proc is unreadable", () => {
  withProcRoutes({}, () => {
    assertEquals(readDefaultRouteInterfaces(), {});
  });
});

test("readDefaultRouteInterfaces ignores non-default and malformed rows", () => {
  withProcRoutes(
    {
      "/proc/net/route": [
        "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask",
        // On-link subnet route, not a default route.
        "eth0\t0001A8C0\t00000000\t0001\t0\t0\t100\t00FFFFFF",
        // Zero destination but a non-zero mask.
        "eth9\t00000000\t00000000\t0001\t0\t0\t1\t000000FF",
        "truncated",
        "",
      ].join("\n"),
    },
    () => {
      assertEquals(readDefaultRouteInterfaces(), {});
    },
  );
});

test("collectServerIps marks the default-route interface as preferred", () => {
  withNetworkInterfaces(
    [
      { name: "eth1", family: "IPv4", address: "10.20.0.7" },
      { name: "eth0", family: "IPv4", address: "192.168.1.50" },
    ],
    () => {
      assertEquals(collectServerIps({ v4: "eth0" }), [
        {
          address: "10.20.0.7",
          version: 4,
          scope: "private",
          interface: "eth1",
        },
        {
          address: "192.168.1.50",
          version: 4,
          scope: "private",
          interface: "eth0",
          preferred: true,
        },
      ]);
    },
  );
});

test("collectServerIps without a route table marks nothing", () => {
  withNetworkInterfaces(
    [{ name: "eth0", family: "IPv4", address: "192.168.1.50" }],
    () => {
      assertEquals(collectServerIps(), [
        {
          address: "192.168.1.50",
          version: 4,
          scope: "private",
          interface: "eth0",
        },
      ]);
    },
  );
});
