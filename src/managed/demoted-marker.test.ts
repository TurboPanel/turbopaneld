import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  clearManagedDemotedMarker,
  clearManagedDemotionArtifacts,
  isManagedMemberDemoted,
  listDemotedFenceTargets,
  maybeClearDemotedMarkerAfterApply,
  readManagedDemotedMarker,
  resolveDemotedEngineForClear,
  writeManagedDemotedMarker,
} from "./demoted-marker.ts";
import { MYSQL_FAMILY_DEMOTED_FENCE_CNF_REL } from "./demoted-fence-volume.ts";
import { managedDir } from "./engine-paths.ts";
import { saveManagedHaMember } from "./ha-member.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const MANAGED_ID = "00000000-0000-4000-8000-000000000001";
const MEMBER_ID = "00000000-0000-4000-8000-0000000000a1";
const OTHER_MEMBER = "00000000-0000-4000-8000-0000000000b2";

test("write and clear a demoted marker", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    assertEquals(
      await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID),
      false,
    );
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    const path = `${layout.stateDir}/managed/${MANAGED_ID}/demoted.json`;
    const text = await Deno.readTextFile(path);
    assertEquals(JSON.parse(text), {
      memberId: MEMBER_ID,
      demotedAt: "2026-10-08T12:00:00.000Z",
    });
    const stat = await Deno.stat(path);
    assertEquals(stat.mode && (stat.mode & 0o777), 0o600);
    assert(await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID));
    assertEquals(
      await isManagedMemberDemoted(layout, MANAGED_ID, OTHER_MEMBER),
      false,
    );
    await clearManagedDemotedMarker(layout, MANAGED_ID);
    assertEquals(
      await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID),
      false,
    );
  });
});

test("an empty memberId does not match a demoted marker", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    assertEquals(await isManagedMemberDemoted(layout, MANAGED_ID, ""), false);
    assert(await isManagedMemberDemoted(layout, MANAGED_ID));
  });
});

test("an unreadable demoted marker fails closed", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${layout.stateDir}/managed/${MANAGED_ID}/demoted.json`,
      "{not json",
    );
    assert(await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID));
  });
});

test("a replica apply that is ready clears the marker; other outcomes keep it", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId: MANAGED_ID, memberRole: "primary" },
      "ready",
    );
    assert(await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID));
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId: MANAGED_ID, memberRole: "replica" },
      "needs_resync",
    );
    assert(await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID));
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId: MANAGED_ID, memberRole: "replica" },
      "ready",
    );
    assertEquals(
      await isManagedMemberDemoted(layout, MANAGED_ID, MEMBER_ID),
      false,
    );
  });
});

test("listDemotedFenceTargets merges ha-member records with orphan markers", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const otherId = "00000000-0000-4000-8000-000000000002";
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: MEMBER_ID,
      engine: "postgres",
      role: "primary",
      containerName: "db-1",
      replicaPeerCount: 1,
      peerCount: 1,
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    await Deno.mkdir(`${layout.stateDir}/managed/${otherId}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${layout.stateDir}/managed/${otherId}/docker-compose.yml`,
      [
        "services:",
        "  db:",
        "    image: mysql:8.4",
        "    volumes:",
        "      - orphan_data:/var/lib/mysql",
        "volumes:",
        "  orphan_data:",
        "    name: orphan_data",
        "",
      ].join("\n"),
    );
    await writeManagedDemotedMarker(
      layout,
      otherId,
      OTHER_MEMBER,
      "2026-10-08T12:00:00.000Z",
      "mysql",
    );
    const targets = await listDemotedFenceTargets(layout);
    assertEquals(targets.length, 2);
    const primary = targets.find((t) => t.managedId === MANAGED_ID);
    assertEquals(primary?.memberId, MEMBER_ID);
    assertEquals(primary?.engine, "postgres");
  });
});

test("maybeClearDemotedMarkerAfterApply keeps marker when volume clear fails", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_marker_clear_fail_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docker-compose.yml`,
      [
        "services:",
        "  db:",
        "    image: postgres:18",
        "    volumes:",
        "      - fence_data:/var/lib/postgresql",
        "volumes:",
        "  fence_data:",
        "    name: fence_data",
        "",
      ].join("\n"),
    );
    await writeManagedDemotedMarker(
      layout,
      managedId,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      "postgres",
    );
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "run") {
        const script = args.at(-1) ?? "";
        if (script.includes("rm -f")) {
          return Promise.reject(new Error("volume fence remove failed"));
        }
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "present\n",
          stderr: "",
        });
      }
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "",
        stderr: "",
      });
    };
    let threw = false;
    try {
      await maybeClearDemotedMarkerAfterApply(
        layout,
        { managedId, memberRole: "replica", engine: "postgres" },
        "ready",
        run,
      );
    } catch {
      threw = true;
    }
    assert(threw);
    assert(await isManagedMemberDemoted(layout, managedId, MEMBER_ID));
  });
});

