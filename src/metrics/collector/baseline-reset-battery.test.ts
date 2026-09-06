import { assertEquals } from "@std/assert";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

import { CounterBaselineTracker } from "./baseline.ts";

/**
 * Counter-reset battery for `CounterBaselineTracker` — four disruption
 * scenarios a real collector must survive without ever fabricating a spike:
 * reboot (boot-generation bump), counter wrap (value decrease, same boot
 * generation), sidecar restart (a source goes silent for one or more ticks,
 * then reappears with a reset counter), and device replacement (an entity's
 * topology id changes — old id simply stops being read, new id starts a
 * fresh baseline). `baseline.test.ts` already covers each disruption in
 * isolation against a single key; this file additionally drives several
 * unrelated counters through a shared tracker across a tick sequence where
 * two different disruptions land in the *same* tick, to prove disruptions
 * never leak across keys.
 */

test("reboot: rate is null exactly on the boot-generation-change tick, then re-baselines cleanly", () => {
  const tracker = new CounterBaselineTracker();
  assertEquals(tracker.rate("nic:eth0:rx", 1000, 0, 60), null);
  assertEquals(tracker.rate("nic:eth0:rx", 1600, 0, 60), 10);
  // Reboot: boot generation bumps 0 -> 1, counter resets low.
  assertEquals(tracker.rate("nic:eth0:rx", 50, 1, 60), null);
  // Immediately after, the rate is clean — never a spike against the
  // pre-reboot value (e.g. never (50 - 1600) / 60).
  assertEquals(tracker.rate("nic:eth0:rx", 170, 1, 60), 2);
  assertEquals(tracker.rate("nic:eth0:rx", 290, 1, 60), 2);
});

test("counter wrap: rate is null exactly on the decrease tick (no boot change), then re-baselines cleanly", () => {
  const tracker = new CounterBaselineTracker();
  assertEquals(tracker.rate("block:sda:read", 5000, 0, 60), null);
  assertEquals(tracker.rate("block:sda:read", 5400, 0, 60), 400 / 60);
  // Wrap: value decreases with no boot-generation change.
  assertEquals(tracker.rate("block:sda:read", 200, 0, 60), null);
  assertEquals(tracker.rate("block:sda:read", 800, 0, 60), 10);
  assertEquals(tracker.rate("block:sda:read", 1400, 0, 60), 10);
});

test("sidecar restart: a gap of missed ticks produces no data, then the reappearance re-baselines instead of computing a rate against the stale pre-gap value", () => {
  const tracker = new CounterBaselineTracker();
  const key = "ingress:caddy0:requests";
  assertEquals(tracker.rate(key, 100, 0, 60), null);
  assertEquals(tracker.rate(key, 220, 0, 60), 2);
  // Sidecar goes silent for two ticks: the caller never calls delta()/rate()
  // for a tick where the source is absent — it invalidates instead, so a
  // later reappearance can never diff against a multi-interval-stale value.
  tracker.invalidate(key);
  tracker.invalidate(key);
  // Reappears with a reset counter (lower than the last-seen 220) — this
  // must read as a fresh first observation, not a wrapped decrease.
  assertEquals(tracker.rate(key, 50, 0, 60), null);
  assertEquals(tracker.rate(key, 170, 0, 60), 2);
});

test("device replacement: the old entity's key is simply abandoned, the new entity's key starts its own fresh baseline unaffected by the old one's last value", () => {
  const tracker = new CounterBaselineTracker();
  assertEquals(tracker.rate("nic:eth1:rx", 300, 0, 60), null);
  assertEquals(tracker.rate("nic:eth1:rx", 900, 0, 60), 10);
  assertEquals(tracker.rate("nic:eth1:rx", 1500, 0, 60), 10);
  // eth1 is unplugged / replaced: the caller stops calling for "nic:eth1:rx"
  // entirely and starts calling for the new device's own key. Even though
  // the new device's first reading (50) is far below eth1's last value
  // (1500), this must read as a first observation on its own key, never a
  // decrease computed against the old device's baseline.
  assertEquals(tracker.rate("nic:eth2:rx", 50, 0, 60), null);
  assertEquals(tracker.rate("nic:eth2:rx", 650, 0, 60), 10);
});

