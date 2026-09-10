import { assertEquals } from "@std/assert";

import type { DockerSystemDf } from "../../docker/client.ts";
import {
  DOCKER_USAGE_REFRESH_INTERVAL_MS,
  DockerUsageSampler,
  reduceDockerSystemDf,
} from "./docker-usage.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test} — Sonar typescript:S2187 only
 * recognizes `test()` / `it()` / `describe()`.
 */
const test = Deno.test.bind(Deno);

function df(overrides: Partial<DockerSystemDf> = {}): DockerSystemDf {
  return {
    LayersSize: 6000,
    Images: [
      { Size: 4000, Containers: 2 },
      { Size: 1000, Containers: 0 },
    ],
    Containers: [{ SizeRw: 800 }, { SizeRw: 400 }],
    Volumes: [
      { UsageData: { Size: 700, RefCount: 1 } },
      { UsageData: { Size: 200, RefCount: 0 } },
    ],
    BuildCache: [
      { Size: 60, InUse: true },
      { Size: 32, InUse: false },
    ],
    ...overrides,
  };
}

test("reduceDockerSystemDf reads layers from LayersSize, never by summing image sizes", () => {
  const { usage } = reduceDockerSystemDf(df());
  // Summing `Images[].Size` would give 5000 and double-count shared layers.
  assertEquals(usage.layersBytes, 6000);
});

test("reduceDockerSystemDf counts only unreferenced objects as reclaimable", () => {
  const { usage } = reduceDockerSystemDf(df());
  // The one image with `Containers: 0`.
  assertEquals(usage.imagesReclaimableBytes, 1000);
  // The one volume with `RefCount: 0`.
  assertEquals(usage.volumesReclaimableBytes, 200);
  // The one build-cache entry not in use.
  assertEquals(usage.buildCacheReclaimableBytes, 32);
});

test("reduceDockerSystemDf sums container writable layers, volume usage and build cache", () => {
  const { usage } = reduceDockerSystemDf(df());
  assertEquals(usage.containersBytes, 1200);
  assertEquals(usage.containersCount, 2);
  assertEquals(usage.volumesBytes, 900);
  assertEquals(usage.volumesCount, 2);
  assertEquals(usage.imagesCount, 2);
  assertEquals(usage.buildCacheBytes, 92);
});

test("dockerUsedBytes is layers + container writable layers + volumes + build cache", () => {
  const { dockerUsedBytes } = reduceDockerSystemDf(df());
  assertEquals(dockerUsedBytes, 6000 + 1200 + 900 + 92);
});

test("an absent section reports null rather than zero, and poisons only the total", () => {
  const { usage, dockerUsedBytes } = reduceDockerSystemDf(
    df({ Volumes: undefined }),
  );
  assertEquals(usage.volumesBytes, null);
  assertEquals(usage.volumesCount, null);
  assertEquals(usage.volumesReclaimableBytes, null);
  // Other sections still report; only the sum refuses to under-count.
  assertEquals(usage.layersBytes, 6000);
  assertEquals(dockerUsedBytes, null);
});

test("an empty section is a real zero, unlike an absent one", () => {
  const { usage, dockerUsedBytes } = reduceDockerSystemDf(
    df({ Volumes: [], BuildCache: [] }),
  );
  assertEquals(usage.volumesBytes, 0);
  assertEquals(usage.volumesCount, 0);
  assertEquals(usage.buildCacheBytes, 0);
  assertEquals(dockerUsedBytes, 6000 + 1200);
});

test("one entry missing a size does not blank its group's total", () => {
  const { usage } = reduceDockerSystemDf(
    df({ Containers: [{ SizeRw: 800 }, {}] }),
  );
  // The unsized container contributes 0 rather than nulling the whole sum.
  assertEquals(usage.containersBytes, 800);
  assertEquals(usage.containersCount, 2);
});

test("a volume with no UsageData contributes nothing and is not reclaimable", () => {
  const { usage } = reduceDockerSystemDf(
    df({
      Volumes: [{ UsageData: null }, { UsageData: { Size: 5, RefCount: 0 } }],
    }),
  );
  assertEquals(usage.volumesBytes, 5);
  assertEquals(usage.volumesReclaimableBytes, 5);
  assertEquals(usage.volumesCount, 2);
});

test("a negative or non-numeric Engine value degrades to null, never a negative byte count", () => {
  const { usage } = reduceDockerSystemDf(
    df({ LayersSize: -1 } as Partial<DockerSystemDf>),
  );
  assertEquals(usage.layersBytes, null);
});

test("the sampler reports null until its first successful poll", async () => {
  const sampler = new DockerUsageSampler({
    systemDf: () => Promise.reject(new Error("no socket")),
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  assertEquals(sampler.latest(), null);
  await sampler.refresh();
  // A host with no Docker keeps reporting null — the family is then omitted
  // from the sample rather than emitting zero bytes of Docker.
  assertEquals(sampler.latest(), null);
});

test("the sampler keeps its last good reading when a later poll fails", async () => {
  let failing = false;
  const sampler = new DockerUsageSampler({
    systemDf: () =>
      failing
        ? Promise.reject(new Error("engine restarting"))
        : Promise.resolve(df()),
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  await sampler.refresh();
  assertEquals(sampler.latest()?.usage.layersBytes, 6000);

  failing = true;
  await sampler.refresh();
  assertEquals(sampler.latest()?.usage.layersBytes, 6000);
});

test("the sampler drops an overlapping refresh rather than double-polling the Engine", async () => {
  let polls = 0;
  const sampler = new DockerUsageSampler({
    systemDf: () => {
      polls += 1;
      return Promise.resolve(df());
    },
    setIntervalFn: (() => 0) as unknown as typeof setInterval,
    clearIntervalFn: (() => {}) as unknown as typeof clearInterval,
  });
  await Promise.all([sampler.refresh(), sampler.refresh()]);
  assertEquals(polls, 1);
});

test("the sampler's default interval is slower than the metrics tick", () => {
  assertEquals(DOCKER_USAGE_REFRESH_INTERVAL_MS, 5 * 60_000);
  assertEquals(DOCKER_USAGE_REFRESH_INTERVAL_MS > 60_000, true);
});

test("reduceDockerSystemDf treats an absent BuildCache section as null reclaimable", () => {
  const { usage } = reduceDockerSystemDf(df({ BuildCache: undefined }));
  assertEquals(usage.buildCacheBytes, null);
  assertEquals(usage.buildCacheReclaimableBytes, null);
});

test("DockerUsageSampler.start is idempotent and stop is safe before start", async () => {
  let intervalArmed = 0;
  let intervalCleared = 0;
  const sampler = new DockerUsageSampler({
    systemDf: () => Promise.resolve(df()),
    setIntervalFn: ((fn: () => void) => {
      intervalArmed += 1;
      fn();
      return 1;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => {
      intervalCleared += 1;
    }) as unknown as typeof clearInterval,
  });
  sampler.stop();
  sampler.start();
  sampler.start();
  await sampler.refresh();
  sampler.stop();
  sampler.stop();
  assertEquals(intervalArmed, 1);
  assertEquals(intervalCleared, 1);
});
