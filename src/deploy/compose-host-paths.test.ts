import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  COMPOSE_STAGE_DIRNAME,
  RUNTIME_COMPOSE_FILENAME,
} from "./compose-files.ts";
import {
  assertComposeHostPathsConfined,
  collectAuthoredHostPaths,
  collectResolvedHostPaths,
  ComposeHostPathError,
  type ComposeHostPathScan,
  priorWritableMounts,
  writableMountSources,
} from "./compose-host-paths.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type Fixture = { root: string; dir: string; stage: string; outside: string };

/** A real deployment dir with `.staging`, plus a sibling dir outside it. */
async function withFixture(fn: (f: Fixture) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-hostpaths-" });
  const dir = join(root, "deployments", "p", "e");
  const stage = join(dir, COMPOSE_STAGE_DIRNAME);
  const outside = join(root, "outside");
  await Deno.mkdir(stage, { recursive: true });
  await Deno.mkdir(outside, { recursive: true });
  try {
    await fn({ root, dir, stage, outside });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** `docker compose config` shape: one service with long-form volumes. */
function binds(...volumes: Record<string, unknown>[]): ComposeHostPathScan {
  return collectResolvedHostPaths({ services: { web: { volumes } } });
}

async function refusal(
  f: Fixture,
  scans: ComposeHostPathScan[],
  extra: { hostLevelApproved?: boolean; priorWritableMounts?: string[] } = {},
): Promise<string> {
  const err = await assertRejects(
    () =>
      assertComposeHostPathsConfined(scans, {
        deploymentDir: f.dir,
        stageDir: f.stage,
        hostLevelApproved: extra.hostLevelApproved ?? false,
        priorWritableMounts: extra.priorWritableMounts,
      }),
    ComposeHostPathError,
  );
  return err.message;
}

function allowed(
  f: Fixture,
  scans: ComposeHostPathScan[],
  extra: { hostLevelApproved?: boolean; priorWritableMounts?: string[] } = {},
): Promise<void> {
  return assertComposeHostPathsConfined(scans, {
    deploymentDir: f.dir,
    stageDir: f.stage,
    hostLevelApproved: extra.hostLevelApproved ?? false,
    priorWritableMounts: extra.priorWritableMounts,
  });
}

test("a symlink inside ./data pointing at / is refused", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data"));
    await Deno.symlink("/", join(f.dir, "data", "escape"));
    const msg = await refusal(f, [
      binds({
        type: "bind",
        source: join(f.stage, "data", "escape"),
        target: "/h",
      }),
    ]);
    assert(msg.includes("resolves through a symlink to /,"), msg);
  }));

test("a symlink inside ./data pointing at /etc is refused, even read-only", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data"));
    await Deno.symlink("/etc", join(f.dir, "data", "etc"));
    const msg = await refusal(f, [
      binds({
        type: "bind",
        source: join(f.stage, "data", "etc"),
        target: "/e",
        read_only: true,
      }),
    ]);
    assert(msg.includes("resolves through a symlink to /etc"), msg);
  }));

test("a symlinked parent directory is refused", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.outside, "sub"));
    await Deno.symlink(f.outside, join(f.dir, "link"));
    const msg = await refusal(f, [
      binds({
        type: "bind",
        source: join(f.stage, "link", "sub"),
        target: "/s",
      }),
    ]);
    assert(
      msg.includes(`resolves through a symlink to ${join(f.outside, "sub")}`),
      msg,
    );
  }));

test("a not-yet-existing leaf under a symlinked dir is refused", () =>
  withFixture(async (f) => {
    await Deno.symlink(f.outside, join(f.dir, "data"));
    const msg = await refusal(f, [
      binds({
        type: "bind",
        source: join(f.stage, "data", "new", "deeper"),
        target: "/n",
      }),
    ]);
    assert(msg.includes(join(f.outside, "new", "deeper")), msg);
  }));

test("`..` after a symlink is cleaned the way Compose cleans it before the engine sees it", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data"));
    await Deno.symlink("/", join(f.dir, "data", "escape"));
    // Compose sends the lexically cleaned `…/data/x`, not a path through
    // `escape`, so this mounts ./data/x inside the deployment dir.
    await allowed(f, [
      collectAuthoredHostPaths(
        "services:\n  web:\n    image: a\n    env_file: [./data/escape/../x.env]\n",
      ),
    ]);
  }));

test("`..` that climbs out of the deployment dir is refused as outside", () =>
  withFixture(async (f) => {
    const msg = await refusal(f, [
      collectAuthoredHostPaths(
        "services:\n  web:\n    image: a\n    env_file: [../../x.env]\n",
      ),
    ]);
    assert(msg.includes("is outside the deployment directory"), msg);
  }));

