import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import {
  configHostDirectory,
  materializeConfigFiles,
  plannedConfigFilesMissing,
  pruneStaleConfigFiles,
  removeConfigTree,
  renderConfigFile,
  rewriteComposeConfigFilePaths,
} from "./config-files.ts";
import type {
  EnvironmentDeployConfigFile,
  EnvironmentDeployVariableMaterial,
} from "../contracts/commands-contracts.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno);

const perm = { read: true, write: true };

const PGPASS: EnvironmentDeployConfigFile = {
  composeServiceName: "pgadmin",
  source: "pgadmin_pgpass",
  relativePath: "pgadmin--pgpass",
  parts: [{ text: "db:5432:*:app:" }, { secretKey: "DB_PASSWORD" }, {
    text: "\n",
  }],
};

const TEXT_ONLY: EnvironmentDeployConfigFile = {
  composeServiceName: "pgadmin",
  source: "pgadmin_servers",
  relativePath: "pgadmin--servers",
  parts: [{ text: "{}\n" }],
};

function material(key: string, service = "pgadmin") {
  return {
    key,
    composeServiceName: service,
    forBuild: false,
    forRuntime: false,
    isLiteral: false,
    valueEnvelope: `env-${key}`,
  } satisfies EnvironmentDeployVariableMaterial;
}

const decryptTo = (value: string) => (envelopes: string[]) =>
  Promise.resolve(envelopes.map(() => value));

