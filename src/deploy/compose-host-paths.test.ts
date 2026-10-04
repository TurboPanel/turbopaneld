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
  type HostPathEntry,
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

test("the retained previous deployment is refused, read-only included", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "previous"));
    for (const readOnly of [false, true]) {
      const msg = await refusal(f, [
        binds({
          type: "bind",
          source: join(f.stage, "previous"),
          target: "/x",
          read_only: readOnly,
        }),
      ]);
      assert(msg.includes("retained previous deployment"), msg);
    }
    // A sibling whose name merely starts with `previous` is fine.
    await Deno.mkdir(join(f.dir, "previous-data"));
    await allowed(f, [
      binds({
        type: "bind",
        source: join(f.stage, "previous-data"),
        target: "/x",
      }),
    ]);
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

test("a bind-type driver_opts device is checked; an NFS volume is refused", () =>
  withFixture(async (f) => {
    const disguised = collectResolvedHostPaths({
      volumes: {
        d: { driver_opts: { type: "none", o: "bind", device: "/etc" } },
      },
    });
    assert((await refusal(f, [disguised])).includes("volume d device"));
    assert(
      (await refusal(f, [
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
      ])).includes("volume n sets driver_opts"),
    );
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

test("build paths outside the deployment dir are refused even with host-level approval", () =>
  withFixture(async (f) => {
    const resolved = collectResolvedHostPaths({
      services: {
        web: {
          build: {
            context: f.outside,
            dockerfile: "/etc/Dockerfile",
            additional_contexts: {
              up: join(f.stage, "..", "..", "other"),
              oci: `oci-layout://${f.outside}/oci`,
            },
          },
        },
      },
    });
    const authored = collectAuthoredHostPaths(
      "services:\n  web:\n    build:\n      context: .\n      ssh: [key=/root/.ssh/id_rsa]\n",
    );
    const msg = await refusal(f, [resolved, authored], {
      hostLevelApproved: true,
    });
    for (
      const what of [
        "service web build context `",
        "service web Dockerfile",
        "build context `up`",
        "build context `oci`",
        "build SSH key",
      ]
    ) {
      assert(msg.includes(what), `${what} not refused: ${msg}`);
    }
    assert(msg.includes("build_context_outside_project"), msg);
    assert(!msg.includes("organization owner's opt-in"), msg);
  }));

test("a build context inside the deployment dir is still allowed", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "app"));
    await allowed(f, [
      collectResolvedHostPaths({
        services: { web: { build: { context: join(f.stage, "app") } } },
      }),
    ]);
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

// ---------------------------------------------------------------------------
// Rule tables. These pin the exact scan output and refusal text of every branch
// of the collectors and of the confinement check, so the functions can be split
// into small rules without changing a single accept/reject decision.
// ---------------------------------------------------------------------------

type EntryShape = [what: string, path: string, kind: string, ro: boolean];

function shape(scan: ComposeHostPathScan): EntryShape[] {
  return scan.entries.map((e) => [e.what, e.path, e.kind, e.readOnly]);
}

function servicesDoc(service: Record<string, unknown>) {
  return { services: { web: service } };
}

const SHORT_VOLUME_CASES: Array<
  [label: string, volume: unknown, expected: EntryShape[]]
> = [
  ["relative source", "./data:/d", [
    ["service web volume `./data:/d`", "./data", "mount", false],
  ]],
  ["dot source", ".:/d", [
    ["service web volume `.:/d`", ".", "mount", false],
  ]],
  ["absolute source, ro", "/srv/x:/d:ro", [
    ["service web volume `/srv/x:/d:ro`", "/srv/x", "mount", true],
  ]],
  ["ro among options", "./a:/d:ro,z", [
    ["service web volume `./a:/d:ro,z`", "./a", "mount", true],
  ]],
  ["ro as a later option", "./a:/d:z,ro", [
    ["service web volume `./a:/d:z,ro`", "./a", "mount", false],
  ]],
  ["rw option", "./a:/d:rw", [
    ["service web volume `./a:/d:rw`", "./a", "mount", false],
  ]],
  ["ro-prefixed option is not ro", "./a:/d:rox", [
    ["service web volume `./a:/d:rox`", "./a", "mount", false],
  ]],
  ["named volume", "cache:/d", []],
  ["home-relative source is not a path", "~/x:/d", []],
  ["anonymous volume, no colon", "/only", []],
  ["empty string", "", []],
  ["a number", 5, []],
  ["null", null, []],
  ["an array", ["./a:/d"], []],
  ["volume type", { type: "volume", source: "n", target: "/n" }, []],
  ["tmpfs type", { type: "tmpfs", target: "/t" }, []],
  ["no type", { source: "/x", target: "/t" }, []],
  ["bind, read_only true", {
    type: "bind",
    source: "/srv/y",
    target: "/t",
    read_only: true,
  }, [["service web volume /t", "/srv/y", "mount", true]]],
  ["bind, read_only truthy string is writable", {
    type: "bind",
    source: "/srv/y",
    target: "/t",
    read_only: "true",
  }, [["service web volume /t", "/srv/y", "mount", false]]],
  ["bind with no target", { type: "bind", source: "/srv/y" }, [
    ["service web volume ?", "/srv/y", "mount", false],
  ]],
  ["bind with a non-string target", {
    type: "bind",
    source: "/srv/y",
    target: 3,
  }, [
    ["service web volume ?", "/srv/y", "mount", false],
  ]],
];

for (const [label, volume, expected] of SHORT_VOLUME_CASES) {
  test(`collectResolvedHostPaths volume: ${label}`, () => {
    const scan = collectResolvedHostPaths(servicesDoc({ volumes: [volume] }));
    assertEquals(shape(scan), expected);
    assertEquals(scan.findings, []);
  });
}

const VOLUME_FINDING_CASES: Array<
  [label: string, volume: unknown, expected: string[]]
> = [
  ["npipe", { type: "npipe", source: "x", target: "/p" }, [
    "service web volume uses an npipe mount, which is not supported",
  ]],
  ["bind without a source", { type: "bind", target: "/t" }, [
    "service web volume /t has no bind source",
  ]],
  ["bind with a non-string source", { type: "bind", source: 4, target: "/t" }, [
    "service web volume /t has no bind source",
  ]],
  ["bind without source or target", { type: "bind" }, [
    "service web volume ? has no bind source",
  ]],
];

for (const [label, volume, expected] of VOLUME_FINDING_CASES) {
  test(`collectResolvedHostPaths volume finding: ${label}`, () => {
    const scan = collectResolvedHostPaths(servicesDoc({ volumes: [volume] }));
    assertEquals(scan.entries, []);
    assertEquals(scan.findings, expected);
  });
}

test("collectResolvedHostPaths ignores volumes that are not a list", () => {
  for (const volumes of [undefined, null, "./a:/d", { a: "./a:/d" }, 7]) {
    const scan = collectResolvedHostPaths(servicesDoc({ volumes }));
    assertEquals(scan, { entries: [], findings: [] });
  }
});

test("collectResolvedHostPaths keeps the order of mixed volume shapes", () => {
  const scan = collectResolvedHostPaths(servicesDoc({
    volumes: [
      "./a:/a",
      { type: "npipe", target: "/n" },
      { type: "bind", source: "/b", target: "/b" },
      "named:/n",
      { type: "bind", target: "/nosrc" },
    ],
  }));
  assertEquals(shape(scan), [
    ["service web volume `./a:/a`", "./a", "mount", false],
    ["service web volume /b", "/b", "mount", false],
  ]);
  assertEquals(scan.findings, [
    "service web volume uses an npipe mount, which is not supported",
    "service web volume /nosrc has no bind source",
  ]);
});

const BUILD_CASES: Array<
  [label: string, build: unknown, expected: EntryShape[]]
> = [
  ["a string build", "./ctx", []],
  ["null build", null, []],
  ["an array build", [{ context: "." }], []],
  ["an empty build", {}, []],
  ["local context", { context: "./ctx" }, [
    ["service web build context", "./ctx", "read", true],
  ]],
  ["non-string context", { context: 5, dockerfile: "Dockerfile" }, []],
  ["https context is remote", {
    context: "https://example.test/x.git",
    dockerfile: "Dockerfile",
  }, []],
  ["uppercase scheme is remote", { context: "GIT+SSH://host/x" }, []],
  ["git@ context is remote", { context: "git@host:x/y.git" }, []],
  ["service: context is another image", { context: "service:base" }, []],
  ["target: context is another image", { context: "target:base" }, []],
  ["scheme-less host is a path", { context: "host:5000/x" }, [
    ["service web build context", "host:5000/x", "read", true],
  ]],
  ["relative dockerfile joins the context", {
    context: "./ctx",
    dockerfile: "build/Dockerfile",
  }, [
    ["service web build context", "./ctx", "read", true],
    ["service web Dockerfile", "ctx/build/Dockerfile", "read", true],
  ]],
  ["absolute dockerfile stands alone", {
    context: "./ctx",
    dockerfile: "/etc/Dockerfile",
  }, [
    ["service web build context", "./ctx", "read", true],
    ["service web Dockerfile", "/etc/Dockerfile", "read", true],
  ]],
  ["dockerfile without a context is ignored", { dockerfile: "Dockerfile" }, []],
  ["non-string dockerfile is ignored", { context: ".", dockerfile: 1 }, [
    ["service web build context", ".", "read", true],
  ]],
  ["additional contexts", {
    additional_contexts: {
      local: "./other",
      abs: "/srv/other",
      oci: "oci-layout:///srv/oci",
      ociRel: "oci-layout://./oci",
      img: "docker-image://alpine",
      git: "https://example.test/x.git",
      gitAt: "git@host:x/y.git",
      svc: "service:base",
      num: 3,
    },
  }, [
    ["service web build context `local`", "./other", "read", true],
    ["service web build context `abs`", "/srv/other", "read", true],
    ["service web build context `oci`", "/srv/oci", "read", true],
    ["service web build context `ociRel`", "./oci", "read", true],
  ]],
  ["additional contexts that are not a map", {
    additional_contexts: ["./a"],
  }, []],
  ["additional contexts next to a remote main context", {
    context: "https://example.test/x.git",
    additional_contexts: { a: "./a" },
  }, [["service web build context `a`", "./a", "read", true]]],
];

for (const [label, build, expected] of BUILD_CASES) {
  test(`collectResolvedHostPaths build: ${label}`, () => {
    const scan = collectResolvedHostPaths(servicesDoc({ build }));
    assertEquals(shape(scan), expected);
    assertEquals(scan.findings, []);
  });
}

test("collectResolvedHostPaths skips services that are not maps and tolerates a bare document", () => {
  assertEquals(
    collectResolvedHostPaths({ services: { a: "x", b: null, c: [1] } }),
    { entries: [], findings: [] },
  );
  assertEquals(collectResolvedHostPaths({ services: [1] }), {
    entries: [],
    findings: [],
  });
  assertEquals(collectResolvedHostPaths({}), { entries: [], findings: [] });
});

test("collectResolvedHostPaths top-level volume rules", () => {
  const scan = collectResolvedHostPaths({
    volumes: {
      plain: {},
      noDriverOpts: { driver: "local" },
      notMap: "x",
      nfs: { driver_opts: { type: "nfs", o: "addr=1.2.3.4", device: ":/e" } },
      bindO: { driver_opts: { o: "bind", device: "/srv/a" } },
      bindOSpaced: { driver_opts: { o: "rw, bind ,ro", device: "/srv/b" } },
      typeNone: { driver_opts: { type: "none", device: "/srv/c" } },
      oNotString: { driver_opts: { o: 5, type: "none", device: "/srv/d" } },
      relDevice: { driver_opts: { o: "bind", device: "rel" } },
      noDevice: { driver_opts: { o: "bind" } },
      numDevice: { driver_opts: { type: "none", device: 9 } },
    },
  });
  assertEquals(shape(scan), [
    ["volume bindO device", "/srv/a", "mount", false],
    ["volume bindOSpaced device", "/srv/b", "mount", true],
    ["volume typeNone device", "/srv/c", "mount", false],
    ["volume oNotString device", "/srv/d", "mount", false],
  ]);
  assertEquals(scan.findings, [
    "volume nfs sets driver_opts the platform does not allow (only a tmpfs with size, mode, uid or gid, or a host-approved bind, is supported)",
    "volume relDevice binds a device that is not an absolute host path",
    "volume noDevice binds a device that is not an absolute host path",
    "volume numDevice binds a device that is not an absolute host path",
  ]);
  assertEquals(collectResolvedHostPaths({ volumes: ["a"] }).entries, []);
});

test("collectResolvedHostPaths config and secret rules", () => {
  const scan = collectResolvedHostPaths({
    configs: {
      a: { file: "/c/a" },
      b: { content: "x" },
      c: { file: 5 },
      d: "x",
    },
    secrets: {
      own: { file: "/s/own" },
      planned: { file: "/s/planned" },
      env: { environment: "X" },
    },
  }, new Set(["planned", "a"]));
  assertEquals(shape(scan), [
    ["config a file", "/c/a", "mount", true],
    ["secret own file", "/s/own", "mount", true],
  ]);
  assertEquals(
    collectResolvedHostPaths({ configs: [1], secrets: "x" }).entries,
    [],
  );
});

test("collectAuthoredHostPaths parse and shape rules", () => {
  assertEquals(collectAuthoredHostPaths("a: [unterminated"), {
    entries: [],
    findings: ["the compose document could not be parsed"],
  });
  for (const yaml of ["", "- a\n- b\n", "just text\n", "42\n", "null\n"]) {
    assertEquals(collectAuthoredHostPaths(yaml), { entries: [], findings: [] });
  }
  assertEquals(collectAuthoredHostPaths("services: [1]\n"), {
    entries: [],
    findings: [],
  });
  assertEquals(
    collectAuthoredHostPaths("services:\n  a: x\n  b: null\n  c: [1]\n"),
    { entries: [], findings: [] },
  );
});

test("collectAuthoredHostPaths include and extends rules", () => {
  const include = collectAuthoredHostPaths("include: [./a.yaml]\n").findings;
  assertEquals(include.length, 1);
  assertEquals(
    include[0].startsWith(
      "`include` pulls another Compose file from the host — host-level Compose features need",
    ),
    true,
  );
  for (const yaml of ["include: ~\n", "include:\n", "services: {}\n"]) {
    assertEquals(collectAuthoredHostPaths(yaml).findings, []);
  }
  // Any non-null include value is refused, even an empty one.
  assertEquals(collectAuthoredHostPaths("include: []\n").findings.length, 1);
  assertEquals(collectAuthoredHostPaths("include: ''\n").findings.length, 1);

  const extendsFile = collectAuthoredHostPaths(
    "services:\n  web:\n    extends: {file: ./b.yaml, service: b}\n",
  ).findings;
  assertEquals(extendsFile.length, 1);
  assertEquals(
    extendsFile[0].startsWith(
      "service web `extends.file` pulls another Compose file from the host — ",
    ),
    true,
  );
  for (
    const svc of [
      "extends: {service: a}",
      "extends: a",
      "extends: [{file: x}]",
      "extends: null",
    ]
  ) {
    assertEquals(
      collectAuthoredHostPaths(`services:\n  web:\n    ${svc}\n`).findings,
      [],
    );
  }
  // A null `file` key still counts as present.
  assertEquals(
    collectAuthoredHostPaths(
      "services:\n  web:\n    extends: {file: ~, service: a}\n",
    ).findings.length,
    1,
  );
});

test("collectAuthoredHostPaths env_file and label_file rules", () => {
  const scan = collectAuthoredHostPaths(
    [
      "services:",
      "  web:",
      "    env_file: ./one.env",
      "    label_file:",
      "      - ./l1",
      "      - path: ./l2",
      "        required: false",
      "      - {other: x}",
      "      - 5",
      "  db:",
      "    env_file:",
      "      - ./a.env",
      "      - path: /abs.env",
      "  nul:",
      "    env_file: ~",
      "    label_file:",
      "  num:",
      "    env_file: 7",
      "",
    ].join("\n"),
  );
  assertEquals(shape(scan), [
    ["service web env_file", "./one.env", "read", true],
    ["service web label_file", "./l1", "read", true],
    ["service web label_file", "./l2", "read", true],
    ["service db env_file", "./a.env", "read", true],
    ["service db env_file", "/abs.env", "read", true],
  ]);
  assertEquals(scan.findings, []);
});

test("collectAuthoredHostPaths build.ssh rules", () => {
  const scan = collectAuthoredHostPaths(
    [
      "services:",
      "  list:",
      "    build:",
      "      ssh: [default, 'k=/root/.ssh/id', 'a=b=c', 4]",
      "  map:",
      "    build:",
      "      ssh: {default: ~, k: /keys/one, n: 5}",
      "  scalar:",
      "    build:",
      "      ssh: default",
      "  none:",
      "    build:",
      "      context: .",
      "  strbuild:",
      "    build: ./ctx",
      "",
    ].join("\n"),
  );
  assertEquals(shape(scan), [
    ["service list build SSH key", "/root/.ssh/id", "read", true],
    ["service list build SSH key", "b=c", "read", true],
    ["service map build SSH key", "/keys/one", "read", true],
  ]);
});

test("collectAuthoredHostPaths keeps finding order: include, then per service", () => {
  const scan = collectAuthoredHostPaths(
    [
      "include: [x.yaml]",
      "services:",
      "  a:",
      "    extends: {file: e.yaml, service: s}",
      "    env_file: ./a.env",
      "    build: {ssh: ['k=/k']}",
      "",
    ].join("\n"),
  );
  assertEquals(scan.findings.length, 2);
  assertEquals(scan.findings[0].startsWith("`include`"), true);
  assertEquals(scan.findings[1].startsWith("service a `extends.file`"), true);
  assertEquals(shape(scan), [
    ["service a env_file", "./a.env", "read", true],
    ["service a build SSH key", "/k", "read", true],
  ]);
});

// -- confinement ------------------------------------------------------------

function entryScan(
  ...entries: Array<Partial<HostPathEntry> & { path: string }>
) {
  return {
    entries: entries.map((e) => ({
      what: e.what ?? "thing",
      path: e.path,
      kind: e.kind ?? "mount",
      readOnly: e.readOnly ?? false,
    })),
    findings: [],
  } satisfies ComposeHostPathScan;
}

async function findingsOf(
  f: Fixture,
  scans: ComposeHostPathScan[],
  extra: {
    hostLevelApproved?: boolean;
    priorWritableMounts?: string[];
    realPath?: (path: string) => Promise<string>;
  } = {},
): Promise<readonly string[]> {
  const err = await assertRejects(
    () =>
      assertComposeHostPathsConfined(scans, {
        deploymentDir: f.dir,
        stageDir: f.stage,
        hostLevelApproved: extra.hostLevelApproved ?? false,
        priorWritableMounts: extra.priorWritableMounts,
        realPath: extra.realPath,
      }),
    ComposeHostPathError,
  );
  return err.findings;
}

const NOTE =
  "host-level Compose features need an organization owner's opt-in and a manager's deploy";

test("confinement: an interpolated path is refused before anything else", () =>
  withFixture(async (f) => {
    const findings = await findingsOf(f, [
      entryScan({ what: "x", path: "/etc/${DIR}", kind: "read" }),
    ], { hostLevelApproved: true });
    assertEquals(findings, [
      "x `/etc/${DIR}` is interpolated, so where it points cannot be checked",
    ]);
  }));

test("confinement: relative paths resolve against the staging directory", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data"));
    await allowed(f, [
      entryScan({ path: "./data" }),
      entryScan({ path: "fresh/x" }),
    ]);
    await allowed(f, [entryScan({ path: "data/../data/./sub" })]);
    assertEquals(
      await findingsOf(f, [entryScan({ what: "w", path: "../up" })]),
      [`w \`../up\` is outside the deployment directory — ${NOTE}`],
    );
    // A sibling whose name merely starts with the staging directory's is outside.
    assertEquals(
      await findingsOf(f, [
        entryScan({ what: "w", path: `${f.stage}-evil/x` }),
      ]),
      [`w \`${f.stage}-evil/x\` is outside the deployment directory — ${NOTE}`],
    );
  }));

