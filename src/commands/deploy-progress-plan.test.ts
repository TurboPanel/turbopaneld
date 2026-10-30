import { assertEquals } from "@std/assert";
import type { EnvironmentDeployPayload } from "../contracts/commands-contracts.ts";
import { resolveLayout } from "../paths/layout.ts";
import {
  type DeployPresence,
  type DeployStepNeeds,
  deployStepNeeds,
  installStepIds,
  planDeploySteps,
  probeDeployPresence,
} from "./deploy-progress-plan.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests (see deploy-environment.test.ts). */
const test = Deno.test.bind(Deno);

const NOTHING_NEEDED: DeployStepNeeds = {
  docker: false,
  sharedIngress: false,
  publicEdge: false,
  nodeSeries: [],
  denoSeries: [],
  webServers: [],
  phpSeries: [],
  phpFpm: false,
  lsphp: false,
  buildTool: false,
  sourceBuilds: false,
  composeBuild: false,
  certificates: false,
  nativeApps: false,
};

const NOTHING_PRESENT: DeployPresence = {
  docker: false,
  sharedIngress: false,
  publicEdge: false,
  runtimes: undefined,
  webServers: new Set(),
  buildTool: false,
};

const FULL_NEEDS: DeployStepNeeds = {
  docker: true,
  sharedIngress: true,
  publicEdge: true,
  nodeSeries: ["22"],
  denoSeries: ["2"],
  webServers: ["apache"],
  phpSeries: ["8.3"],
  phpFpm: true,
  lsphp: false,
  buildTool: true,
  sourceBuilds: true,
  composeBuild: false,
  certificates: true,
  nativeApps: false,
};

function idsAndStates(needs: DeployStepNeeds, presence: DeployPresence) {
  return planDeploySteps(needs, presence).map((s) => `${s.id}=${s.state}`);
}

test("a fresh host plans every install as pending, in execution order", () => {
  const steps = planDeploySteps(FULL_NEEDS, NOTHING_PRESENT);
  assertEquals(steps.map((s) => s.id), [
    "install-docker",
    "install-gateway",
    "install-runtime:node-22",
    "install-runtime:deno-2",
    "install-web-server:apache",
    "install-php:8.3",
    "install-build-tool",
    "fetch",
    "build",
    "start",
    "certificates",
    "health",
  ]);
  assertEquals(steps.map((s) => s.label), [
    "Install Docker",
    "Set up the web gateway",
    "Install Node 22",
    "Install Deno 2",
    "Install Apache",
    "Install PHP 8.3",
    "Install the build tool",
    "Fetch the code",
    "Build",
    "Start the app",
    "Set up certificates",
    "Check it answers",
  ]);
  assertEquals(steps.every((s) => s.state === "pending"), true);
});

test("a deploy with native apps starts the new release beside the old, then switches", () => {
  const steps = planDeploySteps(
    { ...NOTHING_NEEDED, sourceBuilds: true, nativeApps: true },
    NOTHING_PRESENT,
  );
  assertEquals(steps.map((s) => s.label), [
    "Fetch the code",
    "Build",
    "Start the new release",
    "Check it answers",
    "Switch traffic",
    "Stop the old release",
  ]);
  assertEquals(steps.map((s) => s.id).slice(-4), [
    "start",
    "health",
    "switch",
    "stop-old",
  ]);
});

test("a host with everything present plans the installs as ready", () => {
  const steps = planDeploySteps(FULL_NEEDS, {
    docker: true,
    sharedIngress: true,
    publicEdge: true,
    runtimes: {
      php: { series: ["8.3", "8.4"] },
      node: { series: ["22"] },
      deno: { series: ["2"] },
    },
    webServers: new Set(["apache"]),
    buildTool: true,
  });
  const installs = steps.filter((s) => s.id.startsWith("install-"));
  assertEquals(installs.length, 7);
  assertEquals(installs.every((s) => s.state === "ready"), true);
  assertEquals(
    steps.filter((s) => !s.id.startsWith("install-")).every((s) =>
      s.state === "pending"
    ),
    true,
    "fetch / build / start / certificates / health always run",
  );
});

