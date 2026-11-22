import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { parse } from "yaml";
import {
  assertShareAddressesPinned,
  checkShareTargets,
  DENY_SET_TTL_MS,
  getShareDenySet,
  pinShareAddresses,
  resetShareDenySet,
  type ShareTargetDeps,
} from "./network-share-targets.ts";

const test = Deno.test.bind(Deno);

const BRIDGE = {
  Id: "a",
  Name: "bridge",
  IPAM: { Config: [{ Subnet: "172.17.0.0/16", Gateway: "172.17.0.1" }] },
};
const OTHER = {
  Id: "b",
  Name: "tp_app",
  IPAM: {
    Config: [
      { Subnet: "172.29.4.0/24", Gateway: "172.29.4.1" },
      { Subnet: "fd00:4::/64", Gateway: "fd00:4::1" },
    ],
  },
};

type Answers = Record<string, { A?: string[]; AAAA?: string[]; fail?: Error }>;

function deps(answers: Answers, extra: ShareTargetDeps = {}): ShareTargetDeps {
  return {
    hostAddresses: () => ["192.0.2.50", "::1"],
    listDockerNetworks: () => Promise.resolve([BRIDGE, OTHER]),
    dockerPools: () => Promise.resolve([{ Base: "10.200.0.0/16" }]),
    resolveDns: (name, type) => {
      const answer = answers[name];
      if (answer?.fail) return Promise.reject(answer.fail);
      const list = answer?.[type];
      return list
        ? Promise.resolve(list)
        : Promise.reject(new Deno.errors.NotFound("no record"));
    },
    ...extra,
  };
}

function shareDoc(
  device: string,
  o?: string,
): Record<string, unknown> {
  return {
    services: { web: { image: "alpine" } },
    volumes: {
      media: { driver_opts: { type: "cifs", device, ...(o ? { o } : {}) } },
    },
  };
}

async function refusal(
  device: string,
  d: ShareTargetDeps,
  o?: string,
): Promise<string> {
  resetShareDenySet();
  const error = await assertRejects(() =>
    checkShareTargets(shareDoc(device, o), d)
  );
  return (error as Error).message;
}

test("a public address passes and is the pin", async () => {
  resetShareDenySet();
  const pins = await checkShareTargets(
    shareDoc("//files.example.net/media"),
    deps({ "files.example.net": { A: ["198.51.100.7"] } }),
  );
  assertEquals([...pins], [["media", "198.51.100.7"]]);
});

test("a private LAN address still passes", async () => {
  resetShareDenySet();
  const pins = await checkShareTargets(
    shareDoc("//10.20.30.40/media"),
    deps({}),
  );
  assertEquals(pins.get("media"), "10.20.30.40");
});

test("a name resolving to an internal address is denied", async () => {
  for (
    const bad of ["127.0.0.1", "169.254.169.254", "0.0.0.0", "192.0.2.50"]
  ) {
    const msg = await refusal(
      "//evil.example.net/s",
      deps({ "evil.example.net": { A: [bad] } }),
    );
    assertStringIncludes(msg, `resolves to ${bad}`);
  }
});

test("one bad answer among good ones denies the name", async () => {
  const msg = await refusal(
    "//mixed.example.net/s",
    deps({ "mixed.example.net": { A: ["198.51.100.7"], AAAA: ["::1"] } }),
  );
  assertStringIncludes(msg, "resolves to ::1");
});

test("a mapped IPv6 form of an own address is denied", async () => {
  const msg = await refusal(
    "//m.example.net/s",
    deps({ "m.example.net": { AAAA: ["::ffff:192.0.2.50"] } }),
  );
  assertStringIncludes(msg, "this server itself");
});

test("a resolution failure is denied with a reason", async () => {
  const fail = await refusal(
    "//down.example.net/s",
    deps({ "down.example.net": { fail: new Error("timed out") } }),
  );
  assertStringIncludes(fail, "could not be resolved (timed out)");
  const none = await refusal("//gone.example.net/s", deps({}));
  assertStringIncludes(none, "no A or AAAA record");
});

