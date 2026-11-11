import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import type { EnvironmentDeploySite } from "../../contracts/commands-contracts.ts";
import { serviceTree } from "../../paths/layout.ts";
import {
  hostFail,
  hostOk,
  makeSystemdHost,
  type SystemdHost,
  type SystemdHostCall,
} from "../../testing/systemd-host.ts";
import { resolveDaemonReleasePaths } from "../release/release-layout.ts";
import { postDeployPassed } from "./post-deploy-marker.ts";
import type { AppliedRelease } from "../release/apply-source-releases.ts";
import type { SiteRelease } from "../site.ts";
import {
  applyDeployWorkers,
  assertSiteLifecyclePhp,
  hasPostDeployWork,
  removeEnvironmentSiteLifecycle,
  runAfterSwitchPostDeploy,
  runBeforeTrafficPostDeploy,
  siteHeldForPostDeploy,
  type SiteLifecycleDeploy,
  type SiteLifecycleIo,
  workerSpecs,
} from "./lifecycle-deploy.ts";
import {
  POST_DEPLOY_BEGIN_MARKER,
  POST_DEPLOY_FAILED_AFTER_SWITCH,
  PostDeployFailedAfterSwitchError,
} from "./post-deploy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const BINDING: SiteRelease = {
  serviceId: "svc1",
  username: "alice",
  folder: { owner: "alice", scope: "production", slug: "web" },
};

function site(
  extra: Partial<EnvironmentDeploySite> = {},
): EnvironmentDeploySite {
  return {
    composeServiceName: "web",
    engine: "apache",
    root: "public",
    listenPort: 18080,
    php: { version: "8.4" },
    principal: {
      principalId: "00000000-0000-4000-8000-000000000001",
      username: "alice",
      uid: 15001,
      gid: 15001,
    },
    ...extra,
  } as EnvironmentDeploySite;
}

function release(extra: Partial<AppliedRelease> = {}): AppliedRelease {
  return {
    composeServiceName: "web",
    serviceId: "svc1",
    releaseId: "rel2",
    commitSha: "abc",
    releaseDir: "/srv/users/alice/production/web/releases/rel2",
    previousReleaseId: "rel1",
    built: true,
    standaloneOutput: false,
    staticExport: false,
    ...extra,
  };
}

function deploy(
  host: SystemdHost,
  sites: EnvironmentDeploySite[],
  applied: AppliedRelease[],
): SiteLifecycleDeploy {
  return {
    layout: host.layout,
    environmentId: "env1",
    sites,
    releaseBindings: new Map([["web", BINDING]]),
    managedBindings: new Map(),
    applied,
  };
}

const COMMANDS = { commands: [["/usr/local/bin/php", "artisan", "migrate"]] };
const UNIT = "turbopanel-deploycmd-env1-web";

function answers(opts: { startOk?: boolean } = {}) {
  return (call: SystemdHostCall) => {
    if (call.tool === "journalctl") {
      return hostOk(
        [
          `2026-11-10T12:00:00+0000 h ${UNIT}[1]: ${POST_DEPLOY_BEGIN_MARKER} rel2`,
          `2026-11-10T12:00:00+0000 h ${UNIT}[1]: migrated`,
          "2026-11-10T12:00:01+0000 h systemd[1]: Finished x.",
        ].join("\n"),
      );
    }
    if (call.tool === "systemctl" && call.args[0] === "start") {
      return opts.startOk === false ? hostFail("Job failed") : hostOk();
    }
    if (call.tool === "systemctl" && call.args[0] === "is-active") {
      return hostOk("active");
    }
    return undefined;
  };
}

function lifecycleIo(host: SystemdHost, lines: string[] = []): SiteLifecycleIo {
  return {
    run: host.run,
    onLine: (_stream, line) => lines.push(line),
    sleep: () => Promise.resolve(),
    systemdUnitDir: host.unitDir,
  };
}

const started = (host: SystemdHost) =>
  host.systemctl().filter((args) => args[0] === "start");

