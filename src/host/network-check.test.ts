import { assertEquals } from "@std/assert";
import { runServerNetworkCheck } from "./network-check.ts";

const iface = () => new Map([["10.10.0.5", "eth1"]]);

function conn(hostname: string) {
  return Promise.resolve({
    localAddr: { transport: "tcp", hostname, port: 40000 } as Deno.Addr,
    close() {},
  });
}

Deno.test("reports reachable with source address and interface", async () => {
  let t = 0;
  const res = await runServerNetworkCheck(
    [{ peerServerId: "s2", address: "10.10.0.6", port: 22 }],
    "r1",
    {
      connect: () => conn("10.10.0.5"),
      localInterfaces: iface,
      now: () => t += 7,
    },
  );
  assertEquals(res.ok, true);
  assertEquals(res.id, "r1");
  assertEquals(res.results, [{
    peerServerId: "s2",
    address: "10.10.0.6",
    reachable: true,
    latencyMs: 7,
    sourceAddress: "10.10.0.5",
    interface: "eth1",
  }]);
});

Deno.test("maps refused and unreachable failures", async () => {
  const res = await runServerNetworkCheck(
    [
      { peerServerId: "a", address: "10.10.0.6", port: 22 },
      { peerServerId: "b", address: "10.10.0.7", port: 22 },
    ],
    "r2",
    {
      connect: ({ hostname }) =>
        hostname === "10.10.0.6"
          ? Promise.reject(new Deno.errors.ConnectionRefused("x"))
          : Promise.reject(new Error("no route")),
      localInterfaces: iface,
    },
  );
  assertEquals(res.results?.map((r) => [r.reachable, r.error]), [
    [false, "refused"],
    [false, "unreachable"],
  ]);
});

Deno.test("a silent peer is cut off as a timeout", async () => {
  const res = await runServerNetworkCheck(
    [{ peerServerId: "a", address: "10.10.0.6", port: 22 }],
    "r3",
    {
      timeoutMs: 20,
      localInterfaces: iface,
      connect: ({ signal }) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted")))
        ),
    },
  );
  assertEquals(res.results?.[0].error, "timeout");
});

Deno.test("refuses loopback, link-local, public and malformed targets", async () => {
  let called = false;
  const res = await runServerNetworkCheck(
    [
      { peerServerId: "a", address: "127.0.0.1", port: 22 },
      { peerServerId: "b", address: "169.254.1.1", port: 22 },
      { peerServerId: "c", address: "8.8.8.8", port: 53 },
      { peerServerId: "d", address: "10.0.0.1", port: 0 },
      { peerServerId: "e", address: "fe80::1%eth0", port: 22 },
      "nope",
    ],
    "r4",
    {
      connect: () => (called = true, conn("10.0.0.2")),
      localInterfaces: iface,
    },
  );
  assertEquals(called, false);
  assertEquals(res.ok, true);
  assertEquals(res.results?.every((r) => r.error === "invalid_target"), true);
  assertEquals(res.results?.length, 6);
});

Deno.test("an unusable request is ok false", async () => {
  assertEquals((await runServerNetworkCheck([], "r5")).ok, false);
  assertEquals((await runServerNetworkCheck("x", "r6")).ok, false);
  const many = Array.from({ length: 33 }, () => ({
    peerServerId: "a",
    address: "10.0.0.1",
    port: 22,
  }));
  assertEquals(
    (await runServerNetworkCheck(many, "r7")).error,
    "too many targets",
  );
});

Deno.test("accepts a private IPv6 address", async () => {
  const res = await runServerNetworkCheck(
    [{ peerServerId: "a", address: "fd00::6", port: 22 }],
    "r8",
    { connect: () => conn("fd00::5"), localInterfaces: iface },
  );
  assertEquals(res.results?.[0].reachable, true);
  assertEquals(res.results?.[0].sourceAddress, "fd00::5");
});
