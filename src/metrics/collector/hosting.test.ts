import { assertEquals } from "@std/assert";
import { it } from "@std/testing/bdd";
import { join } from "@std/path";
import { resolveHostingPath } from "./hosting.ts";
import {
  hardwareProfilePath,
  writeHardwareProfile,
} from "./sensors/overrides.ts";

/** Every candidate "exists" — isolates preference/fallback logic from the walk-up. */
const ALWAYS_EXISTS = () => true;

it("resolveHostingPath prefers the admin override over the layout default", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // No override on disk: the layout's principal home root wins.
    assertEquals(
      await resolveHostingPath({}, tempDir, { isDirectory: ALWAYS_EXISTS }),
      "/srv/users",
    );
    assertEquals(
      await resolveHostingPath(
        { TURBOPANEL_PRINCIPAL_HOME_ROOT: "/data/homes" },
        tempDir,
        { isDirectory: ALWAYS_EXISTS },
      ),
      "/data/homes",
    );

    await writeHardwareProfile({ hostingPath: "/mnt/hosting" }, tempDir);
    assertEquals(
      await resolveHostingPath({}, tempDir, { isDirectory: ALWAYS_EXISTS }),
      "/mnt/hosting",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveHostingPath falls back to the layout default on malformed state", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tempDir, "metrics"), { recursive: true });
    await Deno.writeTextFile(hardwareProfilePath(tempDir), "{broken");
    assertEquals(
      await resolveHostingPath({}, tempDir, { isDirectory: ALWAYS_EXISTS }),
      "/srv/users",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveHostingPath falls back to the layout default on a malformed on-disk hostingPath", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(tempDir, "metrics"), { recursive: true });
    // A stale/manually-edited state file can carry a relative path or one
    // with embedded whitespace — parseHardwareProfile() must drop it so
    // this never walks a relative path (e.g. up to ".") instead of falling
    // back to principalHomeRoot.
    await Deno.writeTextFile(
      hardwareProfilePath(tempDir),
      JSON.stringify({ hostingPath: "relative/path" }),
    );
    assertEquals(
      await resolveHostingPath({}, tempDir, { isDirectory: ALWAYS_EXISTS }),
      "/srv/users",
    );

    await Deno.writeTextFile(
      hardwareProfilePath(tempDir),
      JSON.stringify({ hostingPath: "/mnt/has space" }),
    );
    assertEquals(
      await resolveHostingPath({}, tempDir, { isDirectory: ALWAYS_EXISTS }),
      "/srv/users",
    );
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveHostingPath returns the resolved candidate unchanged when it already exists", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await writeHardwareProfile({ hostingPath: "/mnt/hosting" }, tempDir);
    const probed: string[] = [];
    const result = await resolveHostingPath({}, tempDir, {
      isDirectory: (path) => {
        probed.push(path);
        return true;
      },
    });
    assertEquals(result, "/mnt/hosting");
    // No walk-up needed: only the candidate itself is ever probed.
    assertEquals(probed, ["/mnt/hosting"]);
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveHostingPath walks up to the nearest existing ancestor when the admin override doesn't exist yet", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await writeHardwareProfile({
      hostingPath: "/mnt/hosting/pool-a/nested",
    }, tempDir);
    const result = await resolveHostingPath({}, tempDir, {
      isDirectory: (path) => path === "/mnt/hosting",
    });
    assertEquals(result, "/mnt/hosting");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveHostingPath walks up to the nearest existing ancestor when the layout default doesn't exist yet", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    // No override on disk: the layout default is "/srv/users", which is
    // only created on first tenant principal — a fresh host has "/srv" but
    // not yet "/srv/users".
    const result = await resolveHostingPath({}, tempDir, {
      isDirectory: (path) => path === "/srv",
    });
    assertEquals(result, "/srv");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

it("resolveHostingPath bounds the walk-up at the filesystem root", async () => {
  const tempDir = await Deno.makeTempDir();
  try {
    await writeHardwareProfile({ hostingPath: "/a/b/c" }, tempDir);
    const result = await resolveHostingPath({}, tempDir, {
      isDirectory: () => false,
    });
    assertEquals(result, "/");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});