test("a failure on only one record type is still a denial", async () => {
  const msg = await refusal("//half.example.net/s", {
    ...deps({}),
    resolveDns: (_name, type) =>
      type === "A"
        ? Promise.resolve(["198.51.100.7"])
        : Promise.reject(new Error("servfail")),
  });
  assertStringIncludes(msg, "servfail");
});

test("the gateway and subnet of another Docker network are denied", async () => {
  const gateway = await refusal("//172.29.4.1/s", deps({}));
  assertStringIncludes(gateway, "this server");
  const member = await refusal(
    "//c.example.net/s",
    deps({ "c.example.net": { A: ["172.29.4.200"] } }),
  );
  assertStringIncludes(member, "Docker network");
  const v6 = await refusal("//[fd00:4::9]/s", deps({}));
  assertStringIncludes(v6, "Docker network");
  const outside = await checkShareTargets(
    shareDoc("//172.30.0.9/s"),
    deps({}),
  );
  assertEquals(outside.get("media"), "172.30.0.9");
});

test("an addr option is the dialed host and is judged the same way", async () => {
  const msg = await refusal(
    "//files.example.net/s",
    deps({ "files.example.net": { A: ["198.51.100.7"] } }),
    "addr=172.29.4.1",
  );
  assertStringIncludes(msg, "172.29.4.1");
});

test("a check right after a restart is not empty", async () => {
  resetShareDenySet();
  const set = await getShareDenySet(deps({}));
  assertEquals(set.addresses.has("192.0.2.50"), true);
  assertEquals(set.addresses.has("172.17.0.1"), true);
  assertEquals(set.cidrs.length, 5);
});

test("when the deny set cannot be built the check is denied, and not cached", async () => {
  resetShareDenySet();
  const broken = deps({}, {
    listDockerNetworks: () => Promise.reject(new Error("socket gone")),
  });
  const error = await assertRejects(() =>
    checkShareTargets(shareDoc("//198.51.100.7/s"), broken)
  );
  assertStringIncludes((error as Error).message, "socket gone");
  const failedHosts = await assertRejects(() =>
    checkShareTargets(shareDoc("//198.51.100.7/s"), {
      ...broken,
      hostAddresses: () => {
        throw new Error("no interfaces");
      },
    })
  );
  assertStringIncludes((failedHosts as Error).message, "no interfaces");
  const pins = await checkShareTargets(
    shareDoc("//198.51.100.7/s"),
    deps({}),
  );
  assertEquals(pins.get("media"), "198.51.100.7");
});

test("the deny set is reused briefly and rebuilt after the TTL", async () => {
  resetShareDenySet();
  let builds = 0;
  let now = 1_000;
  const counting = deps({}, {
    now: () => now,
    listDockerNetworks: () => {
      builds++;
      return Promise.resolve([BRIDGE]);
    },
  });
  await getShareDenySet(counting);
  await getShareDenySet(counting);
  assertEquals(builds, 1);
  now += DENY_SET_TTL_MS + 1;
  await getShareDenySet(counting);
  assertEquals(builds, 2);
});

test("a document without shares needs no deny set", async () => {
  resetShareDenySet();
  const pins = await checkShareTargets(
    { volumes: { data: {} } },
    deps({}, {
      listDockerNetworks: () => Promise.reject(new Error("never asked")),
    }),
  );
  assertEquals(pins.size, 0);
});

test("pinning writes the checked address and drops any other addr", () => {
  const yaml = "services:\n  web:\n    image: alpine\nvolumes:\n  media: {}\n";
  const resolved = shareDoc(
    "//files.example.net/s",
    "username=svc,addr=10.0.0.9,vers=3.1.1",
  );
  const out = parse(
    pinShareAddresses(yaml, resolved, new Map([["media", "198.51.100.7"]])),
  ) as { volumes: { media: { driver_opts: Record<string, string> } } };
  assertEquals(
    out.volumes.media.driver_opts.o,
    "username=svc,vers=3.1.1,addr=198.51.100.7",
  );
  assertEquals(out.volumes.media.driver_opts.device, "//198.51.100.7/s");
  assertEquals(pinShareAddresses(yaml, resolved, new Map()), yaml);
});