test("a site is held only with before-traffic commands and a release already serving", async () => {
  const host = await makeSystemdHost();
  try {
    const bindings = new Map([["web", BINDING]]);
    const serving = (): Promise<string | null> => Promise.resolve("rel1");
    const held = (sites: EnvironmentDeploySite[], read = serving) =>
      siteHeldForPostDeploy(host.layout, sites, bindings, "web", read);
    assertEquals(await held([site({ postDeploy: COMMANDS })]), true);
    assertEquals(
      await held([
        site({ postDeploy: { ...COMMANDS, timing: "before-traffic" } }),
      ]),
      true,
    );
    // After the switch, no commands, or a first deploy: published normally.
    assertEquals(
      await held([
        site({ postDeploy: { ...COMMANDS, timing: "after-switch" } }),
      ]),
      false,
    );
    assertEquals(await held([site()]), false);
    // A rollback is never held, even for a site with commands and a serving release.
    assertEquals(
      await siteHeldForPostDeploy(
        host.layout,
        [site({ postDeploy: COMMANDS })],
        bindings,
        "web",
        serving,
        true,
      ),
      false,
    );
    assertEquals(
      await held([site({ postDeploy: COMMANDS })], () => Promise.resolve(null)),
      false,
    );
    // A read that fails holds the site: `current` never moves before the commands pass.
    assertEquals(
      await held(
        [site({ postDeploy: COMMANDS })],
        () => Promise.reject(new Error("no")),
      ),
      true,
    );
    // A site that would get no job (no owner, no PHP) is never held.
    assertEquals(
      await held([site({ postDeploy: COMMANDS, principal: undefined })]),
      false,
    );
    assertEquals(
      await held([site({ postDeploy: COMMANDS, php: undefined })]),
      false,
    );
    assertEquals(
      await siteHeldForPostDeploy(
        host.layout,
        [site({ postDeploy: COMMANDS })],
        new Map(),
        "web",
        serving,
      ),
      false,
    );
  } finally {
    await host.cleanup();
  }
});

test("a before-traffic run starts the commands in the new release and then switches the held site", async () => {
  const host = await makeSystemdHost(answers());
  try {
    const swapped: string[] = [];
    const lines: string[] = [];
    const plan = deploy(host, [site({ postDeploy: COMMANDS })], [
      release({ heldCurrent: true }),
    ]);
    await runBeforeTrafficPostDeploy(
      plan,
      lifecycleIo(host, lines),
      (job) => {
        // The commands have run before any switch.
        assertEquals(started(host).length, 1);
        swapped.push(job.release.releaseId);
        return Promise.resolve();
      },
    );
    assertEquals(swapped, ["rel2"]);
    assert(lines.includes("migrated"), lines.join("\n"));
    const text = await Deno.readTextFile(`${host.unitDir}/${UNIT}.service`);
    assert(
      text.includes(
        "WorkingDirectory=/srv/users/alice/production/web/releases/rel2",
      ),
    );
  } finally {
    await host.cleanup();
  }
});

test("a failing before-traffic command fails the deploy with the sentence and switches nothing", async () => {
  const host = await makeSystemdHost(answers({ startOk: false }));
  try {
    let swaps = 0;
    const plan = deploy(host, [site({ postDeploy: COMMANDS })], [
      release({ heldCurrent: true }),
    ]);
    const error = await assertRejects(() =>
      runBeforeTrafficPostDeploy(plan, lifecycleIo(host), () => {
        swaps++;
        return Promise.resolve();
      })
    );
    assertEquals(
      (error as Error).message,
      "Post-deploy commands for site web failed, so the new release was not switched in. The release that was serving keeps serving.",
    );
    assertEquals(swaps, 0);
  } finally {
    await host.cleanup();
  }
});

test("a site whose release was published at once (a first deploy) runs its commands and has nothing to switch", async () => {
  const host = await makeSystemdHost(answers());
  try {
    let swaps = 0;
    const plan = deploy(host, [site({ postDeploy: COMMANDS })], [
      release({ previousReleaseId: null }),
    ]);
    await runBeforeTrafficPostDeploy(plan, lifecycleIo(host), () => {
      swaps++;
      return Promise.resolve();
    });
    assertEquals(started(host).length, 1);
    assertEquals(swaps, 0);
  } finally {
    await host.cleanup();
  }
});

test("a re-sent release runs its commands and is then switched; a failure keeps the serving release", async () => {
  const host = await makeSystemdHost(answers());
  try {
    const swapped: string[] = [];
    const resent = release({ heldCurrent: true });
    await runBeforeTrafficPostDeploy(
      deploy(host, [site({ postDeploy: COMMANDS })], [resent]),
      lifecycleIo(host),
      (job) => {
        swapped.push(job.release.releaseId);
        return Promise.resolve();
      },
    );
    assertEquals(started(host).length, 1);
    assertEquals(swapped, ["rel2"]);
  } finally {
    await host.cleanup();
  }
  const failing = await makeSystemdHost(answers({ startOk: false }));
  try {
    let swaps = 0;
    await assertRejects(() =>
      runBeforeTrafficPostDeploy(
        deploy(failing, [site({ postDeploy: COMMANDS })], [
          release({ heldCurrent: true }),
        ]),
        lifecycleIo(failing),
        () => {
          swaps++;
          return Promise.resolve();
        },
      )
    );
    assertEquals(swaps, 0);
  } finally {
    await failing.cleanup();
  }
});

