import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  materializeSecretFiles,
  plannedSecretsMissing,
  removeSecretTree,
  rewriteComposeSecretFilePaths,
  SECRET_FILE_MODE,
  writeSecretFiles,
} from "./secret-runtime.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test({
  name: "writeSecretFiles creates 0600 files and plannedSecretsMissing detects gaps",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-secret-runtime-" });
    const layout = { runDir: join(root, "run") };
    const plan = [{
      key: "DATABASE_PASSWORD",
      composeServiceName: "web",
      source: "web_database_password",
      target: "DATABASE_PASSWORD",
      relativePath: "web--DATABASE_PASSWORD",
      forBuild: false,
      forRuntime: true,
    }];
    try {
      assertEquals(
        await plannedSecretsMissing(layout, "proj", "env", plan),
        true,
      );
      await writeSecretFiles(layout, "proj", "env", [{
        relativePath: "web--DATABASE_PASSWORD",
        plaintext: "s3cret",
      }]);
      const path = join(
        layout.runDir,
        "deployments",
        "proj",
        "env",
        "secrets",
        "web--DATABASE_PASSWORD",
      );
      const stat = await Deno.stat(path);
      assertEquals(stat.mode! & 0o777, SECRET_FILE_MODE);
      assertEquals(await Deno.readTextFile(path), "s3cret");
      assertEquals(
        await plannedSecretsMissing(layout, "proj", "env", plan),
        false,
      );
      await removeSecretTree(layout, "proj", "env");
      await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "materializeSecretFiles decrypts and does not require leftover material when requireAll is false",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-secret-mat-" });
    const layout = { runDir: join(root, "run") };
    const plan = [{
      key: "TOKEN",
      composeServiceName: "api",
      source: "api_token",
      target: "TOKEN",
      relativePath: "api--TOKEN",
      forBuild: false,
      forRuntime: true,
    }];
    try {
      await materializeSecretFiles(
        layout,
        "proj",
        "env",
        plan,
        [{
          key: "TOKEN",
          composeServiceName: "api",
          forBuild: false,
          forRuntime: true,
          isLiteral: false,
          valueEnvelope: "tpdaemon.v1.x",
        }],
        (envelopes) => Promise.resolve(envelopes.map(() => "plain")),
      );
      const path = join(
        layout.runDir,
        "deployments",
        "proj",
        "env",
        "secrets",
        "api--TOKEN",
      );
      assertEquals(await Deno.readTextFile(path), "plain");

      await materializeSecretFiles(
        layout,
        "proj",
        "env",
        [{ ...plan[0]!, key: "MISSING", relativePath: "api--MISSING" }],
        [],
        () => Promise.resolve([]),
        { requireAll: false },
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test("rewriteComposeSecretFilePaths rewrites secrets.file to the host runDir", () => {
  const yaml = `secrets:
  web_database_password:
    file: /run/turbopanel/deployments/proj/env/secrets/web--DATABASE_PASSWORD
services:
  web:
    image: nginx
`;
  const rewritten = rewriteComposeSecretFilePaths(
    yaml,
    { runDir: "/tmp/tp-run" },
    "proj",
    "env",
    [{
      key: "DATABASE_PASSWORD",
      composeServiceName: "web",
      source: "web_database_password",
      target: "DATABASE_PASSWORD",
      relativePath: "web--DATABASE_PASSWORD",
      forBuild: false,
      forRuntime: true,
    }],
  );
  assertEquals(
    rewritten.includes(
      "/tmp/tp-run/deployments/proj/env/secrets/web--DATABASE_PASSWORD",
    ),
    true,
  );
  assertEquals(rewritten.includes("s3cret"), false);
});