test("confinement: host-level approval only lifts lexically-outside paths", () =>
  withFixture(async (f) => {
    const outside = entryScan(
      { path: "/etc" },
      { path: "../up" },
      { path: "/var/run/docker.sock" },
      { path: "/run/docker.sock", kind: "read" },
    );
    assertEquals((await findingsOf(f, [outside])).length, 4);
    await allowed(f, [outside], { hostLevelApproved: true });
  }));

test("confinement: refusal texts and order across one deploy", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data"));
    await Deno.symlink(f.outside, join(f.dir, "data", "esc"));
    const escape = join(f.stage, "data", "esc");
    const stagingDir = join(f.stage, COMPOSE_STAGE_DIRNAME);
    const scans: ComposeHostPathScan[] = [
      { entries: [], findings: ["scan finding"] },
      entryScan(
        { what: "a", path: "/var/run/docker.sock" },
        { what: "b", path: "/etc" },
        { what: "c", path: escape },
        { what: "d", path: stagingDir },
        { what: "e", path: f.stage },
        { what: "g", path: join(f.stage, "$X") },
      ),
    ];
    assertEquals(await findingsOf(f, scans), [
      "scan finding",
      `a \`/var/run/docker.sock\` is the Docker engine socket — ${NOTE}`,
      `b \`/etc\` is outside the deployment directory — ${NOTE}`,
      `c \`${escape}\` resolves through a symlink to ${await Deno.realPath(
        f.outside,
      )}, outside the deployment directory`,
      `d \`${stagingDir}\` is the daemon's staging directory`,
      `e \`${f.stage}\` mounts the deployment directory itself writable, which would let a container rewrite ${RUNTIME_COMPOSE_FILENAME}`,
      `g \`${
        join(f.stage, "$X")
      }\` is interpolated, so where it points cannot be checked`,
    ]);
  }));