test("the final check refuses an unpinned, changed or denied address", async () => {
  const pins = new Map([["media", "198.51.100.7"]]);
  const good = shareDoc("//198.51.100.7/s", "addr=198.51.100.7");
  resetShareDenySet();
  await assertShareAddressesPinned(good, pins, deps({}));
  for (
    const bad of [
      shareDoc("//198.51.100.7/s"),
      shareDoc("//198.51.100.7/s", "addr=198.51.100.8"),
      shareDoc("//172.29.4.1/s", "addr=172.29.4.1"),
      shareDoc("//198.51.100.7/s", "addr=198.51.100.7,addr=10.0.0.1"),
      // the device still names a host: the kernel would resolve it again
      shareDoc("//files.example.net/s", "addr=198.51.100.7"),
      shareDoc("//198.51.100.8/s", "addr=198.51.100.7"),
    ]
  ) {
    await assertRejects(
      () => assertShareAddressesPinned(bad, pins, deps({})),
      Error,
      "network share volumes refused before start",
    );
  }
});

test("the pinned device and addr are both the checked address", () => {
  const yaml = "services:\n  web:\n    image: alpine\nvolumes:\n  media: {}\n";
  const v6 = parse(
    pinShareAddresses(
      yaml,
      shareDoc("//files.example.net/s/sub"),
      new Map([["media", "2001:db8::7"]]),
    ),
  ) as { volumes: { media: { driver_opts: Record<string, string> } } };
  assertEquals(v6.volumes.media.driver_opts.device, "//[2001:db8::7]/s/sub");
  assertEquals(v6.volumes.media.driver_opts.o, "addr=2001:db8::7");
});

function withNetworks(
  networks: Record<string, unknown>,
  device = "//10.99.0.1/s",
): Record<string, unknown> {
  return { ...shareDoc(device), networks };
}

test("a network the compose declares itself is denied before it exists", async () => {
  resetShareDenySet();
  const declared = withNetworks({
    mine: {
      ipam: { config: [{ subnet: "10.99.0.0/24", gateway: "10.99.0.1" }] },
    },
  });
  const gateway = await assertRejects(() =>
    checkShareTargets(declared, deps({}))
  );
  assertStringIncludes((gateway as Error).message, "this server itself");
  const member = await assertRejects(() =>
    checkShareTargets(
      withNetworks(
        declared.networks as Record<string, unknown>,
        "//10.99.0.77/s",
      ),
      deps({}),
    )
  );
  assertStringIncludes((member as Error).message, "Docker network");
  const pinned = await assertRejects(() =>
    assertShareAddressesPinned(
      withNetworks(
        { mine: { ipam: { config: [{ subnet: "10.99.0.0/24" }] } } },
        "//10.99.0.9/s",
      ),
      new Map([["media", "10.99.0.9"]]),
      deps({}),
    )
  );
  assertStringIncludes((pinned as Error).message, "refused before start");
  // not remembered for the next deploy
  const pins = await checkShareTargets(shareDoc("//10.99.0.9/s"), deps({}));
  assertEquals(pins.get("media"), "10.99.0.9");
});

test("the pools dockerd reports are denied, with a hint to free a LAN range", async () => {
  const pool = await refusal("//10.200.7.9/s", deps({}));
  assertStringIncludes(pool, "Docker network or address pool");
  assertStringIncludes(pool, "default-address-pools");
});

test("without configured pools dockerd's built-in ones are denied", async () => {
  for (const none of [null, undefined, []]) {
    const d = deps({}, { dockerPools: () => Promise.resolve(none) });
    for (
      const bad of ["172.17.5.5", "172.18.0.1", "172.31.255.1", "192.168.0.1"]
    ) {
      assertStringIncludes(
        await refusal(`//${bad}/s`, d),
        "address pool",
      );
    }
    // 192.168/16 is denied whole, not carved out; the rest of 172 is not Docker's
    assertStringIncludes(await refusal("//192.168.200.9/s", d), "address pool");
    resetShareDenySet();
    const pins = await checkShareTargets(shareDoc("//172.16.5.5/s"), d);
    assertEquals(pins.get("media"), "172.16.5.5");
  }
});