test("topology change mid-stream: a slot reorder / GPU swap bumps topologyGeneration but the same device identity keeps counting — rate stays continuous, no spurious reset", () => {
  const tracker = new CounterBaselineTracker();
  // `CounterBaselineTracker` has no notion of topologyGeneration at all —
  // its key is the caller-assembled stable deviceId (e.g. `net:<deviceId>:rx`,
  // never a slot/kernel name), and `rate`/`delta` only ever branch on
  // bootGeneration. A NIC reordered to a different PCI slot, or a GPU swap
  // that reassigns a slot, changes topologyGeneration while the device's own
  // identity and counters continue uninterrupted — bootGeneration never
  // changes and the value never decreases, so this must read as an ordinary
  // continuing counter, never a reset.
  assertEquals(tracker.rate("net:nic-stable-id-7:rx", 1000, 0, 60), null);
  assertEquals(tracker.rate("net:nic-stable-id-7:rx", 1600, 0, 60), 10);
  // Topology change lands here: hardware got reordered into a different PCI
  // slot (topologyGeneration bumps 0 -> 1 at the caller/wire level), but
  // this same device's deviceId and counters are untouched — bootGeneration
  // stays 0 and the value keeps climbing monotonically.
  assertEquals(tracker.rate("net:nic-stable-id-7:rx", 2200, 0, 60), 10);
  assertEquals(tracker.rate("net:nic-stable-id-7:rx", 2800, 0, 60), 10);
});

test("topology change mid-stream: an operator/uplink-detection NIC1/NIC2 slot swap moves stable-identity keys unaffected — each device's rate stays continuous through the reorder tick", () => {
  const tracker = new CounterBaselineTracker();
  // `identity.ts`'s `deriveNetworkDeviceIdentity` prefers a MAC-derived
  // deviceId, and `slot-mapping.ts` layers a separate `nicSlotDeviceIds`
  // resolution on top of that stable identity set — an
  // operator override or a re-detected uplink order can flip which
  // deviceId is reported as "NIC1" vs "NIC2" (bumping topologyGeneration
  // via the resolved `SlotMapping`) without touching either device's own
  // deviceId, bootGeneration, or counters at all.
  const nicA = "net:mac:aa:bb:cc:dd:ee:01:rx";
  const nicB = "net:mac:aa:bb:cc:dd:ee:02:rx";

  // t0/t1: NIC A is currently "NIC1", NIC B is currently "NIC2" — both
  // counting normally, independent rates.
  assertEquals(tracker.rate(nicA, 1000, 0, 60), null);
  assertEquals(tracker.rate(nicA, 1600, 0, 60), 10);
  assertEquals(tracker.rate(nicB, 5000, 0, 60), null);
  assertEquals(tracker.rate(nicB, 5300, 0, 60), 5);

  // t2: the slot mapping flips — NIC B is now reported as "NIC1", NIC A as
  // "NIC2" (topologyGeneration bumps at the wire level). Because the
  // tracker is keyed by each device's own deviceId, never by its current
  // "NIC1"/"NIC2" label, neither device's rate is disturbed by the swap.
  assertEquals(tracker.rate(nicA, 2200, 0, 60), 10);
  assertEquals(tracker.rate(nicB, 5600, 0, 60), 5);
  assertEquals(tracker.rate(nicA, 2800, 0, 60), 10);
  assertEquals(tracker.rate(nicB, 5900, 0, 60), 5);
});

test("counterfactual: keying by current slot label instead of stable device identity fabricates a discontinuity on the exact same slot reorder", () => {
  // This test intentionally does what real collector code must never do —
  // key a baseline by the caller's *current* slot label — to demonstrate
  // why `network.ts` et al. key by `device.deviceId` instead of
  // `device.name`/slot position.
  const tracker = new CounterBaselineTracker();
  const SLOT1 = "net:slot:nic1:rx";
  const SLOT2 = "net:slot:nic2:rx";

  // t0/t1: slot1 currently carries NIC A's counter (climbing from 1000 at
  // 10/s), slot2 currently carries NIC B's counter (climbing from 5000 at
  // 5/s) — same underlying devices and values as the test above.
  assertEquals(tracker.rate(SLOT1, 1000, 0, 60), null);
  assertEquals(tracker.rate(SLOT1, 1600, 0, 60), 10);
  assertEquals(tracker.rate(SLOT2, 5000, 0, 60), null);
  assertEquals(tracker.rate(SLOT2, 5300, 0, 60), 5);

  // t2: the same slot reorder as above — NIC B now reports under "slot1"
  // (its own counter ticks 5300 -> 5600) and NIC A now reports under
  // "slot2" (its own counter ticks 1600 -> 2200). Nothing about either
  // device's counter is abnormal, but the slot-keyed tracker diffs each
  // slot's new value against the *other* device's last-seen value:
  // - slot1 sees 5600 following a prior 1600 → a fabricated spike
  //   (66.67/s), nowhere near NIC B's real 5/s.
  // - slot2 sees 2200 following a prior 5300 → reads as a decrease, so a
  //   spurious reset (`null`) even though NIC A only continued normally.
  assertEquals(tracker.rate(SLOT1, 5600, 0, 60), 4000 / 60);
  assertEquals(tracker.rate(SLOT2, 2200, 0, 60), null);
});

