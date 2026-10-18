import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { RunFn } from "../deploy/ensure-principal.ts";
import type { LayoutPaths } from "../paths/layout.ts";
import { handleFoldersRemove } from "./remove-folders.ts";

/** Jest/Mocha-shaped alias for {@link Deno.test}; Sonar only recognises `test()`. */
const test = Deno.test.bind(Deno);

const ASSET = "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c99";
const SERVICE = "0192a8f4-3c1e-7a52-9b0d-4e6f1a2b3c4d";
const UPLOADS = { owner: "alice", scope: "production", slug: "uploads" };
const SITE = { owner: "alice", scope: "production", slug: "example.com" };

type Host = {
  root: string;
  layout: LayoutPaths;
  calls: string[][];
  run: RunFn;
};

/** A temp host tree where `rm` through the runner really removes. */
async function withTree(
  fn: (host: Host) => Promise<void>,
  failOn: (path: string) => boolean = () => false,
): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "tp-remove-folders-" });
  try {
    const home = join(root, "srv", "users", "alice", "production");
    await Deno.mkdir(join(home, "volumes", "uploads", "inner"), {
      recursive: true,
    });
    await Deno.writeTextFile(
      join(home, "volumes", "uploads", "inner", "file"),
      "x",
    );
    await Deno.mkdir(join(home, "volumes", "keep"), { recursive: true });
    await Deno.mkdir(join(home, "services", "example.com", "shared"), {
      recursive: true,
    });
    const state = join(root, "state");
    await Deno.mkdir(join(state, "folders"), { recursive: true });
    const calls: string[][] = [];
    const run: RunFn = async (_command, args) => {
      calls.push([...args]);
      const path = args.at(-1) ?? "";
      if (failOn(path)) {
        return { success: false, stdout: "", stderr: "device busy" };
      }
      await Deno.remove(path, { recursive: true });
      return { success: true, stdout: "", stderr: "" };
    };
    await fn({
      root,
      layout: {
        principalHomeRoot: join(root, "srv", "users"),
        daemonStateDir: state,
      } as LayoutPaths,
      calls,
      run,
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

async function exists(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => true, () => false);
}

test("server.folders.remove removes the named volume folder and nothing beside it", async () => {
  await withTree(async (host) => {
    const result = await handleFoldersRemove(
      { folders: [{ kind: "volume", folder: UPLOADS }] },
      "2026-01-01T00:00:00.000Z",
      { resolveLayout: () => host.layout, runPrivileged: host.run },
    );
    assertEquals(result.folders, [{
      owner: "alice",
      scope: "production",
      kind: "volume",
      slug: "uploads",
      removed: true,
    }]);
    const volumes = join(
      host.layout.principalHomeRoot,
      "alice",
      "production",
      "volumes",
    );
    assertEquals(await exists(join(volumes, "uploads")), false);
    assertEquals(await exists(join(volumes, "keep")), true);
    assertEquals(host.calls.length, 1);
    assertEquals(host.calls[0]?.slice(0, 4), ["-n", "rm", "-rf", "--"]);
  });
});

test("server.folders.remove treats a folder that is already gone as removed", async () => {
  await withTree(async (host) => {
    const result = await handleFoldersRemove(
      {
        folders: [{
          kind: "volume",
          folder: { ...UPLOADS, slug: "never-made" },
        }],
      },
      "2026-01-01T00:00:00.000Z",
      {
        resolveLayout: () => host.layout,
        // The root helper succeeds on a missing name.
        runPrivileged: () =>
          Promise.resolve({ success: true, stdout: "", stderr: "" }),
      },
    );
    assertEquals(result.folders[0]?.removed, true);
  });
});

test("server.folders.remove reports a folder that stayed, with the reason, and goes on with the rest", async () => {
  await withTree(async (host) => {
    await Deno.mkdir(
      join(
        host.layout.principalHomeRoot,
        "alice",
        "production",
        "volumes",
        "second",
      ),
    );
    const result = await handleFoldersRemove(
      {
        folders: [
          { kind: "volume", folder: UPLOADS },
          { kind: "volume", folder: { ...UPLOADS, slug: "second" } },
        ],
      },
      "2026-01-01T00:00:00.000Z",
      { resolveLayout: () => host.layout, runPrivileged: host.run },
    );
    assertEquals(result.folders.map((f) => f.removed), [true, true]);

    await withTree(async (busy) => {
      const failed = await handleFoldersRemove(
        {
          folders: [
            { kind: "volume", folder: UPLOADS },
            { kind: "volume", folder: { ...UPLOADS, slug: "keep" } },
          ],
        },
        "2026-01-01T00:00:00.000Z",
        { resolveLayout: () => busy.layout, runPrivileged: busy.run },
      );
      assertEquals(failed.folders.map((f) => f.removed), [false, true]);
      assertEquals(
        failed.folders[0]?.reason?.startsWith("The folder was not removed:"),
        true,
      );
      assertEquals(failed.folders[0]?.reason?.includes("device busy"), true);
      assertEquals(failed.folders[1]?.reason, undefined);
      assertEquals(failed.summary, "Removed 1 of 2 folder(s)");
    }, (path) => path.endsWith("/uploads"));
  });
});

test("server.folders.remove refuses a reference whose record names another folder", async () => {
  await withTree(async (host) => {
    await Deno.writeTextFile(
      join(host.layout.daemonStateDir, "folders", `${ASSET}.json`),
      JSON.stringify({
        owner: "alice",
        scope: "production",
        kind: "volume",
        slug: "keep",
        created: "",
      }),
    );
    const result = await handleFoldersRemove(
      { folders: [{ kind: "volume", assetId: ASSET, folder: UPLOADS }] },
      "2026-01-01T00:00:00.000Z",
      { resolveLayout: () => host.layout, runPrivileged: host.run },
    );
    assertEquals(result.folders[0]?.removed, false);
    assertEquals(host.calls, []);
    assertEquals(
      result.folders[0]?.reason?.includes("folder_changed"),
      true,
    );
  });
});

test("server.folders.remove forgets the record of a removed volume", async () => {
  await withTree(async (host) => {
    const record = join(host.layout.daemonStateDir, "folders", `${ASSET}.json`);
    await Deno.writeTextFile(
      record,
      JSON.stringify({ ...UPLOADS, kind: "volume", created: "" }),
    );
    const result = await handleFoldersRemove(
      { folders: [{ kind: "volume", assetId: ASSET, folder: UPLOADS }] },
      "2026-01-01T00:00:00.000Z",
      { resolveLayout: () => host.layout, runPrivileged: host.run },
    );
    assertEquals(result.folders[0]?.removed, true);
    assertEquals(await exists(record), false);
  });
});

test("server.folders.remove removes a deleted service's folder and its records", async () => {
  await withTree(async (host) => {
    await Deno.mkdir(
      join(host.layout.daemonStateDir, "release-records", SERVICE),
      {
        recursive: true,
      },
    );
    const record = join(
      host.layout.daemonStateDir,
      "folders",
      `${SERVICE}.json`,
    );
    await Deno.writeTextFile(
      record,
      JSON.stringify({ ...SITE, kind: "service", created: "" }),
    );
    const result = await handleFoldersRemove(
      { folders: [{ kind: "service", assetId: SERVICE, folder: SITE }] },
      "2026-01-01T00:00:00.000Z",
      { resolveLayout: () => host.layout, runPrivileged: host.run },
    );
    assertEquals(result.folders[0], {
      owner: "alice",
      scope: "production",
      kind: "service",
      slug: "example.com",
      removed: true,
    });
    assertEquals(await exists(record), false);
    assertEquals(
      await exists(
        join(host.layout.daemonStateDir, "release-records", SERVICE),
      ),
      false,
    );
  });
});

test("server.folders.remove finds a deleted service's id from the host's own record", async () => {
  await withTree(async (host) => {
    await Deno.mkdir(
      join(host.layout.daemonStateDir, "release-records", SERVICE),
      { recursive: true },
    );
    const record = join(
      host.layout.daemonStateDir,
      "folders",
      `${SERVICE}.json`,
    );
    await Deno.writeTextFile(
      record,
      JSON.stringify({ ...SITE, kind: "service", created: "" }),
    );
    // The panel's row for a deleted service has lost the id.
    const result = await handleFoldersRemove(
      { folders: [{ kind: "service", folder: SITE }] },
      "2026-01-01T00:00:00.000Z",
      { resolveLayout: () => host.layout, runPrivileged: host.run },
    );
    assertEquals(result.folders[0]?.removed, true);
    assertEquals(await exists(record), false);
    assertEquals(
      await exists(
        join(host.layout.daemonStateDir, "release-records", SERVICE),
      ),
      false,
    );
  });
});

test("server.folders.remove removes a folder that has no record and no id", async () => {
  await withTree(async (host) => {
    const result = await handleFoldersRemove(
      { folders: [{ kind: "service", folder: SITE }] },
      "2026-01-01T00:00:00.000Z",
      { resolveLayout: () => host.layout, runPrivileged: host.run },
    );
    assertEquals(result.folders[0]?.removed, true);
    assertEquals(host.calls.length, 1);
  });
});