test("a first deploy retried while current already is that release runs its commands and reports a failure", async () => {
  const retry = () => release({ previousReleaseId: "rel2" });
  const host = await makeSystemdHost(answers());
  try {
    const plan = deploy(host, [site({ postDeploy: COMMANDS })], [retry()]);
    assertEquals(hasPostDeployWork(plan, "before-traffic"), true);
    await runBeforeTrafficPostDeploy(plan, lifecycleIo(host));
    assertEquals(started(host).length, 1);
  } finally {
    await host.cleanup();
  }
  const failing = await makeSystemdHost(answers({ startOk: false }));
  try {
    await assertRejects(() =>
      runBeforeTrafficPostDeploy(
        deploy(failing, [site({ postDeploy: COMMANDS })], [retry()]),
        lifecycleIo(failing),
      )
    );
  } finally {
    await failing.cleanup();
  }
});

test("a passed run leaves a marker in the release's record folder, a failed one does not", async () => {
  const host = await makeSystemdHost(answers());
  try {
    const dir = resolveDaemonReleasePaths(host.layout, {
      serviceId: "svc1",
      releaseId: "rel2",
    }).releaseDir;
    await Deno.mkdir(dir, { recursive: true });
    assertEquals(await postDeployPassed(host.layout, "svc1", "rel2"), false);
    const plan = deploy(host, [site({ postDeploy: COMMANDS })], [release()]);
    await runBeforeTrafficPostDeploy(plan, lifecycleIo(host));
    assertEquals(await postDeployPassed(host.layout, "svc1", "rel2"), true);
  } finally {
    await host.cleanup();
  }
  const failing = await makeSystemdHost(answers({ startOk: false }));
  try {
    const dir = resolveDaemonReleasePaths(failing.layout, {
      serviceId: "svc1",
      releaseId: "rel2",
    }).releaseDir;
    await Deno.mkdir(dir, { recursive: true });
    await assertRejects(() =>
      runBeforeTrafficPostDeploy(
        deploy(failing, [site({ postDeploy: COMMANDS })], [release()]),
        lifecycleIo(failing),
      )
    );
    assertEquals(
      await postDeployPassed(failing.layout, "svc1", "rel2"),
      false,
    );
  } finally {
    await failing.cleanup();
  }
});

test("neither timing runs for a rollback, and each timing runs only its own sites", async () => {
  const host = await makeSystemdHost(answers());
  try {
    const rollback = release({ built: undefined });
    for (const applied of [rollback]) {
      const plan = deploy(host, [site({ postDeploy: COMMANDS })], [applied]);
      assertEquals(hasPostDeployWork(plan, "before-traffic"), false);
      await runBeforeTrafficPostDeploy(plan, lifecycleIo(host));
    }
    const late = deploy(
      host,
      [site({ postDeploy: { ...COMMANDS, timing: "after-switch" } })],
      [release()],
    );
    assertEquals(hasPostDeployWork(late, "before-traffic"), false);
    assertEquals(hasPostDeployWork(late, "after-switch"), true);
    await runBeforeTrafficPostDeploy(late, lifecycleIo(host));
    assertEquals(started(host).length, 0);
    const early = deploy(host, [site({ postDeploy: COMMANDS })], [release()]);
    await runAfterSwitchPostDeploy(early, lifecycleIo(host));
    assertEquals(started(host).length, 0);
  } finally {
    await host.cleanup();
  }
});

test("a site that goes before traffic never moves current when its release was not held", async () => {
  const host = await makeSystemdHost(answers());
  try {
    const swapped: string[] = [];
    const plan = deploy(host, [site({ postDeploy: COMMANDS })], [release()]);
    await runBeforeTrafficPostDeploy(plan, lifecycleIo(host), (job) => {
      swapped.push(job.release.releaseId);
      return Promise.resolve();
    });
    assertEquals(swapped, []);
  } finally {
    await host.cleanup();
  }
});

test("an after-switch run that fails carries both release ids, and the deploy stops there", async () => {
  const host = await makeSystemdHost(answers({ startOk: false }));
  try {
    const plan = deploy(
      host,
      [site({ postDeploy: { ...COMMANDS, timing: "after-switch" } })],
      [release()],
    );
    const error = await assertRejects(
      () => runAfterSwitchPostDeploy(plan, lifecycleIo(host)),
      PostDeployFailedAfterSwitchError,
    );
    const failure = error as PostDeployFailedAfterSwitchError;
    assertEquals(failure.code, POST_DEPLOY_FAILED_AFTER_SWITCH);
    assertEquals(failure.details, {
      composeServiceName: "web",
      failedReleaseId: "rel2",
      previousReleaseId: "rel1",
    });
  } finally {
    await host.cleanup();
  }
});