test("without an IPv6 pool all of fd00::/8 is denied, with one only that pool", async () => {
  const v4only = deps({});
  for (const bad of ["fd12:3456:789a::1", "fd00:9::1"]) {
    assertStringIncludes(await refusal(`//[${bad}]/s`, v4only), "address pool");
  }
  const v6 = deps({}, {
    dockerPools: () =>
      Promise.resolve([{ Base: "10.200.0.0/16" }, { Base: "fd10::/48" }]),
  });
  assertStringIncludes(await refusal("//[fd10::1]/s", v6), "address pool");
  resetShareDenySet();
  const pins = await checkShareTargets(shareDoc("//[fd20::9]/s"), v6);
  assertEquals(pins.get("media"), "fd20::9");
});

test("when dockerd cannot say which pools it uses the share is refused", async () => {
  const failing = deps({}, {
    dockerPools: () => Promise.reject(new Error("info: HTTP 500")),
  });
  assertStringIncludes(
    await refusal("//198.51.100.7/s", failing),
    "info: HTTP 500",
  );
  const malformed = deps({}, {
    dockerPools: () => Promise.resolve([{ Base: "not-a-cidr" }]),
  });
  assertStringIncludes(
    await refusal("//198.51.100.7/s", malformed),
    "unreadable address pool",
  );
});

test("a macvlan network denies its gateway, not its parent LAN", async () => {
  const lan = {
    Id: "m",
    Name: "lan",
    Driver: "macvlan",
    IPAM: { Config: [{ Subnet: "10.20.30.0/24", Gateway: "10.20.30.1" }] },
  };
  const d = deps({}, {
    listDockerNetworks: () => Promise.resolve([BRIDGE, lan]),
  });
  const gateway = await refusal("//10.20.30.1/s", d);
  assertStringIncludes(gateway, "this server itself");
  resetShareDenySet();
  const pins = await checkShareTargets(shareDoc("//10.20.30.40/s"), d);
  assertEquals(pins.get("media"), "10.20.30.40");
  // the same for a macvlan the compose declares
  const declared = await checkShareTargets(
    withNetworks({
      lan: {
        driver: "ipvlan",
        ipam: { config: [{ subnet: "10.30.0.0/24", gateway: "10.30.0.1" }] },
      },
    }, "//10.30.0.40/s"),
    d,
  );
  assertEquals(declared.get("media"), "10.30.0.40");
});

test("a name that does not answer in time is denied with a reason", async () => {
  const msg = await refusal("//slow.example.net/s", {
    ...deps({}),
    resolveDns: () =>
      Promise.reject(
        new DOMException("The signal timed out", "TimeoutError"),
      ),
  });
  assertStringIncludes(msg, "no answer within 5 seconds");
});

test("sec=krb5 is refused with a host name and allowed with an IP", async () => {
  const answers = { "files.example.net": { A: ["198.51.100.7"] } };
  for (const sec of ["krb5", "krb5i"]) {
    const msg = await refusal(
      "//files.example.net/s",
      deps(answers),
      `sec=${sec}`,
    );
    assertStringIncludes(msg, "sec=krb5");
  }
  resetShareDenySet();
  const pins = await checkShareTargets(
    shareDoc("//198.51.100.7/s", "sec=krb5"),
    deps(answers),
  );
  assertEquals(pins.get("media"), "198.51.100.7");
  const ntlm = await checkShareTargets(
    shareDoc("//files.example.net/s", "sec=ntlmssp"),
    deps(answers),
  );
  assertEquals(ntlm.get("media"), "198.51.100.7");
});