async function withLayout<T>(
  fn: (layout: { runDir: string }, dir: string) => Promise<T>,
): Promise<T> {
  const root = await Deno.makeTempDir({ prefix: "tp-config-files-" });
  const layout = { runDir: join(root, "run") };
  try {
    return await fn(layout, configHostDirectory(layout, "proj", "env"));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

test("renderConfigFile joins the parts in order and inserts values as they are", () => {
  const values = new Map([["pgadmin::DB_PASSWORD", "{$OTHER}$$x"]]);
  assertEquals(renderConfigFile(PGPASS, values), "db:5432:*:app:{$OTHER}$$x\n");
});

test("renderConfigFile names the file and key, never content, when a value is missing", () => {
  const error = assertThrows(
    () => renderConfigFile(PGPASS, new Map()),
    Error,
    "generated file pgadmin--pgpass: no value for secret DB_PASSWORD",
  );
  assertEquals(error.message.includes("db:5432"), false);
});

test({
  name: "materializeConfigFiles writes 0444 files in a 0700 folder",
  permissions: perm,
  fn: () =>
    withLayout(async (layout, dir) => {
      await materializeConfigFiles(
        layout,
        "proj",
        "env",
        [PGPASS, TEXT_ONLY],
        [material("DB_PASSWORD"), material("DB_PASSWORD")],
        decryptTo("hunter2"),
      );
      const secret = join(dir, "pgadmin--pgpass");
      assertEquals(
        await Deno.readTextFile(secret),
        "db:5432:*:app:hunter2\n",
      );
      assertEquals((await Deno.stat(secret)).mode! & 0o777, 0o444);
      assertEquals((await Deno.stat(dir)).mode! & 0o777, 0o700);
      assertEquals(
        await Deno.readTextFile(join(dir, "pgadmin--servers")),
        "{}\n",
      );
    }),
});

test({
  name: "a text-only file needs no decrypt function and no material",
  permissions: perm,
  fn: () =>
    withLayout(async (layout, dir) => {
      await materializeConfigFiles(
        layout,
        "proj",
        "env",
        [TEXT_ONLY],
        [],
        undefined,
      );
      assertEquals(
        await Deno.readTextFile(join(dir, "pgadmin--servers")),
        "{}\n",
      );
    }),
});

test({
  name:
    "a deploy with a secret key that has no material is refused, nothing written",
  permissions: perm,
  fn: () =>
    withLayout(async (layout) => {
      await assertRejects(
        () =>
          materializeConfigFiles(
            layout,
            "proj",
            "env",
            [TEXT_ONLY, PGPASS],
            [],
            decryptTo("x"),
          ),
        Error,
        "no value for secret DB_PASSWORD",
      );
      assertEquals(
        await plannedConfigFilesMissing(layout, "proj", "env", [
          TEXT_ONLY,
        ]),
        true,
      );
    }),
});

test({
  name:
    "without requireAll a file lacking a value is skipped, never written with a gap",
  permissions: perm,
  fn: () =>
    withLayout(async (layout) => {
      await materializeConfigFiles(
        layout,
        "proj",
        "env",
        [TEXT_ONLY, PGPASS],
        [],
        decryptTo("x"),
        { requireAll: false },
      );
      assertEquals(
        await plannedConfigFilesMissing(layout, "proj", "env", [TEXT_ONLY]),
        false,
      );
      assertEquals(
        await plannedConfigFilesMissing(layout, "proj", "env", [PGPASS]),
        true,
      );
    }),
});

test({
  name: "material for another service does not satisfy a key",
  permissions: perm,
  fn: () =>
    withLayout(async (layout) => {
      await assertRejects(
        () =>
          materializeConfigFiles(
            layout,
            "proj",
            "env",
            [PGPASS],
            [material("DB_PASSWORD", "other")],
            decryptTo("x"),
          ),
        Error,
        "no value for secret DB_PASSWORD",
      );
    }),
});

test({
  name: "unsafe relative paths are refused",
  permissions: perm,
  fn: () =>
    withLayout(async (layout) => {
      for (const relativePath of ["../x", "a/b", "a\\b", ""]) {
        await assertRejects(
          () =>
            materializeConfigFiles(
              layout,
              "proj",
              "env",
              [{ ...TEXT_ONLY, relativePath }],
              [],
              undefined,
            ),
          Error,
          "unsafe generated file relativePath",
        );
      }
    }),
});

test({
  name: "a link at the target or the tmp name is refused and not followed",
  permissions: perm,
  fn: () =>
    withLayout(async (layout, dir) => {
      await Deno.mkdir(dir, { recursive: true, mode: 0o700 });
      const outside = join(dir, "..", "outside");
      await Deno.writeTextFile(outside, "keep");
      await Deno.symlink(outside, join(dir, "pgadmin--servers"));
      await assertRejects(
        () =>
          materializeConfigFiles(
            layout,
            "proj",
            "env",
            [TEXT_ONLY],
            [],
            undefined,
          ),
        Error,
        "refusing a non-regular file",
      );
      await Deno.remove(join(dir, "pgadmin--servers"));
      await Deno.symlink(outside, join(dir, "pgadmin--servers.tmp"));
      await assertRejects(
        () =>
          materializeConfigFiles(
            layout,
            "proj",
            "env",
            [TEXT_ONLY],
            [],
            undefined,
          ),
        Error,
        "refusing a non-regular file",
      );
      assertEquals(await Deno.readTextFile(outside), "keep");
    }),
});

test({
  name:
    "prune keeps planned files, an empty plan and removeConfigTree remove the folder",
  permissions: perm,
  fn: () =>
    withLayout(async (layout) => {
      await materializeConfigFiles(
        layout,
        "proj",
        "env",
        [TEXT_ONLY, { ...TEXT_ONLY, relativePath: "old", source: "old" }],
        [],
        undefined,
      );
      assertEquals(
        await pruneStaleConfigFiles(layout, "proj", "env", [TEXT_ONLY]),
        ["old"],
      );
      assertEquals(
        await plannedConfigFilesMissing(layout, "proj", "env", [TEXT_ONLY]),
        false,
      );
      await removeConfigTree(layout, "proj", "env");
      await removeConfigTree(layout, "proj", "env");
      assertEquals(
        await plannedConfigFilesMissing(layout, "proj", "env", [TEXT_ONLY]),
        true,
      );
    }),
});

test("rewriteComposeConfigFilePaths touches only planned sources", () => {
  const yaml = [
    "configs:",
    "  pgadmin_servers:",
    "    file: /somewhere/else",
    "  authored:",
    "    content: hi",
    "",
  ].join("\n");
  const out = rewriteComposeConfigFilePaths(
    yaml,
    { runDir: "/run/tp" },
    "p",
    "e",
    [TEXT_ONLY],
  );
  assertEquals(
    out.includes("file: /run/tp/deployments/p/e/configs/pgadmin--servers"),
    true,
  );
  assertEquals(out.includes("content: hi"), true);
  assertEquals(
    rewriteComposeConfigFilePaths(yaml, { runDir: "/r" }, "p", "e", []),
    yaml,
  );
});
