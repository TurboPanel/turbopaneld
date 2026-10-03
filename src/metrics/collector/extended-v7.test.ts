import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import type { DockerUsageSample } from "../../contracts/metrics-contract.ts";
import type { ContainerHealthSample } from "./docker-containers.ts";
import {
  buildCollectedExtended,
  formatTopSites,
  mergeExtended,
  reclaimableBytes,
} from "./extended-v7.ts";

const CONTAINERS: ContainerHealthSample = {
  running: 7,
  unhealthy: 1,
  restarting: 0,
  unhealthyNames: ["web-1"],
  unexpectedExits: 2,
  oomKills: 1,
  cpuPercent: 12.5,
  memoryBytes: 4096,
  traefik: { total: 3, up: 2, unhealthyNames: ["api"] },
};

const USAGE: DockerUsageSample = {
  layersBytes: 1,
  imagesCount: 2,
  imagesReclaimableBytes: 100,
  containersBytes: 3,
  containersCount: 4,
  volumesBytes: 5,
  volumesCount: 6,
  volumesReclaimableBytes: 20,
  buildCacheBytes: 7,
  buildCacheReclaimableBytes: 3,
};

it("maps container, Docker, TLS and site data onto the contract's extended keys", () => {
  assertEquals(
    buildCollectedExtended({
      containers: CONTAINERS,
      dockerUsage: USAGE,
      tlsExpiry: { soonestExpiryDays: 21, certificateCount: 4 },
      topSites: [{ id: "s1", bytes: 900 }, { id: "s2", bytes: 50 }],
    }),
    {
      docker: {
        containersRunning: 7,
        containersUnhealthy: 1,
        containersRestarting: 0,
        containerOomEvents: 1,
        containerDieEvents: 2,
        containersCpuPercent: 12.5,
        containersMemoryBytes: 4096,
        reclaimableBytes: 123,
      },
      ingress: { tlsCertSoonestExpiryDays: 21 },
      text: {
        unhealthyContainers: "web-1",
        unhealthyBackends: "api",
        topSites: "s1=900,s2=50",
      },
    },
  );
});

it("leaves missing data out instead of sending zeros", () => {
  assertEquals(buildCollectedExtended({}), undefined);
  assertEquals(
    buildCollectedExtended({
      containers: {
        ...CONTAINERS,
        unhealthy: 0,
        unhealthyNames: [],
        unexpectedExits: null,
        oomKills: null,
        cpuPercent: null,
        memoryBytes: null,
        traefik: { total: 0, up: 0, unhealthyNames: [] },
      },
      dockerUsage: null,
      tlsExpiry: null,
      topSites: [],
    }),
    {
      docker: {
        containersRunning: 7,
        containersUnhealthy: 0,
        containersRestarting: 0,
      },
    },
  );
});

it("sums reclaimable bytes only from known parts", () => {
  assertEquals(reclaimableBytes(USAGE), 123);
  assertEquals(
    reclaimableBytes({
      ...USAGE,
      imagesReclaimableBytes: null,
      volumesReclaimableBytes: 20,
      buildCacheReclaimableBytes: null,
    }),
    20,
  );
  assertEquals(
    reclaimableBytes({
      ...USAGE,
      imagesReclaimableBytes: null,
      volumesReclaimableBytes: null,
      buildCacheReclaimableBytes: null,
    }),
    undefined,
  );
  assertEquals(formatTopSites(undefined), undefined);
});

it("merges text and sections key by key so no part wipes another", () => {
  assertEquals(
    mergeExtended(
      { text: { kernel: "6.1" }, blockDeviceText: [{ deviceId: "a" }] },
      undefined,
      { text: { topSites: "s=1" }, docker: { containersRunning: 1 } },
    ),
    {
      text: { kernel: "6.1", topSites: "s=1" },
      docker: { containersRunning: 1 },
      blockDeviceText: [{ deviceId: "a" }],
    },
  );
  assertEquals(mergeExtended(undefined, undefined), undefined);
});