test("the Docker socket is refused without approval and allowed with it", () =>
  withFixture(async (f) => {
    const scan = binds({
      type: "bind",
      source: "/var/run/docker.sock",
      target: "/var/run/docker.sock",
    });
    const msg = await refusal(f, [scan]);
    assert(msg.includes("Docker engine socket"), msg);
    await allowed(f, [scan], { hostLevelApproved: true });
    const runSock = binds({
      type: "bind",
      source: "/run/docker.sock",
      target: "/s",
    });
    assert((await refusal(f, [runSock])).includes("Docker engine socket"));
  }));

test("an absolute outside path is refused without approval", () =>
  withFixture(async (f) => {
    const scan = binds({ type: "bind", source: "/etc", target: "/e" });
    assert(
      (await refusal(f, [scan])).includes(
        "is outside the deployment directory",
      ),
    );
    await allowed(f, [scan], { hostLevelApproved: true });
  }));

test("host-level approval never excuses a symlink escape from inside", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data"));
    await Deno.symlink("/", join(f.dir, "data", "escape"));
    const msg = await refusal(f, [
      binds({
        type: "bind",
        source: join(f.stage, "data", "escape"),
        target: "/h",
      }),
    ], { hostLevelApproved: true });
    assert(msg.includes("resolves through a symlink"), msg);
  }));

test("plain ./data, nested ./data/sub and a named volume are allowed", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data", "sub"), { recursive: true });
    await allowed(f, [
      binds(
        { type: "bind", source: join(f.stage, "data", "sub"), target: "/s" },
        { type: "volume", source: "cache", target: "/cache" },
      ),
    ]);
    await allowed(f, [
      binds({ type: "bind", source: join(f.stage, "data"), target: "/d" }),
    ]);
  }));

test("a source Docker has yet to create inside the dir is allowed", () =>
  withFixture(async (f) => {
    await allowed(f, [
      binds({
        type: "bind",
        source: join(f.stage, "fresh", "dir"),
        target: "/f",
      }),
    ]);
  }));

test("a bind nested in a writable bind is refused; under a read-only one it is allowed", () =>
  withFixture(async (f) => {
    const nested = {
      type: "bind",
      source: join(f.stage, "data", "sub"),
      target: "/s",
    };
    const msg = await refusal(f, [
      binds(
        { type: "bind", source: join(f.stage, "data"), target: "/d" },
        nested,
      ),
    ]);
    assert(msg.includes("sits inside the writable bind"), msg);
    await allowed(f, [
      binds({
        type: "bind",
        source: join(f.stage, "data"),
        target: "/d",
        read_only: true,
      }, nested),
    ]);
  }));

test("the same source bound twice is not nesting", () =>
  withFixture(async (f) => {
    await allowed(f, [
      binds(
        { type: "bind", source: join(f.stage, "data"), target: "/a" },
        { type: "bind", source: join(f.stage, "data"), target: "/b" },
      ),
    ]);
  }));

test("a new bind under a writable bind of the running generation is refused", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data"));
    const msg = await refusal(
      f,
      [binds({
        type: "bind",
        source: join(f.stage, "data", "later"),
        target: "/l",
      })],
      { priorWritableMounts: [join(f.dir, "data")] },
    );
    assert(msg.includes("sits inside the writable bind"), msg);
  }));

test("the deployment dir itself is refused writable and allowed read-only", () =>
  withFixture(async (f) => {
    const msg = await refusal(f, [
      binds({ type: "bind", source: f.stage, target: "/app" }),
    ]);
    assert(
      msg.includes("mounts the deployment directory itself writable"),
      msg,
    );
    await allowed(f, [
      binds({ type: "bind", source: f.stage, target: "/app", read_only: true }),
    ]);
  }));

test("the daemon's staging directory is refused", () =>
  withFixture(async (f) => {
    const msg = await refusal(f, [
      binds({
        type: "bind",
        source: join(f.stage, COMPOSE_STAGE_DIRNAME),
        target: "/x",
      }),
    ]);
    assert(msg.includes("staging directory"), msg);
  }));

test("an env_file symlinked to a daemon file is refused", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data"));
    await Deno.writeTextFile(join(f.outside, "daemon.env"), "SECRET=1\n");
    await Deno.symlink(
      join(f.outside, "daemon.env"),
      join(f.dir, "data", "leak.env"),
    );
    const msg = await refusal(f, [
      collectAuthoredHostPaths(
        "services:\n  web:\n    image: a\n    env_file:\n      - path: ./data/leak.env\n",
      ),
    ]);
    assert(msg.includes("service web env_file"), msg);
    assert(msg.includes("resolves through a symlink"), msg);
  }));