test(
  "battery: reboot and counter-wrap disruptions landing in the same tick never affect unrelated counters ticking normally alongside them",
  () => {
    const tracker = new CounterBaselineTracker();

    // Per-tick (60s) raw values. eth0's boot generation flips 0 -> 1 at t2
    // (reboot); every other field keeps boot generation 0 throughout, so a
    // rate discontinuity on an unrelated field at t2 would prove leakage.
    const eth0Rx = [1000, 1600, 50, 170, 290, 410, 530, 650];
    const eth0RxBoot = [0, 0, 1, 1, 1, 1, 1, 1];
    const eth0Tx = [2000, 2600, 80, 320, 560, 800, 1040, 1280];
    const eth0TxBoot = eth0RxBoot;
    // sda wraps at t2 (value decrease, no boot change) — independent disruption,
    // same tick as eth0's reboot.
    const sdaRead = [5000, 5400, 200, 800, 1400, 2000, 2600, 3200];
    // caddy keeps reporting normally through t2 (proving eth0/sda's t2
    // disruptions don't bleed into it), then goes silent for t3/t4 (sidecar
    // restart), then reappears with a reset counter at t5.
    const caddyReq: (number | "gap")[] = [
      100,
      220,
      340,
      "gap",
      "gap",
      50,
      170,
      290,
    ];
    // eth1 reports through t2, then is replaced by eth2 from t3 onward
    // (device replacement, isolated from every other disruption above).
    const eth1Rx: (number | "absent")[] = [
      300,
      900,
      1500,
      "absent",
      "absent",
      "absent",
      "absent",
      "absent",
    ];
    const eth2Rx: (number | "absent")[] = [
      "absent",
      "absent",
      "absent",
      50,
      650,
      1250,
      1850,
      2450,
    ];

    const expectedEth0Rx = [null, 10, null, 2, 2, 2, 2, 2];
    const expectedEth0Tx = [null, 10, null, 4, 4, 4, 4, 4];
    const expectedSdaRead = [null, 400 / 60, null, 10, 10, 10, 10, 10];
    const expectedCaddyReq = [null, 2, 2, "gap", "gap", null, 2, 2];
    const expectedEth1Rx = [
      null,
      10,
      10,
      "absent",
      "absent",
      "absent",
      "absent",
      "absent",
    ];
    const expectedEth2Rx = ["absent", "absent", "absent", null, 10, 10, 10, 10];

    for (let t = 0; t < eth0Rx.length; t++) {
      assertEquals(
        tracker.rate("nic:eth0:rx", eth0Rx[t], eth0RxBoot[t], 60),
        expectedEth0Rx[t],
        `nic:eth0:rx at t${t}`,
      );
      assertEquals(
        tracker.rate("nic:eth0:tx", eth0Tx[t], eth0TxBoot[t], 60),
        expectedEth0Tx[t],
        `nic:eth0:tx at t${t}`,
      );
      assertEquals(
        tracker.rate("block:sda:read", sdaRead[t], 0, 60),
        expectedSdaRead[t],
        `block:sda:read at t${t}`,
      );

      const caddy = caddyReq[t];
      if (caddy === "gap") {
        tracker.invalidate("ingress:caddy0:requests");
        assertEquals(
          expectedCaddyReq[t],
          "gap",
          `caddy expectation mismatch at t${t}`,
        );
      } else {
        assertEquals(
          tracker.rate("ingress:caddy0:requests", caddy, 0, 60),
          expectedCaddyReq[t],
          `ingress:caddy0:requests at t${t}`,
        );
      }

      const eth1 = eth1Rx[t];
      if (eth1 === "absent") {
        assertEquals(
          expectedEth1Rx[t],
          "absent",
          `eth1 expectation mismatch at t${t}`,
        );
        // Device gone: the caller simply stops calling for this key.
      } else {
        assertEquals(
          tracker.rate("nic:eth1:rx", eth1, 0, 60),
          expectedEth1Rx[t],
          `nic:eth1:rx at t${t}`,
        );
      }

      const eth2 = eth2Rx[t];
      if (eth2 === "absent") {
        assertEquals(
          expectedEth2Rx[t],
          "absent",
          `eth2 expectation mismatch at t${t}`,
        );
      } else {
        assertEquals(
          tracker.rate("nic:eth2:rx", eth2, 0, 60),
          expectedEth2Rx[t],
          `nic:eth2:rx at t${t}`,
        );
      }
    }
  },
);
