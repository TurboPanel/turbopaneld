import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import type {
  EnvironmentDeployNativeAppService,
  EnvironmentDeployVariableMaterial,
} from "../../contracts/commands-contracts.ts";
import {
  materializeNativeAppVariables,
  NATIVE_APP_ENV_DIR_MODE,
  NATIVE_APP_ENV_FILE_MODE,
  NATIVE_APP_ENV_MAX_BYTES,
  normalizeNativeAppEnvValue,
  removeNativeAppEnvFile,
  renderNativeAppEnvFile,
  renderNativeAppEnvLine,
  resolveNativeAppVariables,
} from "./variables-runtime.ts";
import type { RunFn } from "../ensure-principal.ts";
import { nativeAppEnvStageDir, nativeAppEnvStagePath } from "./unit.ts";

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

test("Windows line endings in a value, plain or secret, become LF before the file is rendered", async () => {
  const pem = "-----BEGIN KEY-----\r\nAAAA\r\n-----END KEY-----\r\n";
  const resolved = await resolveNativeAppVariables(
    {
      ...app,
      variables: [
        { name: "PLAIN_PEM", value: pem },
        { name: "SECRET_PEM", secretKey: "SECRET_PEM" },
      ],
    },
    [sealed("SECRET_PEM", `tpdaemon.${pem}`)],
    decryptSecrets,
  );
  const lf = "-----BEGIN KEY-----\nAAAA\n-----END KEY-----\n";
  assertEquals(resolved.entries, [
    { name: "PLAIN_PEM", value: lf },
    { name: "SECRET_PEM", value: lf },
  ]);
  assertEquals(renderNativeAppEnvFile(resolved.entries).includes("\r"), false);
});