test("confinement: read entries may touch the deployment and staging directories", () =>
  withFixture(async (f) => {
    await allowed(f, [
      entryScan(
        { path: f.stage, kind: "read" },
        { path: join(f.stage, COMPOSE_STAGE_DIRNAME), kind: "read" },
        { path: f.stage, kind: "mount", readOnly: true },
      ),
    ]);
  }));

test("confinement: a symlink that resolves inside the deployment dir is allowed", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "real"));
    await Deno.symlink(join(f.dir, "real"), join(f.dir, "alias"));
    await allowed(f, [entryScan({ path: join(f.stage, "alias", "x") })]);
  }));

test("confinement: a symlink into the staging directory is refused for mounts only", () =>
  withFixture(async (f) => {
    await Deno.symlink(join(f.dir, COMPOSE_STAGE_DIRNAME), join(f.dir, "stg"));
    const path = join(f.stage, "stg");
    assertEquals(
      await findingsOf(f, [entryScan({ what: "m", path })]),
      [`m \`${path}\` is the daemon's staging directory`],
    );
    await allowed(f, [entryScan({ path, kind: "read" })]);
  }));

test("confinement: a resolution error other than not-found is reported and does not stop the scan", () =>
  withFixture(async (f) => {
    const realDir = await Deno.realPath(f.dir);
    const boom = join(realDir, "boom");
    const realPath = (p: string): Promise<string> =>
      p === boom
        ? Promise.reject(new Deno.errors.PermissionDenied("nope"))
        : Deno.realPath(p);
    const findings = await findingsOf(f, [
      entryScan(
        { what: "x", path: join(f.stage, "boom") },
        { what: "y", path: "/etc" },
      ),
    ], { realPath });
    assertEquals(findings, [
      `x \`${join(f.stage, "boom")}\` cannot be resolved on this host (nope)`,
      `y \`/etc\` is outside the deployment directory — ${NOTE}`,
    ]);
  }));