test("a mapped IPv6 form of a pool, network or builtin address is denied as a literal and as a DNS answer", async () => {
  const d = deps({
    "pool.example.net": { AAAA: ["::ffff:10.200.1.1"] },
    "loop.example.net": { AAAA: ["::ffff:127.0.0.1"] },
    "meta.example.net": { AAAA: ["::ffff:169.254.169.254"] },
    "net.example.net": { AAAA: ["::ffff:172.29.4.9"] },
    "gw.example.net": { AAAA: ["::ffff:172.17.0.1"] },
  });
  for (
    const device of [
      "//[::ffff:10.200.1.1]/s",
      "//[::ffff:0ac8:0101]/s",
      "//[::ffff:127.0.0.1]/s",
      "//[::ffff:169.254.169.254]/s",
      "//[::ffff:172.29.4.9]/s",
      "//[::ffff:172.17.0.1]/s",
      "//[::ffff:192.0.2.50]/s",
      "//pool.example.net/s",
      "//loop.example.net/s",
      "//meta.example.net/s",
      "//net.example.net/s",
      "//gw.example.net/s",
    ]
  ) {
    assertStringIncludes(await refusal(device, d), "refused");
  }
  resetShareDenySet();
  const pins = await checkShareTargets(
    shareDoc("//[::ffff:198.51.100.7]/s"),
    d,
  );
  assertEquals(pins.get("media"), "::ffff:198.51.100.7");
});

test("a pool or network written in mapped IPv6 form denies its IPv4 addresses", async () => {
  const d = deps({}, {
    listDockerNetworks: () =>
      Promise.resolve([{
        Id: "m",
        Name: "mapped",
        IPAM: {
          Config: [{
            Subnet: "::ffff:10.88.0.0/120",
            Gateway: "::ffff:10.88.0.1",
          }],
        },
      }]),
    dockerPools: () => Promise.resolve([{ Base: "::ffff:10.77.0.0/112" }]),
  });
  for (const bad of ["10.88.0.200", "10.77.5.5", "10.88.0.1"]) {
    assertStringIncludes(await refusal(`//${bad}/s`, d), "refused");
    assertStringIncludes(await refusal(`//[::ffff:${bad}]/s`, d), "refused");
  }
});

test("an IPv6-only pool keeps the IPv4 and IPv6 builtin denials", async () => {
  const d = deps({}, {
    listDockerNetworks: () => Promise.resolve([]),
    hostAddresses: () => [],
    dockerPools: () => Promise.resolve([{ Base: "fd10::/48" }]),
  });
  for (
    const bad of [
      "127.0.0.1",
      "127.9.9.9",
      "169.254.1.1",
      "169.254.169.254",
      "172.17.5.5",
      "192.168.1.1",
      "[::1]",
      "[fe80::1]",
      "[fd10::5]",
      "[fd00:ec2::254]",
      "[::ffff:127.0.0.1]",
      "[::ffff:172.20.0.5]",
    ]
  ) {
    assertStringIncludes(await refusal(`//${bad}/s`, d), "refused");
  }
  resetShareDenySet();
  const pins = await checkShareTargets(shareDoc("//198.51.100.7/s"), d);
  assertEquals(pins.get("media"), "198.51.100.7");
});

test("a mapped range is an IPv4 range only from /96 on", async () => {
  const pools = (...bases: string[]) =>
    deps({}, {
      listDockerNetworks: () => Promise.resolve([]),
      hostAddresses: () => [],
      dockerPools: () => Promise.resolve(bases.map((Base) => ({ Base }))),
    });
  // /96 maps the whole IPv4 space: every IPv4 address is denied.
  const all = pools("::ffff:0.0.0.0/96");
  for (const bad of ["198.51.100.7", "203.0.113.9", "[::ffff:198.51.100.7]"]) {
    assertStringIncludes(await refusal(`//${bad}/s`, all), "address pool");
  }
  // /95 is wider than the mapped block, so it stays an IPv6 range and does
  // not match a normalized IPv4 address.
  resetShareDenySet();
  const wide = pools("::ffff:0.0.0.0/95");
  const pins = await checkShareTargets(shareDoc("//198.51.100.7/s"), wide);
  assertEquals(pins.get("media"), "198.51.100.7");
  // /128 matches exactly one address.
  const one = pools("::ffff:198.51.100.7/128");
  assertStringIncludes(await refusal("//198.51.100.7/s", one), "address pool");
  resetShareDenySet();
  const other = await checkShareTargets(shareDoc("//198.51.100.8/s"), one);
  assertEquals(other.get("media"), "198.51.100.8");
});