test("the gateway is ready only when every needed half is up", () => {
  const needs = {
    ...NOTHING_NEEDED,
    docker: true,
    sharedIngress: true,
    publicEdge: true,
  };
  assertEquals(
    idsAndStates(needs, {
      ...NOTHING_PRESENT,
      docker: true,
      sharedIngress: true,
    }),
    [
      "install-docker=ready",
      "install-gateway=pending",
      "start=pending",
      "health=pending",
    ],
  );
  assertEquals(
    idsAndStates(needs, {
      ...NOTHING_PRESENT,
      docker: true,
      sharedIngress: true,
      publicEdge: true,
    })[1],
    "install-gateway=ready",
  );
});

test("a PHP site needing Apache + PHP 8.3 on a bare host", () => {
  const payload = {
    environmentId: "env1",
    projectId: "proj",
    organizationId: "org",
    projectName: "tp-php",
    composeFiles: [],
    generation: 1,
    desiredHash: "a".repeat(64),
    serverId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    replicaCounts: {},
    hostings: [],
    sites: [{
      composeServiceName: "web",
      engine: "apache",
      root: "public",
      listenPort: 18080,
      php: { version: "8.3", settings: {} },
    }],
  } as unknown as EnvironmentDeployPayload;
  const needs = deployStepNeeds(payload, {
    hasContainers: false,
    sharedIngress: false,
    publicEdge: true,
  });
  assertEquals(needs.docker, false);
  assertEquals(needs.webServers, ["apache"]);
  assertEquals(needs.phpSeries, ["8.3"]);
  assertEquals(needs.phpFpm, true);
  assertEquals(needs.sourceBuilds, false);
  assertEquals(needs.buildTool, false);
  const steps = planDeploySteps(needs, {
    ...NOTHING_PRESENT,
    publicEdge: true,
  });
  assertEquals(steps.map((s) => `${s.id}=${s.state}`), [
    "install-gateway=ready",
    "install-web-server:apache=pending",
    "install-php:8.3=pending",
    "start=pending",
    "health=pending",
  ]);
  assertEquals(installStepIds(steps, "install-web-server:"), [
    "install-web-server:apache",
  ]);
  assertEquals(installStepIds(steps, "install-php:"), ["install-php:8.3"]);
  // Apache is on disk but PHP 8.3 is not: only the engine is ready.
  const partial = planDeploySteps(needs, {
    ...NOTHING_PRESENT,
    publicEdge: true,
    webServers: new Set(["apache"]),
    runtimes: { php: { series: ["8.4"] } },
  });
  assertEquals(partial[1].state, "ready");
  assertEquals(partial[2].state, "pending");
});