test("maybeClearDemotedMarkerAfterApply clears marker only after volume fence succeeds", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_marker_order_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(join(root, "config", "conf.d"), { recursive: true });
    const cnfPath = join(root, "config", MYSQL_FAMILY_DEMOTED_FENCE_CNF_REL);
    await Deno.writeTextFile(cnfPath, "read_only=1\n");
    await writeManagedDemotedMarker(
      layout,
      managedId,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      "mysql",
    );
    const steps: string[] = [];
    const run = (): Promise<DockerCliResult> =>
      Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" });
    const originalRemove = Deno.remove.bind(Deno);
    Deno.remove = (path: string | URL) => {
      const text = String(path);
      if (text.includes(MYSQL_FAMILY_DEMOTED_FENCE_CNF_REL)) {
        steps.push("volume-fence");
      } else if (text.endsWith("demoted.json")) {
        steps.push("marker");
      }
      return originalRemove(path);
    };
    try {
      await maybeClearDemotedMarkerAfterApply(
        layout,
        { managedId, memberRole: "replica", engine: "mysql" },
        "ready",
        run,
      );
    } finally {
      Deno.remove = originalRemove;
    }
    assertEquals(steps, ["volume-fence", "marker"]);
  });
});

test("maybeClearDemotedMarkerAfterApply removes mysql volume fence artefacts", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_marker_clear_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(join(root, "config", "conf.d"), { recursive: true });
    const cnfPath = join(root, "config", MYSQL_FAMILY_DEMOTED_FENCE_CNF_REL);
    await Deno.writeTextFile(cnfPath, "read_only=1\n");
    await writeManagedDemotedMarker(
      layout,
      managedId,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      "mysql",
    );
    const run = (): Promise<DockerCliResult> =>
      Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" });
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId, memberRole: "replica", engine: "mysql" },
      "ready",
      run,
    );
    let missing = false;
    try {
      await Deno.stat(cnfPath);
    } catch (err) {
      missing = err instanceof Deno.errors.NotFound;
    }
    assert(missing);
    assertEquals(
      await isManagedMemberDemoted(layout, managedId, MEMBER_ID),
      false,
    );
  });
});

test("readManagedDemotedMarker returns parsed engine metadata", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      "mariadb",
    );
    assertEquals(await readManagedDemotedMarker(layout, MANAGED_ID), {
      memberId: MEMBER_ID,
      demotedAt: "2026-10-08T12:00:00.000Z",
      engine: "mariadb",
    });
  });
});

test("listDemotedFenceTargets includes orphan markers with a postgres engine fallback", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    const targets = await listDemotedFenceTargets(layout);
    assertEquals(targets.length, 1);
    assertEquals(targets[0]?.engine, "postgres");
  });
});

test("resolveDemotedEngineForClear reads engine from the demoted marker", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      "mysql",
    );
    assertEquals(
      await resolveDemotedEngineForClear(layout, MANAGED_ID),
      "mysql",
    );
  });
});

test("clearManagedDemotionArtifacts keeps the marker when volume fence removal fails", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_clear_fail_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(
      `${root}/docker-compose.yml`,
      [
        "services:",
        "  db:",
        "    image: postgres:18",
        "    volumes:",
        "      - fence_data:/var/lib/postgresql",
        "volumes:",
        "  fence_data:",
        "    name: fence_data",
        "",
      ].join("\n"),
    );
    await writeManagedDemotedMarker(
      layout,
      managedId,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      "postgres",
    );
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "run") {
        const script = args.at(-1) ?? "";
        if (script.includes("rm -f")) {
          return Promise.reject(new Error("volume fence remove failed"));
        }
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: "present\n",
          stderr: "",
        });
      }
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "",
        stderr: "",
      });
    };
    let threw = false;
    try {
      await clearManagedDemotionArtifacts(layout, managedId, {
        engine: "postgres",
        run,
      });
    } catch {
      threw = true;
    }
    assert(threw);
    assert(await isManagedMemberDemoted(layout, managedId, MEMBER_ID));
  });
});

test("listDemotedFenceTargets includes a marker without ha-member.json", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await Deno.mkdir(`${layout.stateDir}/managed/${MANAGED_ID}`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${layout.stateDir}/managed/${MANAGED_ID}/docker-compose.yml`,
      [
        "services:",
        "  db:",
        "    image: postgres:18",
        "    volumes:",
        "      - orphan_pg:/var/lib/postgresql",
        "volumes:",
        "  orphan_pg:",
        "    name: orphan_pg",
        "",
      ].join("\n"),
    );
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
      "postgres",
    );
    const targets = await listDemotedFenceTargets(layout);
    assertEquals(targets.length, 1);
    assertEquals(targets[0]?.managedId, MANAGED_ID);
  });
});
