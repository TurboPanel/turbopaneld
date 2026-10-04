import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeployVariableMaterial,
} from "../../contracts/commands-contracts.ts";
import {
  materializeNativeAppVariables,
  NATIVE_APP_ENV_DIR_MODE,
  NATIVE_APP_ENV_FILE_MODE,
  removeNativeAppEnvFile,
  renderNativeAppEnvFile,
  renderNativeAppEnvLine,
  resolveNativeAppVariables,
} from "./variables-runtime.ts";
import { nativeAppEnvPath } from "./unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const app: EnvironmentDeployNativeAppService = {
  composeServiceName: "api",
  serviceId: "svc-1",
  listenPort: 4100,
  framework: "node",
  variables: [
    { name: "ZED", value: "last" },
    { name: "API_URL", value: "https://example.test" },
    { name: "DB_PASSWORD", secretKey: "DB_PASSWORD" },
  ],
};

function sealed(
  key: string,
  envelope: string,
  composeServiceName: string | null = "api",
): EnvironmentDeployVariableMaterial {
  return {
    key,
    composeServiceName,
    forBuild: false,
    forRuntime: true,
    isLiteral: false,
    valueEnvelope: envelope,
  };
}

/** Pretends the daemon's decrypt endpoint: `tpdaemon.<x>` opens to `<x>`. */
const decryptSecrets = (envelopes: string[]) =>
  Promise.resolve(
    envelopes.map((e) => (e.startsWith("tpdaemon.") ? e.slice(9) : null)),
  );

async function withConfig<T>(
  fn: (layout: { configDir: string }) => Promise<T>,
): Promise<T> {
  const configDir = await Deno.makeTempDir({ prefix: "tp-native-env-" });
  try {
    return await fn({ configDir });
  } finally {
    await Deno.remove(configDir, { recursive: true });
  }
}

test("resolveNativeAppVariables merges plain and decrypted secret values, sorted", async () => {
  const resolved = await resolveNativeAppVariables(
    app,
    [sealed("DB_PASSWORD", "tpdaemon.hunter2")],
    decryptSecrets,
  );
  assertEquals(resolved.entries, [
    { name: "API_URL", value: "https://example.test" },
    { name: "DB_PASSWORD", value: "hunter2" },
    { name: "ZED", value: "last" },
  ]);
  assertEquals(resolved.platformManaged, []);
});

test("resolveNativeAppVariables only opens the envelopes this app asked for", async () => {
  const seen: string[][] = [];
  await resolveNativeAppVariables(
    app,
    [
      sealed("DB_PASSWORD", "tpdaemon.mine"),
      sealed("DB_PASSWORD", "tpdaemon.other-service", "worker"),
      sealed("UNRELATED", "tpdaemon.nope"),
    ],
    (envelopes) => {
      seen.push(envelopes);
      return decryptSecrets(envelopes);
    },
  );
  assertEquals(seen, [["tpdaemon.mine"]]);
});

test("resolveNativeAppVariables never lets a tenant replace a platform-set name", async () => {
  const resolved = await resolveNativeAppVariables(
    {
      ...app,
      variables: [
        { name: "PORT", value: "1" },
        { name: "PATH", value: "/evil" },
        { name: "NODE_ENV", value: "development" },
        { name: "KEEP", value: "yes" },
      ],
    },
    [],
    decryptSecrets,
  );
  assertEquals(resolved.entries, [{ name: "KEEP", value: "yes" }]);
  assertEquals(resolved.platformManaged, ["PORT", "PATH", "NODE_ENV"]);
});

test("resolveNativeAppVariables fails loudly, naming the variable and never its value", async () => {
  await assertRejects(
    () => resolveNativeAppVariables(app, [], decryptSecrets),
    Error,
    "no sealed value for secret variable DB_PASSWORD",
  );
  await assertRejects(
    () =>
      resolveNativeAppVariables(
        app,
        [sealed("DB_PASSWORD", "garbage")],
        decryptSecrets,
      ),
    Error,
    "failed to decrypt secret variable DB_PASSWORD",
  );
  await assertRejects(
    () =>
      resolveNativeAppVariables(
        app,
        [sealed("DB_PASSWORD", "tpdaemon.x")],
        undefined,
      ),
    Error,
    "decrypt is unavailable",
  );
});

