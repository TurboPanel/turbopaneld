import { assertEquals } from "@std/assert";
import { join } from "node:path";
import { resolveLayout } from "../paths/layout.ts";
import type { RunFn } from "./ensure-principal.ts";
import { siteCaddyConfigDir } from "./site/engine-driver.ts";
import {
  createHostProbe,
  type DeployedThings,
  type HostProbe,
  hostStillRunsDeploy,
  usesMutableImageTag,
} from "./unchanged-deploy.ts";

const test = Deno.test.bind(Deno);

const THINGS: DeployedThings = {
  environmentId: "env1",
  projects: ["proj"],
  nativeServiceIds: ["svc1"],
  siteNames: ["blog"],
  currentLinks: ["/srv/users/a/production/services/svc1/current"],
};

function probe(overrides: Partial<HostProbe> = {}): HostProbe {
  return {
    composeStates: () =>
      Promise.resolve({
        expected: ["web"],
        containers: [{ service: "web", state: "running", health: "healthy" }],
      }),
    unitActive: () => Promise.resolve(true),
    pathExists: () => Promise.resolve(true),
    siteConfigNames: () => Promise.resolve(["tp-env1-blog.conf"]),
    ...overrides,
  };
}

test("a host with everything up may skip", async () => {
  assertEquals(await hostStillRunsDeploy(THINGS, probe()), true);
});

test("a stopped, missing or unhealthy container does not allow a skip", async () => {
  for (
    const containers of [
      [{ service: "web", state: "exited" }],
      [],
      [{ service: "web", state: "running", health: "unhealthy" }],
    ]
  ) {
    assertEquals(
      await hostStillRunsDeploy(
        THINGS,
        probe({
          composeStates: () =>
            Promise.resolve({ expected: ["web"], containers }),
        }),
      ),
      false,
    );
  }
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ composeStates: () => Promise.resolve(null) }),
    ),
    false,
  );
});

test("an inactive unit does not allow a skip", async () => {
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ unitActive: () => Promise.resolve(false) }),
    ),
    false,
  );
});

test("a missing current link does not allow a skip", async () => {
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ pathExists: () => Promise.resolve(false) }),
    ),
    false,
  );
});

test("a missing site config does not allow a skip", async () => {
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ siteConfigNames: () => Promise.resolve(["tp-env1-other.conf"]) }),
    ),
    false,
  );
});

test("a probe that throws does not allow a skip", async () => {
  assertEquals(
    await hostStillRunsDeploy(
      THINGS,
      probe({ unitActive: () => Promise.reject(new Error("no systemd")) }),
    ),
    false,
  );
});

test("images without a tag, on latest or set by a variable are mutable; pinned ones are not", () => {
  const compose = (
    image: string,
  ) => [`services:\n  web:\n    image: ${image}\n`];
  assertEquals(usesMutableImageTag(compose("nginx")), true);
  assertEquals(usesMutableImageTag(compose("nginx:latest")), true);
  assertEquals(usesMutableImageTag(compose("ghcr.io/x/y")), true);
  assertEquals(usesMutableImageTag(compose("nginx:${TAG}")), true);
  assertEquals(usesMutableImageTag(compose("nginx:1.27.5")), false);
  assertEquals(usesMutableImageTag(compose("localhost:5000/app:v2")), false);
  assertEquals(
    usesMutableImageTag(compose("nginx@sha256:" + "a".repeat(64))),
    false,
  );
});

function siteProbe(
  root: string,
  run: (command: string, args: string[]) => Promise<
    { success: boolean; stdout: string; stderr: string }
  >,
): HostProbe {
  return createHostProbe({
    layout: resolveLayout({ TURBOPANEL_CONFIG_DIR: root }),
    composePaths: [],
    runDocker: () => Promise.reject(new Error("unused")),
    run: run as RunFn,
  });
}

const noHelper = () => Promise.reject(new Error("helper must not be called"));

test("site configs: a readable folder lists its files without the helper", async () => {
  const root = await Deno.makeTempDir();
  try {
    const layout = resolveLayout({ TURBOPANEL_CONFIG_DIR: root });
    const dir = join(siteCaddyConfigDir(layout), "sites");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(join(dir, "tp-env1-blog.conf"), "x");
    assertEquals(await siteProbe(root, noHelper).siteConfigNames(), [
      "tp-env1-blog.conf",
    ]);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test("site configs: a folder that does not exist has no sites", async () => {
  const root = await Deno.makeTempDir();
  try {
    assertEquals(await siteProbe(root, noHelper).siteConfigNames(), []);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

test({
  name:
    "site configs: a folder the daemon cannot enter is listed by the helper",
  ignore: Deno.uid() === 0,
  fn: async () => {
    const root = await Deno.makeTempDir();
    const layout = resolveLayout({ TURBOPANEL_CONFIG_DIR: root });
    const dir = join(siteCaddyConfigDir(layout), "sites");
    try {
      await Deno.mkdir(dir, { recursive: true });
      await Deno.chmod(dir, 0o000);
      const calls: string[][] = [];
      const listed = siteProbe(root, (_command, args) => {
        calls.push(args);
        return Promise.resolve({
          success: true,
          stdout: "tp-env1-blog.conf\n",
          stderr: "",
        });
      });
      assertEquals(await listed.siteConfigNames(), ["tp-env1-blog.conf"]);
      assertEquals(calls.length, 1);
      assertEquals(
        await hostStillRunsDeploy(THINGS, {
          ...probe(),
          siteConfigNames: listed.siteConfigNames,
        }),
        true,
      );
      // The helper cannot tell either: never a skip.
      const unsure = siteProbe(
        root,
        () => Promise.resolve({ success: false, stdout: "", stderr: "denied" }),
      );
      assertEquals(
        await hostStillRunsDeploy(THINGS, {
          ...probe(),
          siteConfigNames: unsure.siteConfigNames,
        }),
        false,
      );
    } finally {
      await Deno.chmod(dir, 0o755);
      await Deno.remove(root, { recursive: true });
    }
  },
});