test("extends.file and include are refused as host-level", () =>
  withFixture(async (f) => {
    const msg = await refusal(f, [
      collectAuthoredHostPaths(
        "include: [./data/more.yaml]\nservices:\n  web:\n    extends: {file: ./data/base.yaml, service: b}\n",
      ),
    ]);
    assert(msg.includes("`include`"), msg);
    assert(msg.includes("`extends.file`"), msg);
    await allowed(f, [
      collectAuthoredHostPaths(
        "services:\n  a: {image: x}\n  web:\n    extends: {service: a}\n",
      ),
    ]);
  }));

test("an interpolated path is refused", () =>
  withFixture(async (f) => {
    const msg = await refusal(f, [
      collectAuthoredHostPaths(
        "services:\n  web:\n    image: a\n    label_file: ${LABELS}\n",
      ),
    ]);
    assert(msg.includes("is interpolated"), msg);
  }));

test("a bind-type driver_opts device is checked; an NFS volume is not", () =>
  withFixture(async (f) => {
    const disguised = collectResolvedHostPaths({
      volumes: {
        d: { driver_opts: { type: "none", o: "bind", device: "/etc" } },
      },
    });
    assert((await refusal(f, [disguised])).includes("volume d device"));
    await allowed(f, [
      collectResolvedHostPaths({
        volumes: {
          n: {
            driver_opts: {
              type: "nfs",
              o: "addr=10.0.0.2",
              device: ":/export",
            },
          },
        },
      }),
    ]);
    const relative = collectResolvedHostPaths({
      volumes: { r: { driver_opts: { o: "bind", device: "rel" } } },
    });
    assert(
      (await refusal(f, [relative])).includes("not an absolute host path"),
    );
  }));

test("config and secret files are checked, except secrets the daemon rewrote", () =>
  withFixture(async (f) => {
    const doc = {
      configs: { c: { file: "/etc/passwd" } },
      secrets: {
        planned: { file: "/run/turbopanel/secrets/x" },
        own: { file: "/etc/shadow" },
      },
    };
    const msg = await refusal(f, [
      collectResolvedHostPaths(doc, new Set(["planned"])),
    ]);
    assert(msg.includes("config c file"), msg);
    assert(msg.includes("secret own file"), msg);
    assert(!msg.includes("secret planned"), msg);
  }));

test("build contexts, Dockerfiles, additional contexts and SSH keys are checked", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "ctx"));
    await Deno.symlink("/", join(f.dir, "ctx", "root"));
    const resolved = collectResolvedHostPaths({
      services: {
        web: {
          build: {
            context: join(f.stage, "ctx"),
            dockerfile: "/etc/Dockerfile",
            additional_contexts: {
              root: join(f.stage, "ctx", "root"),
              img: "docker-image://alpine",
              git: "https://github.com/x/y.git",
            },
          },
        },
      },
    });
    const authored = collectAuthoredHostPaths(
      "services:\n  web:\n    build:\n      context: .\n      ssh: [default, key=/root/.ssh/id_rsa]\n",
    );
    const msg = await refusal(f, [resolved, authored]);
    assert(msg.includes("service web Dockerfile"), msg);
    assert(msg.includes("build context `root`"), msg);
    assert(msg.includes("build SSH key"), msg);
    assert(!msg.includes("`img`") && !msg.includes("`git`"), msg);
  }));

test("an npipe mount is refused", () =>
  withFixture(async (f) => {
    const msg = await refusal(f, [
      binds({ type: "npipe", source: "//./pipe/docker_engine", target: "/p" }),
    ]);
    assert(msg.includes("npipe"), msg);
  }));

test("writableMountSources lists writable binds only", () => {
  assertEquals(
    writableMountSources({
      services: {
        web: {
          volumes: [
            { type: "bind", source: "/d/data", target: "/data" },
            { type: "bind", source: "/d/ro", target: "/ro", read_only: true },
            { type: "volume", source: "named", target: "/n" },
          ],
        },
      },
    }),
    ["/d/data"],
  );
});

test("priorWritableMounts reads the live generation's writable binds", () =>
  withFixture(async (f) => {
    const run = (stdout: string, success = true) => () =>
      Promise.resolve({
        success,
        stdout,
        stderr: success ? "" : "bad",
        code: success ? 0 : 1,
      });
    assertEquals(await priorWritableMounts("p", f.dir, run("{}")), []);

    await Deno.writeTextFile(
      join(f.dir, RUNTIME_COMPOSE_FILENAME),
      "services: {}\n",
    );
    const live = JSON.stringify({
      services: {
        web: {
          volumes: [
            { type: "bind", source: join(f.dir, "data"), target: "/d" },
            {
              type: "bind",
              source: join(f.dir, "ro"),
              target: "/r",
              read_only: true,
            },
          ],
        },
      },
    });
    assertEquals(await priorWritableMounts("p", f.dir, run(live)), [
      join(f.dir, "data"),
    ]);
    assertEquals(await priorWritableMounts("p", f.dir, run("", false)), []);
  }));