test("confinement: entries are resolved one at a time, in entry order", () =>
  withFixture(async (f) => {
    let inFlight = 0;
    let maxInFlight = 0;
    const order: string[] = [];
    const realPath = async (p: string): Promise<string> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      order.push(p);
      await new Promise((resolve) => setTimeout(resolve, 3));
      try {
        return await Deno.realPath(p);
      } finally {
        inFlight--;
      }
    };
    await assertComposeHostPathsConfined(
      [entryScan({ path: "one" }, { path: "two" }, { path: "three" })],
      {
        deploymentDir: f.dir,
        stageDir: f.stage,
        hostLevelApproved: false,
        realPath,
      },
    );
    assertEquals(maxInFlight, 1);
    const firstTouch = ["one", "two", "three"].map((name) =>
      order.findIndex((p) => p.endsWith(`/${name}`))
    );
    assertEquals(firstTouch.every((i) => i >= 0), true);
    assertEquals(firstTouch.toSorted((a, b) => a - b), firstTouch);
  }));

test("confinement: a missing deployment directory rejects with the raw error", () =>
  withFixture(async (f) => {
    await assertRejects(
      () =>
        assertComposeHostPathsConfined([entryScan({ path: "a" })], {
          deploymentDir: join(f.root, "absent"),
          stageDir: f.stage,
          hostLevelApproved: false,
        }),
      Deno.errors.NotFound,
    );
  }));

