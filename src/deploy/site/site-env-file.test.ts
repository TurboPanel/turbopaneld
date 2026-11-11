import { assert, assertEquals, assertRejects, assertThrows } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../../paths/layout.ts";
import { createTempLayout } from "../../testing/temp-layout.ts";
import type { RunFn } from "../ensure-principal.ts";
import { NATIVE_APP_ENV_MAX_BYTES } from "../native/variables-runtime.ts";
import type {
  SiteApplySpec,
  SiteManagedDirectory,
  SiteRelease,
} from "../site.ts";
import {
  isSiteEnvPlatformName,
  materializeSiteEnvFiles,
  renderSiteEnvFile,
  siteEnvEntries,
  siteEnvFileId,
  siteEnvRootPath,
  siteEnvStageDir,
} from "./site-env-file.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const OWNER: SiteManagedDirectory = {
  serviceId: "11111111-1111-4111-8111-111111111111",
  username: "alice",
  folder: { owner: "alice", scope: "production", slug: "example.com" },
} as unknown as SiteManagedDirectory;

const site = (patch: Partial<SiteApplySpec> = {}): SiteApplySpec => ({
  composeServiceName: "web",
  engine: "apache",
  root: "public",
  listenPort: 18080,
  ...patch,
});

async function withLayout(
  fn: (layout: ReturnType<typeof resolveLayout>) => Promise<void>,
) {
  const fixture = await createTempLayout();
  try {
    await fn(resolveLayout(fixture.env, { forceMode: "production" }));
  } finally {
    await fixture.cleanup();
  }
}

test("siteEnvEntries keeps every variable, the CA path and secrets, and names what it leaves out", async () => {
  await withLayout((layout) => {
    const out = siteEnvEntries(
      layout,
      site({
        webEnv: {
          DB_HOST: "db.example.test",
          "WEIRD.NAME": "1",
          APP_KEY: "base64:abc",
          HOME: "/nope",
          path: "/nope",
          LD_PRELOAD: "/evil.so",
          ld_library_path: "/evil",
          TURBOPANEL_PHP: "7.4",
          PHPRC: "/x",
          PHP_VALUE: "x",
          PHP_ADMIN_VALUE: "x",
          PHP_INI_SCAN_DIR: "x",
          TMPDIR: "/x",
        },
        dbCa: { variables: ["DB_CA", "MYSQL_ATTR_SSL_CA"], pem: "PEM" },
      }),
      OWNER,
    );
    assertEquals(out.entries.map((entry) => entry.name), [
      "APP_KEY",
      "DB_CA",
      "DB_HOST",
      "MYSQL_ATTR_SSL_CA",
    ]);
    const ca = out.entries.find((entry) => entry.name === "DB_CA")?.value;
    assert(ca?.endsWith("/.turbopanel-hosting/managed-ca.pem"), ca);
    assertEquals(out.unusable, ["WEIRD.NAME"]);
    assertEquals(out.platformManaged.length, 10);
    assert(isSiteEnvPlatformName("ld_audit"));
    assertEquals(isSiteEnvPlatformName("DB_HOST"), false);
    return Promise.resolve();
  });
});

test("siteEnvEntries normalizes line endings and names a lone carriage return, never its value", async () => {
  await withLayout((layout) => {
    const out = siteEnvEntries(
      layout,
      site({ webEnv: { PEM: "a\r\nb" } }),
      OWNER,
    );
    assertEquals(out.entries[0]?.value, "a\nb");
    const error = assertThrows(() =>
      siteEnvEntries(
        layout,
        site({ webEnv: { TOKEN: "secret\rvalue" } }),
        OWNER,
      )
    );
    const message = String((error as Error).message);
    assert(message.includes("site web: variable TOKEN"));
    assertEquals(message.includes("secret"), false);
    return Promise.resolve();
  });
});