test("a carriage return that is not part of CR LF, or a NUL, is refused by name, never by value", () => {
  for (const bad of ["a\rb", "a\r", "a\r\r\nb", "a\0b"]) {
    try {
      normalizeNativeAppEnvValue("api", "TLS_KEY", bad);
      throw new Error("expected a refusal");
    } catch (error) {
      const message = (error as Error).message;
      assertStringIncludes(message, "native app api: variable TLS_KEY");
      assertEquals(message.includes("a\rb"), false);
    }
  }
  assertEquals(normalizeNativeAppEnvValue("api", "K", "x\r\ny"), "x\ny");
  assertEquals(normalizeNativeAppEnvValue("api", "K", "plain"), "plain");
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

/**
 * Stands in for `sudo tp-host`: `app-env-install <id>` copies the staged file
 * into `copies` (as root would, into its own folder) and `app-env-remove <id>`
 * drops the copy. `seen` records what the staged file looked like at the moment
 * of each install, so a test can say what tp-host would have read.
 */
function fakeTpHost(layout: { configDir: string }, refuse?: string) {
  const copies = new Map<string, string>();
  const seen: Array<{ id: string; text: string; mode: number }> = [];
  const calls: string[][] = [];
  const run: RunFn = async (_command, args) => {
    calls.push([...args]);
    const [verb, id] = args.slice(1);
    if (refuse !== undefined && verb === "app-env-install") {
      return { success: false, stdout: "", stderr: refuse };
    }
    if (verb === "app-env-install") {
      const path = nativeAppEnvStagePath(layout, id);
      const text = await Deno.readTextFile(path);
      seen.push({ id, text, mode: (await Deno.stat(path)).mode! & 0o777 });
      copies.set(id, text);
    } else if (verb === "app-env-remove") {
      copies.delete(id);
    }
    return { success: true, stdout: "", stderr: "" };
  };
  return { run, copies, seen, calls };
}

const stagedNames = (layout: { configDir: string }) => {
  try {
    return [...Deno.readDirSync(nativeAppEnvStageDir(layout))].map((entry) =>
      entry.name
    );
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return [];
    throw err;
  }
};

test("materializeNativeAppVariables stages a 0600 file, has tp-host copy it, and deletes the staged one", async () => {
  await withConfig(async (layout) => {
    const host = fakeTpHost(layout);
    const result = await materializeNativeAppVariables(
      layout,
      app,
      [sealed("DB_PASSWORD", "tpdaemon.hunter2")],
      decryptSecrets,
      host.run,
    );
    assertEquals(result.environmentFile, true);
    assertEquals(result.count, 3);
    // tp-host got the service id and nothing else: no path, no value.
    assertEquals(host.calls, [["-n", "app-env-install", "svc-1"]]);
    const text = host.copies.get("svc-1")!;
    assertStringIncludes(text, "DB_PASSWORD='hunter2'\n");
    assertStringIncludes(text, "API_URL='https://example.test'\n");
    if (Deno.build.os !== "windows") {
      assertEquals(host.seen[0].mode, NATIVE_APP_ENV_FILE_MODE);
      assertEquals(
        (await Deno.stat(nativeAppEnvStageDir(layout))).mode! & 0o777,
        NATIVE_APP_ENV_DIR_MODE,
      );
    }
    // The secret is not left on disk in the daemon's own folder.
    assertEquals(stagedNames(layout), []);
  });
});

test("a refused copy still deletes the staged file and names the app, never a value", async () => {
  await withConfig(async (layout) => {
    const host = fakeTpHost(layout, "tp-host: refusing the staged file");
    const error = await assertRejects(
      () =>
        materializeNativeAppVariables(
          layout,
          app,
          [sealed("DB_PASSWORD", "tpdaemon.hunter2")],
          decryptSecrets,
          host.run,
        ),
      Error,
      "native app svc-1: installing its environment file failed",
    );
    assertEquals(error.message.includes("hunter2"), false);
    assertEquals(stagedNames(layout), []);
  });
});

test("an app with no variables makes no root call here, and drops a stale staged file", async () => {
  await withConfig(async (layout) => {
    const host = fakeTpHost(layout);
    await materializeNativeAppVariables(
      layout,
      app,
      [
        sealed("DB_PASSWORD", "tpdaemon.x"),
      ],
      decryptSecrets,
      host.run,
    );
    host.calls.length = 0;
    await Deno.mkdir(nativeAppEnvStageDir(layout), { recursive: true });
    await Deno.writeTextFile(nativeAppEnvStagePath(layout, "svc-1"), "stale");

    const none = await materializeNativeAppVariables(
      layout,
      { ...app, variables: undefined },
      [],
      decryptSecrets,
      host.run,
    );
    assertEquals(none, {
      environmentFile: false,
      count: 0,
      platformManaged: [],
    });
    // The root copy goes later, once the unit that no longer loads it is in
    // place (applyNativeAppServices), never before.
    assertEquals(host.calls, []);
    assertEquals(host.copies.has("svc-1"), true);
    assertEquals(stagedNames(layout), []);
  });
});

test("removeNativeAppEnvFile removes the copy and the staged file, and is idempotent", async () => {
  await withConfig(async (layout) => {
    const host = fakeTpHost(layout);
    await materializeNativeAppVariables(
      layout,
      app,
      [
        sealed("DB_PASSWORD", "tpdaemon.x"),
      ],
      decryptSecrets,
      host.run,
    );
    await Deno.writeTextFile(nativeAppEnvStagePath(layout, "svc-1"), "x");
    await removeNativeAppEnvFile(host.run, layout, "svc-1");
    await removeNativeAppEnvFile(host.run, layout, "svc-1");
    assertEquals(host.copies.has("svc-1"), false);
    assertEquals(stagedNames(layout), []);
    assertEquals(host.calls.at(-1), ["-n", "app-env-remove", "svc-1"]);
  });
});

test("a refused removal is an error, not silence", async () => {
  await withConfig(async (layout) => {
    await assertRejects(
      () =>
        removeNativeAppEnvFile(
          () => Promise.resolve({ success: false, stdout: "", stderr: "no" }),
          layout,
          "svc-1",
        ),
      Error,
      "removing its environment file failed",
    );
  });
});

test("an app whose only variables are platform-set gets no file at all", async () => {
  await withConfig(async (layout) => {
    const host = fakeTpHost(layout);
    const result = await materializeNativeAppVariables(
      layout,
      { ...app, variables: [{ name: "PORT", value: "9" }] },
      [],
      undefined,
      host.run,
    );
    assertEquals(result.environmentFile, false);
    assertEquals(result.platformManaged, ["PORT"]);
    assertEquals(host.calls, []);
    assertEquals(stagedNames(layout), []);
  });
});

test("a variables file over the limit fails naming the app, before anything is staged", async () => {
  await withConfig(async (layout) => {
    const host = fakeTpHost(layout);
    const big = Array.from({ length: 17 }, (_, i) => ({
      name: `BIG_${i}`,
      value: "x".repeat(65_536),
    }));
    const error = await assertRejects(
      () =>
        materializeNativeAppVariables(
          layout,
          { ...app, variables: big },
          [],
          undefined,
          host.run,
        ),
      Error,
      "native app svc-1: its environment variables come to",
    );
    assertEquals(error.message.includes("xxxx"), false);
    assertEquals(host.calls, []);
    assertEquals(stagedNames(layout), []);
  });
});

test("the size limit equals the one tp-host enforces", async () => {
  const script = await Deno.readTextFile(
    new URL("../../../orchestration/scripts/tp-host", import.meta.url),
  );
  assertStringIncludes(
    script,
    `TP_APPENV_MAX=${NATIVE_APP_ENV_MAX_BYTES}\n`,
  );
});

test("secrets are decrypted in batches, one at a time", async () => {
  const names = Array.from({ length: 101 }, (_, i) => `S${i}`);
  const batches: number[] = [];
  let running = 0;
  let overlapped = false;
  const resolved = await resolveNativeAppVariables(
    {
      ...app,
      variables: names.map((name) => ({ name, secretKey: name })),
    },
    names.map((name) => sealed(name, `tpdaemon.${name}-value`)),
    async (envelopes) => {
      running += 1;
      overlapped ||= running > 1;
      batches.push(envelopes.length);
      await Promise.resolve();
      running -= 1;
      return decryptSecrets(envelopes);
    },
  );
  assertEquals(batches, [100, 1]);
  assertEquals(overlapped, false);
  assertEquals(resolved.entries.length, 101);
  assertEquals(
    resolved.entries.find((entry) => entry.name === "S100")?.value,
    "S100-value",
  );
});
