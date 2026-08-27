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
  name:
    "writeSecretFiles creates 0600 files and plannedSecretsMissing detects gaps",
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
  name:
    "materializeSecretFiles decrypts and does not require leftover material when requireAll is false",
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

test("rewriteComposeSecretFilePaths is a no-op without a plan or secrets map", () => {
  const yaml = "services:\n  web:\n    image: nginx\n";
  assertEquals(
    rewriteComposeSecretFilePaths(yaml, { runDir: "/run" }, "p", "e", []),
    yaml,
  );
  assertEquals(
    rewriteComposeSecretFilePaths(
      yaml,
      { runDir: "/run" },
      "p",
      "e",
      [{
        key: "TOKEN",
        composeServiceName: "web",
        source: "web_token",
        target: "TOKEN",
        relativePath: "web--TOKEN",
        forBuild: false,
        forRuntime: true,
      }],
    ),
    yaml,
  );
});

test("rewriteComposeSecretFilePaths promotes a scalar secret entry to a file map", () => {
  const rewritten = rewriteComposeSecretFilePaths(
    "secrets:\n  web_token: {}\n",
    { runDir: "/run/tp" },
    "proj",
    "env",
    [{
      key: "TOKEN",
      composeServiceName: "web",
      source: "web_token",
      target: "TOKEN",
      relativePath: "web--TOKEN",
      forBuild: false,
      forRuntime: true,
    }],
  );
  assertEquals(
    rewritten.includes("/run/tp/deployments/proj/env/secrets/web--TOKEN"),
    true,
  );
});

test({
  name: "plannedSecretsMissing is true when a planned path is a directory",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-secret-dir-" });
    const layout = { runDir: join(root, "run") };
    const dir = join(
      layout.runDir,
      "deployments",
      "proj",
      "env",
      "secrets",
      "web--TOKEN",
    );
    await Deno.mkdir(dir, { recursive: true });
    try {
      assertEquals(
        await plannedSecretsMissing(layout, "proj", "env", [{
          relativePath: "web--TOKEN",
        }]),
        true,
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "writeSecretFiles rejects a relativePath that escapes the secrets dir",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-secret-unsafe-" });
    const layout = { runDir: join(root, "run") };
    try {
      await assertRejects(
        () =>
          writeSecretFiles(layout, "proj", "env", [{
            relativePath: "../escape",
            plaintext: "x",
          }]),
        Error,
        "unsafe secret relativePath",
      );
      await assertRejects(
        () =>
          writeSecretFiles(layout, "proj", "env", [{
            relativePath: "nested/path",
            plaintext: "x",
          }]),
        Error,
        "unsafe secret relativePath",
      );
      await assertRejects(
        () =>
          writeSecretFiles(layout, "proj", "env", [{
            relativePath: String.raw`win\path`,
            plaintext: "x",
          }]),
        Error,
        "unsafe secret relativePath",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name:
    "materializeSecretFiles no-ops an empty plan and rejects empty material",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-secret-empty-" });
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
        [],
        [],
        () => Promise.resolve([]),
      );
      await assertRejects(
        () =>
          materializeSecretFiles(
            layout,
            "proj",
            "env",
            plan,
            [],
            () => Promise.resolve([]),
          ),
        Error,
        "secret plan present but variableMaterial is empty",
      );
      await materializeSecretFiles(
        layout,
        "proj",
        "env",
        plan,
        [],
        () => Promise.resolve([]),
        { requireAll: false },
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test({
  name: "materializeSecretFiles rejects decrypt length mismatches and nulls",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-secret-decrypt-" });
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
    const material = [{
      key: "TOKEN",
      composeServiceName: "api",
      forBuild: false,
      forRuntime: true,
      isLiteral: false,
      valueEnvelope: "tpdaemon.v1.x",
    }];
    try {
      await assertRejects(
        () =>
          materializeSecretFiles(
            layout,
            "proj",
            "env",
            plan,
            material,
            () => Promise.resolve([]),
          ),
        Error,
        "secrets/decrypt returned unexpected length",
      );
      await assertRejects(
        () =>
          materializeSecretFiles(
            layout,
            "proj",
            "env",
            plan,
            material,
            () => Promise.resolve([null]),
          ),
        Error,
        "Failed to decrypt secret variable TOKEN",
      );
      await assertRejects(
        () =>
          materializeSecretFiles(
            layout,
            "proj",
            "env",
            plan,
            [{
              ...material[0]!,
              key: "OTHER",
              valueEnvelope: "tpdaemon.v1.y",
            }],
            () => Promise.resolve(["plain"]),
          ),
        Error,
        "No decrypted material for secret TOKEN",
      );
      await materializeSecretFiles(
        layout,
        "proj",
        "env",
        plan,
        material,
        () => Promise.resolve([null]),
        { requireAll: false },
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});

test("removeSecretTree rethrows a non-NotFound remove error", async () => {
  const original = Deno.remove;
  Deno.remove = () =>
    Promise.reject(new Deno.errors.PermissionDenied("denied"));
  try {
    await assertRejects(
      () => removeSecretTree({ runDir: "/run" }, "proj", "env"),
      Deno.errors.PermissionDenied,
      "denied",
    );
  } finally {
    Deno.remove = original;
  }
});

test("plannedSecretsMissing rethrows a non-NotFound stat error", async () => {
  const original = Deno.stat;
  Deno.stat = () => Promise.reject(new Deno.errors.PermissionDenied("denied"));
  try {
    await assertRejects(
      () =>
        plannedSecretsMissing({ runDir: "/run" }, "proj", "env", [{
          relativePath: "web--TOKEN",
        }]),
      Deno.errors.PermissionDenied,
      "denied",
    );
  } finally {
    Deno.stat = original;
  }
});

test({
  name: "writeSecretFiles rethrows a non-NotFound chmod error",
  permissions: { read: true, write: true },
  fn: async () => {
    const root = await Deno.makeTempDir({ prefix: "tp-secret-chmod-" });
    const layout = { runDir: join(root, "run") };
    const original = Deno.chmod;
    Deno.chmod = () =>
      Promise.reject(new Deno.errors.PermissionDenied("denied"));
    try {
      await assertRejects(
        () =>
          writeSecretFiles(layout, "proj", "env", [{
            relativePath: "web--TOKEN",
            plaintext: "x",
          }]),
        Deno.errors.PermissionDenied,
        "denied",
      );
    } finally {
      Deno.chmod = original;
      await Deno.remove(root, { recursive: true });
    }
  },
});
