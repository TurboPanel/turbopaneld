import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { StorageBackupPayload } from "../contracts/commands-contracts.ts";
import { parseStorageBackupPayload } from "../contracts/commands-contracts.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { copyTargetLockPath } from "../managed/target-lock.ts";
import { type LayoutPaths, resolveLayout } from "../paths/layout.ts";
import type { StorageBackupHandlerDeps } from "./storage-backup.ts";
import { handleStorageBackup } from "./storage-backup.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const COPY = "0192f1de-7c3b-7e4a-9f10-0000000000c1";
const POLICY = "0192f1de-7c3b-7e4a-9f10-0000000000d1";
const NOW = new Date("2026-09-30T04:00:00.000Z");

async function withLayout(fn: (layout: LayoutPaths) => Promise<void>) {
  const root = await Deno.makeTempDir({ prefix: "tp-storage-backup-" });
  try {
    await fn(
      resolveLayout({
        TURBOPANEL_STATE_DIR: join(root, "state"),
        TURBOPANEL_BACKUP_DIR: join(root, "backup"),
        TURBOPANEL_RUN_DIR: join(root, "run"),
      }, { skipDiscovery: true, forceMode: "production" }),
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

function dockerResult(success: boolean, stderr = ""): DockerCliResult {
  return { success, code: success ? 0 : 1, stdout: "", stderr };
}

function payload(
  overrides: Partial<StorageBackupPayload> = {},
): StorageBackupPayload {
  return {
    copyId: COPY,
    copyProvider: "docker",
    volumeName: "0192f1de-7c3b-7e4a-9f10-0000000000b1",
    storageId: "0192f1de-7c3b-7e4a-9f10-0000000000b1",
    action: "create",
    backupId: "bk_manual",
    ...overrides,
  };
}

function deps(
  layout: LayoutPaths,
  calls: string[][],
  options: { imagePresent?: boolean; pullWorks?: boolean } = {},
): StorageBackupHandlerDeps {
  return {
    layout,
    now: () => NOW,
    runDocker: (args) => {
      calls.push(args);
      if (args[0] === "image") {
        return Promise.resolve(dockerResult(options.imagePresent ?? true));
      }
      if (args[0] === "pull") {
        return Promise.resolve(
          dockerResult(options.pullWorks ?? true, "registry unreachable"),
        );
      }
      if (args[0] === "volume") {
        return Promise.resolve({
          ...dockerResult(true),
          stdout: JSON.stringify({ Driver: "local", Labels: {} }),
        });
      }
      return Promise.resolve(dockerResult(true));
    },
    runArchive: async (argv, destination) => {
      calls.push(argv);
      const writer = destination.getWriter();
      await writer.write(new TextEncoder().encode("archive"));
      await writer.close();
      return { success: true, stderr: "" };
    },
  };
}

test("a manual create archives the copy outside any policy directory", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    const result = await handleStorageBackup(
      payload(),
      NOW.toISOString(),
      deps(layout, calls),
    );
    const path = join(layout.backupDir, "copies", COPY, "bk_manual.tar.gz");
    assertEquals(result.backupId, "bk_manual");
    assertEquals(result.path, path);
    assertEquals(result.sizeBytes, 7);
    assertEquals(result.checksum?.length, 64);
    assertEquals(result.completedAt, NOW.toISOString());
    assertEquals((await Deno.stat(path)).isFile, true);
    assertEquals(calls.slice(0, 2).map((args) => args[0]), ["image", "volume"]);
  });
});

test("a manual create pulls a missing helper image, and fails when it cannot", async () => {
  await withLayout(async (layout) => {
    const calls: string[][] = [];
    await handleStorageBackup(
      payload(),
      "",
      deps(layout, calls, {
        imagePresent: false,
      }),
    );
    assertEquals(calls.slice(0, 2).map((args) => args[0]), ["image", "pull"]);

    const failing: string[][] = [];
    await assertRejects(
      () =>
        handleStorageBackup(
          payload({ backupId: "bk_two" }),
          "",
          deps(layout, failing, { imagePresent: false, pullWorks: false }),
        ),
      Error,
      "could not pull the backup helper image",
    );
    assertEquals(failing.some((args) => args[0] === "run"), false);
  });
});

test("a manual create waits for nobody: a held copy lock fails it as busy", async () => {
  await withLayout(async (layout) => {
    await Deno.mkdir(join(layout.runDir, "copy-locks"), { recursive: true });
    const holder = await Deno.open(copyTargetLockPath(layout, COPY), {
      create: true,
      write: true,
    });
    try {
      await holder.lock(true);
      const calls: string[][] = [];
      await assertRejects(
        () => handleStorageBackup(payload(), "", deps(layout, calls)),
        Error,
        "busy",
      );
      assertEquals(calls.some((args) => args[0] === "run"), false);
    } finally {
      holder.close();
    }
  });
});

test("a delete removes the manual or the policy's artifact and is idempotent", async () => {
  await withLayout(async (layout) => {
    const policyDir = join(
      layout.backupDir,
      "copies",
      COPY,
      `policy-${POLICY}`,
    );
    await Deno.mkdir(policyDir, { recursive: true });
    const scheduled = join(policyDir, "bk_sched.tar.gz");
    await Deno.writeTextFile(scheduled, "x");

    const calls: string[][] = [];
    const result = await handleStorageBackup(
      payload({ action: "delete", backupId: "bk_sched", policyId: POLICY }),
      "",
      deps(layout, calls),
    );
    assertEquals(result, {
      backupId: "bk_sched",
      deleted: true,
      completedAt: NOW.toISOString(),
    });
    await assertRejects(() => Deno.stat(scheduled), Deno.errors.NotFound);

    const again = await handleStorageBackup(
      payload({ action: "delete", backupId: "bk_sched", policyId: POLICY }),
      "",
      deps(layout, calls),
    );
    assertEquals(again.deleted, true);
    assertEquals(calls, []);
  });
});

test("the payload parser refuses a policy id on create and unsafe sources", () => {
  const base = {
    copyId: COPY,
    copyProvider: "docker",
    volumeName: "0192f1de-7c3b-7e4a-9f10-0000000000b1",
    storageId: "0192f1de-7c3b-7e4a-9f10-0000000000b1",
    action: "create",
    backupId: "bk_manual",
  };
  assertEquals(parseStorageBackupPayload(base).copyId, COPY);
  for (
    const bad of [
      { ...base, policyId: POLICY },
      { ...base, action: "restore" },
      { ...base, copyProvider: "nfs" },
      {
        ...base,
        copyProvider: "path",
        volumeName: undefined,
        hostPath: "/srv/users/../etc",
        ownerUsername: "shop",
      },
      { ...base, storageId: undefined },
      { ...base, backupId: "../x" },
    ]
  ) {
    let refused = false;
    try {
      parseStorageBackupPayload(bad);
    } catch {
      refused = true;
    }
    assertEquals(refused, true, JSON.stringify(bad));
  }
});