test("needs from a container payload: docker, build on a cacheless rebuild, certificates, rollbacks", () => {
  const base = {
    environmentId: "env1",
    projectId: "proj",
    organizationId: "org",
    projectName: "tp-app",
    composeFiles: [],
    generation: 1,
    desiredHash: "a".repeat(64),
    serverId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    replicaCounts: {},
    hostings: [],
  };
  const plain = deployStepNeeds(base as unknown as EnvironmentDeployPayload, {
    hasContainers: true,
    sharedIngress: true,
    publicEdge: false,
  });
  assertEquals(plain.docker, true);
  assertEquals(plain.sharedIngress, true);
  assertEquals(plain.composeBuild, false);
  assertEquals(plain.certificates, false);
  assertEquals(planDeploySteps(plain, NOTHING_PRESENT).map((s) => s.id), [
    "install-docker",
    "install-gateway",
    "start",
    "health",
  ]);

  const rich = deployStepNeeds(
    {
      ...base,
      noCache: true,
      tlsMaterial: [{ tlsId: "t1" }],
      sourceMaterial: [
        { composeServiceName: "api", build: { kind: "image" } },
        {
          composeServiceName: "old",
          build: { kind: "native" },
          rollbackToReleaseId: "r1",
        },
      ],
      nativeAppServices: [
        { serviceId: "s1", composeServiceName: "app", nodeVersion: "22" },
        { serviceId: "s2", composeServiceName: "edge", runtime: "deno" },
      ],
    } as unknown as EnvironmentDeployPayload,
    { hasContainers: true, sharedIngress: false, publicEdge: false },
  );
  assertEquals(rich.composeBuild, true);
  assertEquals(rich.certificates, true);
  assertEquals(rich.buildTool, true);
  assertEquals(rich.sourceBuilds, true);
  assertEquals(rich.nodeSeries, ["22"]);
  assertEquals(rich.denoSeries.length, 1);
  assertEquals(planDeploySteps(rich, NOTHING_PRESENT).map((s) => s.id), [
    "install-docker",
    `install-runtime:node-22`,
    `install-runtime:deno-${rich.denoSeries[0]}`,
    "install-build-tool",
    "fetch",
    "build",
    "start",
    "certificates",
    "health",
    "switch",
    "stop-old",
  ]);
  assertEquals(rich.nativeApps, true);
});

test("probeDeployPresence runs only the probes the plan needs and treats a throw as absent", async () => {
  const layout = resolveLayout({
    TURBOPANEL_RUNTIMES_DIR: "/nonexistent/vendor",
  });
  const asked: string[] = [];
  const presence = await probeDeployPresence(
    layout,
    { ...FULL_NEEDS, buildTool: false },
    {
      docker: () => {
        asked.push("docker");
        return Promise.resolve(true);
      },
      sharedIngress: () => {
        asked.push("sharedIngress");
        return Promise.reject(new Error("docker ps failed"));
      },
      publicEdge: () => {
        asked.push("publicEdge");
        return Promise.resolve(true);
      },
      runtimes: () => {
        asked.push("runtimes");
        return { node: { series: ["22"] } };
      },
      fileExists: (path) => {
        asked.push(`stat:${path}`);
        return Promise.resolve(path.endsWith("/apache/current/bin/httpd"));
      },
      buildTool: () => {
        asked.push("buildTool");
        return Promise.resolve(true);
      },
    },
  );
  assertEquals(presence.docker, true);
  assertEquals(presence.sharedIngress, false);
  assertEquals(presence.publicEdge, true);
  assertEquals(presence.runtimes, { node: { series: ["22"] } });
  assertEquals([...presence.webServers], ["apache"]);
  assertEquals(presence.buildTool, false);
  assertEquals(asked.includes("buildTool"), false, "not needed, not probed");
  assertEquals(asked.includes("sharedIngress"), true);

  // A runtimes probe that throws means nothing vendored, not a failed deploy.
  const thrown = await probeDeployPresence(layout, FULL_NEEDS, {
    docker: () => Promise.resolve(true),
    sharedIngress: () => Promise.resolve(true),
    publicEdge: () => Promise.resolve(true),
    runtimes: () => {
      throw new Error("readdir failed");
    },
    fileExists: () => Promise.resolve(true),
    buildTool: () => Promise.resolve(true),
  });
  assertEquals(thrown.runtimes, undefined);

  // Without a reachable engine the shared gateway cannot be running: skipped.
  const noDocker = await probeDeployPresence(layout, FULL_NEEDS, {
    docker: () => Promise.resolve(false),
    sharedIngress: () => {
      throw new Error("must not be asked");
    },
    publicEdge: () => Promise.resolve(false),
    runtimes: () => undefined,
    fileExists: () => Promise.resolve(false),
    buildTool: () => Promise.resolve(false),
  });
  assertEquals(noDocker.sharedIngress, false);
});
