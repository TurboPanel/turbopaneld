/**
 * Physical NIC link state: reads `/sys/class/net/<name>/operstate` per
 * topology-enumerated network device (skipping `loopback`/`container-bridge`/
 * `virtual` — a `veth` coming and going is container churn and a tunnel or
 * VLAN child has no carrier of its own; bond/bridge `member` ports are kept,
 * since a port dropping out of a bond is a real physical link event). `up`→`down` fires `nic_link_down`; a prior `down` returning to
 * `up` fires `nic_link_up`. `unknown` (common on interfaces with no carrier
 * detection, or immediately after boot) is treated as "not down" — it never
 * triggers a link-down event on its own.
 *
 * `nic_flapping` fires once a device has accumulated
 * {@link FLAP_THRESHOLD} down-transitions inside {@link FLAP_WINDOW_MS},
 * then resets its flap counter so it doesn't refire every tick while still
 * above threshold.
 */
import type { EventCollector, EventDetectContext } from "./types.ts";
import { makeEvent } from "./types.ts";
import type { MetricEvent } from "../../contract.ts";

const FLAP_WINDOW_MS = 5 * 60_000;
const FLAP_THRESHOLD = 4;

type NicState = {
  operstate: string;
  flapTimestampsMs: number[];
};

export class NicLinkEventCollector implements EventCollector {
  readonly #previous = new Map<string, NicState>();

  async detect(ctx: EventDetectContext): Promise<MetricEvent[]> {
    const root = ctx.sysRoot ?? "/sys";
    const events: MetricEvent[] = [];

    for (const device of ctx.snapshot.networks) {
      if (
        device.kind === "loopback" || device.kind === "container-bridge" ||
        device.kind === "virtual"
      ) {
        continue;
      }

      const operstateRaw = await ctx.io.readFile(
        `${root}/class/net/${device.name}/operstate`,
      );
      const operstate = operstateRaw?.trim();
      if (operstate === undefined) continue;

      const prior = this.#previous.get(device.deviceId);
      const flapTimestampsMs = (prior?.flapTimestampsMs ?? []).filter(
        (t) => ctx.nowMs - t < FLAP_WINDOW_MS,
      );

      if (prior && prior.operstate !== operstate) {
        if (operstate === "down") {
          events.push(
            makeEvent("nic_link_down", "critical", ctx.nowMs, {
              entityId: device.deviceId,
            }),
          );
          flapTimestampsMs.push(ctx.nowMs);
        } else if (operstate === "up" && prior.operstate === "down") {
          events.push(
            makeEvent("nic_link_up", "info", ctx.nowMs, {
              entityId: device.deviceId,
            }),
          );
        }
      }

      if (flapTimestampsMs.length >= FLAP_THRESHOLD) {
        events.push(
          makeEvent("nic_flapping", "warning", ctx.nowMs, {
            entityId: device.deviceId,
            payload: { flapsInWindow: flapTimestampsMs.length },
          }),
        );
        flapTimestampsMs.length = 0;
      }

      this.#previous.set(device.deviceId, { operstate, flapTimestampsMs });
    }

    return events;
  }
}
