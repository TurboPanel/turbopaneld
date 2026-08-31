import { assertEquals, assertRejects } from "@std/assert";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import {
  clearHostingPathOverride,
  hostingPathOverridePath,
  parseHostingPathOverride,
  resolveAdminHostingPathOverride,
  resolveHostingPath,
  writeHostingPathOverride,
} from "./hosting.ts";

it("parseHostingPathOverride accepts one absolute clean path", () => {
  assertEquals(
    parseHostingPathOverride(JSON.stringify({ path: "/mnt/hosting" })),
    "/mnt/hosting",
  );
  assertEquals(
    parseHostingPathOverride(JSON.stringify({ path: " /srv/tenants " })),
    "/srv/tenants",
  );
  assertEquals(
    parseHostingPathOverride(JSON.stringify({ path: "relative/path" })),
    undefined,
  );
  assertEquals(
    parseHostingPathOverride(JSON.stringify({ path: "/with space" })),
    undefined,
  );
  assertEquals(
    parseHostingPathOverride(JSON.stringify({ path: 42 })),
    undefined,
  );
  assertEquals(parseHostingPathOverride("not json"), undefined);
  assertEquals(parseHostingPathOverride("[1,2]"), undefined);
  assertEquals(parseHostingPathOverride("null"), undefined);
});

it("resolveAdminHostingPathOverride reads daemon state and defaults to unset", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    assertEquals(await resolveAdminHostingPathOverride(tempDir), undefined);

    const path = hostingPathOverridePath(tempDir);
    await Deno.mkdir(join(tempDir, "metrics"), { recursive: true });
    await Deno.writeTextFile(path, JSON.stringify({ path: "/mnt/hosting" }));
    assertEquals(
      await resolveAdminHostingPathOverride(tempDir),
      "/mnt/hosting",
    );

    await Deno.writeTextFile(path, "{broken");
    assertEquals(await resolveAdminHostingPathOverride(tempDir), undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("clearHostingPathOverride removes the file and treats a missing one as cleared", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // Missing file: already "no override" — must not throw.
    await clearHostingPathOverride(tempDir);

    await writeHostingPathOverride("/mnt/hosting", tempDir);
    assertEquals(
      await resolveAdminHostingPathOverride(tempDir),
      "/mnt/hosting",
    );
    await clearHostingPathOverride(tempDir);
    assertEquals(await resolveAdminHostingPathOverride(tempDir), undefined);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("clearHostingPathOverride rethrows delete failures other than NotFound", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // A non-empty directory at the override path makes the non-recursive
    // Deno.remove fail with something other than NotFound — the stale
    // override state must surface instead of reporting a successful clear.
    const overridePath = hostingPathOverridePath(tempDir);
    await Deno.mkdir(overridePath, { recursive: true });
    await Deno.writeTextFile(join(overridePath, "blocker"), "x");

    await assertRejects(() => clearHostingPathOverride(tempDir));
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveHostingPath prefers the admin override over the layout default", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // No override on disk: the layout's principal home root wins.
    assertEquals(await resolveHostingPath({}, tempDir), "/srv/users");
    assertEquals(
      await resolveHostingPath(
        { TURBOPANEL_PRINCIPAL_HOME_ROOT: "/data/homes" },
        tempDir,
      ),
      "/data/homes",
    );

    await Deno.mkdir(join(tempDir, "metrics"), { recursive: true });
    await Deno.writeTextFile(
      hostingPathOverridePath(tempDir),
      JSON.stringify({ path: "/mnt/hosting" }),
    );
    assertEquals(await resolveHostingPath({}, tempDir), "/mnt/hosting");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