test("confinement: nesting rules for writable binds", () =>
  withFixture(async (f) => {
    const data = join(f.stage, "data");
    const sub = join(data, "sub");
    // read-only entry under a writable mount is still refused
    assertEquals(
      await findingsOf(f, [
        entryScan(
          { what: "w", path: data },
          { what: "r", path: sub, kind: "read", readOnly: true },
        ),
      ]),
      [
        `r \`${sub}\` sits inside the writable bind ${
          join(await Deno.realPath(f.dir), "data")
        }, where a container could replace part of its path with a symlink`,
      ],
    );
    // a read entry is not a writable holder, whatever its readOnly flag says
    await allowed(f, [
      entryScan(
        { path: data, kind: "read", readOnly: false },
        { path: sub },
      ),
    ]);
    // the same path twice is not strictly within itself
    await allowed(f, [entryScan({ path: data }, { path: data })]);
    // a sibling that only shares a name prefix is not nested
    await allowed(f, [
      entryScan({ path: data }, { path: join(f.stage, "data2", "x") }),
    ]);
  }));

test("confinement: prior writable mounts resolve through symlinks and tolerate errors", () =>
  withFixture(async (f) => {
    await Deno.mkdir(join(f.dir, "data"));
    await Deno.symlink(join(f.dir, "data"), join(f.dir, "alias"));
    const sub = join(f.stage, "data", "n");
    // holder given via a symlink resolves to the same directory
    const findings = await findingsOf(
      f,
      [entryScan({ what: "n", path: sub })],
      {
        priorWritableMounts: [join(f.dir, "alias")],
      },
    );
    assertEquals(findings.length, 1);
    assert(findings[0].includes("sits inside the writable bind"), findings[0]);
    // a prior mount that cannot be resolved falls back to its own path
    const flaky = join(await Deno.realPath(f.dir), "flaky");
    let flakyCalls = 0;
    const realPath = (p: string): Promise<string> => {
      if (p === flaky && ++flakyCalls > 1) {
        return Promise.reject(new Deno.errors.PermissionDenied("x"));
      }
      return Deno.realPath(p);
    };
    const viaFallback = await findingsOf(
      f,
      [entryScan({ what: "n", path: join(f.stage, "flaky", "n") })],
      { priorWritableMounts: [flaky], realPath },
    );
    assertEquals(viaFallback.length, 1);
    assert(
      viaFallback[0].includes(`writable bind ${flaky},`),
      viaFallback[0],
    );
    // no holders at all is fine
    await allowed(f, [entryScan({ path: sub })], { priorWritableMounts: [] });
  }));

test("confinement: nothing to check passes, findings of every scan are joined", () =>
  withFixture(async (f) => {
    await allowed(f, []);
    await allowed(f, [{ entries: [], findings: [] }]);
    assertEquals(
      await findingsOf(f, [
        { entries: [], findings: ["one"] },
        { entries: [], findings: ["two", "three"] },
      ]),
      ["one", "two", "three"],
    );
    const err = await assertRejects(
      () =>
        assertComposeHostPathsConfined([{ entries: [], findings: ["one"] }], {
          deploymentDir: f.dir,
          stageDir: f.stage,
          hostLevelApproved: true,
        }),
      ComposeHostPathError,
    );
    assertEquals(
      err.message,
      "compose deploy refused — host paths outside this deployment: one",
    );
  }));