test("a site with no variables renders the comment line only; an oversized file is refused", () => {
  assertEquals(
    renderSiteEnvFile("web", []),
    "# Managed by TurboPanel — rewritten on every deploy; edits are overwritten.\n",
  );
  assertThrows(
    () =>
      renderSiteEnvFile("web", [{
        name: "BIG",
        value: "x".repeat(NATIVE_APP_ENV_MAX_BYTES),
      }]),
    Error,
    "site web",
  );
});

test("the site id and the paths are the shapes tp-host checks", async () => {
  await withLayout((layout) => {
    const id = siteEnvFileId("env-1", "Web_1");
    assert(/^[a-z0-9][a-z0-9-]{0,63}$/.test(id), id);
    assertEquals(
      siteEnvRootPath(layout, "alice", id),
      join(layout.configDir, "site-env", "alice", `${id}.env`),
    );
    assertEquals(
      siteEnvStageDir(layout),
      join(layout.stateDir, "sites", ".env-stage"),
    );
    return Promise.resolve();
  });
});

test("materializeSiteEnvFiles stages 0600 in a 0700 folder, installs through tp-host and always deletes the staged file", async () => {
  await withLayout(async (layout) => {
    const id = siteEnvFileId("env1", "web");
    const staged = join(siteEnvStageDir(layout), `${id}.env`);
    const seen: { args: string[]; text: string; mode: number }[] = [];
    let fail = false;
    const run: RunFn = async (_command, args) => {
      seen.push({
        args,
        text: await Deno.readTextFile(staged),
        mode: ((await Deno.stat(staged)).mode ?? 0) & 0o777,
      });
      return fail
        ? { success: false, code: 1, stdout: "", stderr: "refused" }
        : { success: true, code: 0, stdout: "", stderr: "" };
    };
    const lines = await materializeSiteEnvFiles(
      layout,
      "env1",
      [
        site({ webEnv: { A: "1", HOME: "/x" } }),
        site({ composeServiceName: "ownerless", webEnv: { A: "1" } }),
      ],
      new Map(),
      new Map([["web", OWNER]]),
      run,
    );
    assertEquals(seen.length, 1);
    assert(seen[0]?.args.join(" ").endsWith(`site-env-install alice ${id}`));
    assertEquals(seen[0]?.mode, 0o600);
    assert(seen[0]?.text.includes("A='1'"));
    assertEquals(seen[0]?.text.includes("HOME"), false);
    assertEquals(lines, [
      "Site web: HOME is set by the platform and is not in the site's environment file.",
    ]);
    assertEquals(
      ((await Deno.stat(siteEnvStageDir(layout))).mode ?? 0) & 0o777,
      0o700,
    );
    await assertRejects(() => Deno.stat(staged));
    // The owner is recorded, for the day the site leaves.
    assertEquals(
      JSON.parse(
        await Deno.readTextFile(
          join(layout.stateDir, "sites", ".env-owners", "env1", "web.json"),
        ),
      ),
      { username: "alice", siteId: id },
    );

    fail = true;
    await assertRejects(
      () =>
        materializeSiteEnvFiles(
          layout,
          "env1",
          [site({ webEnv: { A: "1" } })],
          new Map(),
          new Map([["web", OWNER]]),
          run,
        ),
      Error,
      "installing its environment file failed: refused",
    );
    await assertRejects(() => Deno.stat(staged));
  });
});

test("a release-backed site gets its hosting metadata written early, with the CA path variables", async () => {
  await withLayout(async (layout) => {
    const calls: SiteApplySpec[] = [];
    const run: RunFn = () =>
      Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" });
    await materializeSiteEnvFiles(
      layout,
      "env1",
      [site({ dbCa: { variables: ["DB_CA"], pem: "PEM" } })],
      new Map([["web", OWNER as unknown as SiteRelease]]),
      new Map(),
      run,
      (_layout, _env, spec) => {
        calls.push(spec);
        return Promise.resolve();
      },
    );
    assertEquals(calls.length, 1);
    assert(calls[0]?.webEnv?.DB_CA?.endsWith("managed-ca.pem"));
  });
});
