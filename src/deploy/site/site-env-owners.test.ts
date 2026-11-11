import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { createTempLayout } from "../../testing/temp-layout.ts";
import { resolveLayout } from "../../paths/layout.ts";
import type { RunFn } from "../ensure-principal.ts";
import {
  recordSiteEnvOwner,
  removeRecordedSiteEnvFiles,
  removeSiteEnvFile,
} from "./site-env-owners.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ID_WEB = "web-0123456789ab";
const ID_API = "api-0123456789ab";

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

function recorder(failFor?: string) {
  const asked: string[] = [];
  const run: RunFn = (_command, args) => {
    const line = args.slice(args.indexOf("site-env-remove")).join(" ");
    asked.push(line);
    return Promise.resolve(
      failFor !== undefined && line.includes(failFor)
        ? { success: false, code: 1, stdout: "", stderr: "refused" }
        : { success: true, code: 0, stdout: "", stderr: "" },
    );
  };
  return { run, asked };
}

const exists = (path: string) => Deno.lstat(path).then(() => true, () => false);

test("removeSiteEnvFile asks tp-host for the user and site id, and reports a refusal", async () => {
  const { run, asked } = recorder();
  await removeSiteEnvFile(run, "alice", ID_WEB);
  assertEquals(asked, [`site-env-remove alice ${ID_WEB}`]);
  await assertRejects(
    () => removeSiteEnvFile(recorder("alice").run, "alice", ID_WEB),
    Error,
    "removing its environment file failed: refused",
  );
});

test("a site removed after its install has its root copy removed through the recorded user", async () => {
  await withLayout(async (layout) => {
    await recordSiteEnvOwner(layout, "env1", "web", {
      username: "alice",
      siteId: ID_WEB,
    });
    await recordSiteEnvOwner(layout, "env1", "api", {
      username: "bob",
      siteId: ID_API,
    });
    const { run, asked } = recorder();
    // Only the named site goes; the other keeps its file and its record.
    assertEquals(
      await removeRecordedSiteEnvFiles(run, layout, "env1", ["web"]),
      ["web"],
    );
    assertEquals(asked, [`site-env-remove alice ${ID_WEB}`]);
    const dir = join(layout.stateDir, "sites", ".env-owners", "env1");
    assertEquals(await exists(join(dir, "web.json")), false);
    assertEquals(await exists(join(dir, "api.json")), true);
  });
});

test("stopping an environment removes every recorded site's copy and its folder of records", async () => {
  await withLayout(async (layout) => {
    await recordSiteEnvOwner(layout, "env1", "web", {
      username: "alice",
      siteId: ID_WEB,
    });
    await recordSiteEnvOwner(layout, "env1", "api", {
      username: "bob",
      siteId: ID_API,
    });
    await recordSiteEnvOwner(layout, "env2", "web", {
      username: "alice",
      siteId: "web-ffffffffffff",
    });
    const { run, asked } = recorder();
    const removed = await removeRecordedSiteEnvFiles(run, layout, "env1");
    assertEquals(removed.sort(), ["api", "web"]);
    assertEquals(asked.sort(), [
      `site-env-remove alice ${ID_WEB}`,
      `site-env-remove bob ${ID_API}`,
    ]);
    assertEquals(
      await exists(join(layout.stateDir, "sites", ".env-owners", "env1")),
      false,
    );
    // Another environment is untouched.
    assertEquals(
      await exists(
        join(layout.stateDir, "sites", ".env-owners", "env2", "web.json"),
      ),
      true,
    );
  });
});

test("a site with no record removes nothing and does not fail", async () => {
  await withLayout(async (layout) => {
    const { run, asked } = recorder();
    assertEquals(
      await removeRecordedSiteEnvFiles(run, layout, "env1", ["old-site"]),
      [],
    );
    assertEquals(await removeRecordedSiteEnvFiles(run, layout, "env1"), []);
    assertEquals(asked, []);
    // A record that is not what the daemon writes is ignored too.
    const dir = join(layout.stateDir, "sites", ".env-owners", "env1");
    await Deno.mkdir(dir, { recursive: true });
    await Deno.writeTextFile(
      join(dir, "web.json"),
      JSON.stringify({ username: "../root", siteId: "x" }),
    );
    assertEquals(
      await removeRecordedSiteEnvFiles(run, layout, "env1", ["web"]),
      [],
    );
    assertEquals(asked, []);
  });
});

test("a refused removal keeps the record so the next deploy or stop tries again", async () => {
  await withLayout(async (layout) => {
    await recordSiteEnvOwner(layout, "env1", "web", {
      username: "alice",
      siteId: ID_WEB,
    });
    assertEquals(
      await removeRecordedSiteEnvFiles(
        recorder("alice").run,
        layout,
        "env1",
        ["web"],
      ),
      [],
    );
    const record = join(
      layout.stateDir,
      "sites",
      ".env-owners",
      "env1",
      "web.json",
    );
    assert(await exists(record));
    assertEquals(
      await removeRecordedSiteEnvFiles(recorder().run, layout, "env1", [
        "web",
      ]),
      ["web"],
    );
    assertEquals(await exists(record), false);
  });
});

test("the record holds the user and site id and is private", async () => {
  await withLayout(async (layout) => {
    await recordSiteEnvOwner(layout, "env1", "web", {
      username: "alice",
      siteId: ID_WEB,
    });
    const path = join(
      layout.stateDir,
      "sites",
      ".env-owners",
      "env1",
      "web.json",
    );
    assertEquals(JSON.parse(await Deno.readTextFile(path)), {
      username: "alice",
      siteId: ID_WEB,
    });
    assertEquals(((await Deno.stat(path)).mode ?? 0) & 0o777, 0o600);
    await assertRejects(
      () =>
        recordSiteEnvOwner(layout, "../env", "web", {
          username: "alice",
          siteId: ID_WEB,
        }),
      Error,
      "cannot record",
    );
    for (const bad of ["..", ".", "a/b", ""]) {
      await assertRejects(
        () =>
          recordSiteEnvOwner(layout, bad, "web", {
            username: "alice",
            siteId: ID_WEB,
          }),
        Error,
        "cannot record",
      );
    }
    await assertRejects(
      () =>
        recordSiteEnvOwner(layout, "env1", "..", {
          username: "alice",
          siteId: ID_WEB,
        }),
      Error,
      "cannot record",
    );
    // Removal never walks a folder an odd environment id would name.
    assertEquals(
      await removeRecordedSiteEnvFiles(recorder().run, layout, ".."),
      [],
    );
  });
});
