import { assertEquals } from "@std/assert";
import { fabricAllowedIpsPolicyError } from "./fabric-allowed-ips.ts";

const test = Deno.test.bind(Deno);

const SELF = { address: "10.250.0.11/32", prefix: "10.192.0.0/16" };

function check(...peers: string[][]): string | null {
  return fabricAllowedIpsPolicyError({
    ...SELF,
    peers: peers.map((allowedIPs) => ({ allowedIPs })),
  });
}

test("a normal member and a gateway with a private LAN pass", () => {
  assertEquals(
    check(
      ["10.250.0.12/32", "10.193.0.0/16"],
      ["10.250.0.13/32", "10.194.0.0/16", "192.168.20.0/24", "172.16.0.0/12"],
    ),
    null,
  );
});

test("default routes and short prefixes are refused", () => {
  for (
    const cidr of ["0.0.0.0/0", "0.0.0.0/1", "128.0.0.0/1", "8.0.0.0/7", "::/0"]
  ) {
    assertEquals(
      typeof check(["10.250.0.12/32", cidr]),
      "string",
      cidr,
    );
  }
});

test("public, loopback, link-local and multicast ranges are refused", () => {
  for (
    const cidr of [
      "8.8.8.0/24",
      "127.0.0.0/8",
      "169.254.0.0/16",
      "224.0.0.0/24",
      "2001:db8::/48",
      "fe80::/64",
    ]
  ) {
    assertEquals(typeof check(["10.250.0.12/32", cidr]), "string", cidr);
  }
});

test("a peer cannot claim this host's own address or prefix", () => {
  assertEquals(typeof check(["10.250.0.12/32", "10.250.0.11/32"]), "string");
  assertEquals(typeof check(["10.250.0.12/32", "10.192.5.0/24"]), "string");
  assertEquals(typeof check(["10.250.0.12/32", "10.0.0.0/8"]), "string");
});

test("one peer cannot take over part of another peer's ranges", () => {
  assertEquals(
    typeof check(
      ["10.250.0.12/32", "10.193.0.0/16"],
      ["10.250.0.13/32", "10.193.4.0/24"],
    ),
    "string",
  );
});

test("two gateways advertising the same range is allowed", () => {
  assertEquals(
    check(
      ["10.250.0.12/32", "10.193.0.0/16", "192.168.20.0/24"],
      ["10.250.0.13/32", "10.194.0.0/16", "192.168.20.0/24"],
    ),
    null,
  );
});