test("an app with only plain values needs no decrypt call", async () => {
  const resolved = await resolveNativeAppVariables(
    { ...app, variables: [{ name: "A", value: "1" }] },
    [],
    undefined,
  );
  assertEquals(resolved.entries, [{ name: "A", value: "1" }]);
});

test("env lines keep every value literal: single quotes, or escaped double quotes", () => {
  assertEquals(
    renderNativeAppEnvLine({ name: "A", value: "plain" }),
    "A='plain'",
  );
  assertEquals(renderNativeAppEnvLine({ name: "A", value: "" }), "A=''");
  // `$`, backslash and `%` mean nothing inside single quotes.
  assertEquals(
    renderNativeAppEnvLine({ name: "A", value: String.raw`p$ss\w%rd #x` }),
    String.raw`A='p$ss\w%rd #x'`,
  );
  // A value holding a single quote switches to double quotes and escapes the
  // four characters systemd reads specially there.
  assertEquals(
    renderNativeAppEnvLine({
      name: "A",
      value: String.raw`it's "$HOME" \ ` + "`x`",
    }),
    String.raw`A="it's \"\$HOME\" \\ ` + '\\`x\\`"',
  );
  const file = renderNativeAppEnvFile([{ name: "A", value: "1" }]);
  assertEquals(file.split("\n")[0].startsWith("# Managed by TurboPanel"), true);
  assertEquals(file.endsWith("A='1'\n"), true);
});

test("materializeNativeAppVariables writes a 0600 file in a 0700 directory", async () => {
  await withConfig(async (layout) => {
    const result = await materializeNativeAppVariables(
      layout,
      app,
      [sealed("DB_PASSWORD", "tpdaemon.hunter2")],
      decryptSecrets,
    );
    assertEquals(result.environmentFile, true);
    assertEquals(result.count, 3);
    const path = nativeAppEnvPath(layout, "svc-1");
    const text = await Deno.readTextFile(path);
    assertStringIncludes(text, "DB_PASSWORD='hunter2'\n");
    assertStringIncludes(text, "API_URL='https://example.test'\n");
    if (Deno.build.os !== "windows") {
      assertEquals(
        (await Deno.stat(path)).mode! & 0o777,
        NATIVE_APP_ENV_FILE_MODE,
      );
      assertEquals(
        (await Deno.stat(join(layout.configDir, "node-apps", "envs"))).mode! &
          0o777,
        NATIVE_APP_ENV_DIR_MODE,
      );
    }
    // No temp file is left behind next to it.
    const names = [
      ...Deno.readDirSync(join(layout.configDir, "node-apps", "envs")),
    ].map((entry) => entry.name);
    assertEquals(names, ["svc-1.env"]);
  });
});

test("redeploying without variables removes the file, and removal is idempotent", async () => {
  await withConfig(async (layout) => {
    await materializeNativeAppVariables(layout, app, [
      sealed("DB_PASSWORD", "tpdaemon.x"),
    ], decryptSecrets);
    const path = nativeAppEnvPath(layout, "svc-1");
    assertEquals((await Deno.stat(path)).isFile, true);

    const none = await materializeNativeAppVariables(
      layout,
      { ...app, variables: undefined },
      [],
      decryptSecrets,
    );
    assertEquals(none, {
      environmentFile: false,
      count: 0,
      platformManaged: [],
    });
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
    await removeNativeAppEnvFile(layout, "svc-1");
  });
});

test("an app whose only variables are platform-set gets no file at all", async () => {
  await withConfig(async (layout) => {
    const result = await materializeNativeAppVariables(
      layout,
      { ...app, variables: [{ name: "PORT", value: "9" }] },
      [],
      undefined,
    );
    assertEquals(result.environmentFile, false);
    assertEquals(result.platformManaged, ["PORT"]);
    await assertRejects(
      () => Deno.stat(nativeAppEnvPath(layout, "svc-1")),
      Deno.errors.NotFound,
    );
  });
});