test("a Laravel release lets its commands write the release's own cache folder", async () => {
  const host = await makeSystemdHost(answers());
  try {
    const plan = deploy(host, [site({ postDeploy: COMMANDS })], [
      release({ frameworkLayout: "laravel" }),
    ]);
    await runBeforeTrafficPostDeploy(plan, lifecycleIo(host));
    const text = await Deno.readTextFile(`${host.unitDir}/${UNIT}.service`);
    assert(
      text.includes(
        "ReadWritePaths=-/srv/users/alice/production/web/releases/rel2/bootstrap/cache",
      ),
      text,
    );
  } finally {
    await host.cleanup();
  }
});

test("commands and workers on a site with no PHP are refused with a plain sentence", () => {
  const noPhp = site({ php: undefined });
  assertThrows(
    () => assertSiteLifecyclePhp([{ ...noPhp, postDeploy: COMMANDS }], "env1"),
    Error,
    "Site web: post-deploy commands and workers run with the site's PHP, and this site has none.",
  );
  assertThrows(
    () =>
      assertSiteLifecyclePhp([
        { ...noPhp, workers: [{ name: "q", command: ["/bin/true"] }] },
      ], "env1"),
    Error,
    "this site has none",
  );
  assertSiteLifecyclePhp([noPhp, site({ postDeploy: COMMANDS })], "env1");
});

test("workers whose service and worker names run together to one unit name are refused before the deploy builds", () => {
  const worker = (name: string) => ({ name, command: ["/bin/true"] });
  assertThrows(
    () =>
      assertSiteLifecyclePhp([
        site({ composeServiceName: "web", workers: [worker("a-b")] }),
        site({ composeServiceName: "web-a", workers: [worker("b")] }),
      ], "env1"),
    Error,
    "would share the unit name",
  );
});

test("workers run in the release lane's current folder with the site's variables", async () => {
  const host = await makeSystemdHost(answers());
  try {
    const plan = deploy(
      host,
      [site({ workers: [{ name: "queue", command: ["/bin/true"] }] })],
      [release()],
    );
    const [only] = workerSpecs(plan);
    assertEquals(
      only?.workingDirectory,
      serviceTree(host.layout, BINDING).currentLink,
    );
    assertEquals(only?.phpSeries, "8.4");
    assert(only?.environmentFile?.endsWith(".env"));
    assertEquals(workerSpecs(deploy(host, [site()], [release()])), []);
  } finally {
    await host.cleanup();
  }
});

test("a worker problem is a warning and never fails the deploy", async () => {
  const host = await makeSystemdHost((call) =>
    call.tool === "systemctl" && call.args[0] === "daemon-reload"
      ? hostFail("reload refused")
      : answers()(call)
  );
  try {
    const lines: string[] = [];
    const warnings = await applyDeployWorkers(
      deploy(
        host,
        [site({ workers: [{ name: "queue", command: ["/bin/true"] }] })],
        [release()],
      ),
      lifecycleIo(host, lines),
    );
    assertEquals(warnings.length, 1);
    assert(warnings[0]?.includes("Workers could not be applied"));
    assert(lines.some((line) => line.includes("reload refused")));
  } finally {
    await host.cleanup();
  }
});

test("applying sweeps the command unit of a site that dropped its commands", async () => {
  const host = await makeSystemdHost(answers());
  try {
    await Deno.writeTextFile(`${host.unitDir}/${UNIT}.service`, "[Service]\n");
    await applyDeployWorkers(
      deploy(host, [site()], [release()]),
      lifecycleIo(host),
    );
    assertEquals(await Array.fromAsync(Deno.readDir(host.unitDir)), []);
  } finally {
    await host.cleanup();
  }
});

test("stopping an environment removes its workers and its command units", async () => {
  const host = await makeSystemdHost(answers());
  try {
    await Deno.writeTextFile(`${host.unitDir}/${UNIT}.service`, "[Service]\n");
    await Deno.writeTextFile(
      `${host.unitDir}/turbopanel-worker-env1-web-queue@.service`,
      "[Service]\n",
    );
    await removeEnvironmentSiteLifecycle(lifecycleIo(host), "env1");
    assertEquals(await Array.fromAsync(Deno.readDir(host.unitDir)), []);
  } finally {
    await host.cleanup();
  }
});
