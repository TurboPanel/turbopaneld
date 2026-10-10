import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import {
  clearManagedDemotionArtifacts,
  isManagedMemberDemoted,
  listDemotedFenceTargets,
  markDemotedFenceUnsafe,
  maybeClearDemotedMarkerAfterApply,
  readManagedDemotedMarker,
  resolveDemotedEngineForClear,
  resolveDemotedMarkerMemberId,
  writeManagedDemotedMarker,
} from "./demoted-marker.ts";
import {
  MYSQL_FAMILY_CNF_FILE,
  withDemotedFenceBlock,
} from "./demoted-fence-volume.ts";
import { fakeMysqlCnfDocker } from "../testing/fake-mysql-cnf-docker.ts";
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

const NO_DOCKER = (): Promise<DockerCliResult> =>
  Promise.resolve({ success: true, code: 0, stdout: "", stderr: "" });

test("write and clear a demoted marker", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    assertEquals(await isManagedMemberDemoted(layout, MANAGED_ID), false);
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
    assert(await isManagedMemberDemoted(layout, MANAGED_ID));
    await clearManagedDemotionArtifacts(layout, MANAGED_ID, {
      engine: "redis",
      run: NO_DOCKER,
    });
    assertEquals(await isManagedMemberDemoted(layout, MANAGED_ID), false);
  });
});

for (const markerMemberId of ["", MEMBER_ID]) {
  test(`a demoted marker naming "${markerMemberId}" fences the whole cluster on this host`, async () => {
    await withTempLayout(async ({ env }) => {
      const layout = resolveLayout(env);
      await writeManagedDemotedMarker(
        layout,
        MANAGED_ID,
        markerMemberId,
        "2026-10-08T12:00:00.000Z",
      );
      // Lifecycle / guard / boot hold all ask per managed id: there is one
      // data volume per cluster per host, so no member id can opt out.
      assert(await isManagedMemberDemoted(layout, MANAGED_ID));
      assertEquals(
        await isManagedMemberDemoted(
          layout,
          "00000000-0000-4000-8000-000000000009",
        ),
        false,
      );
    });
  });
}

test("resolveDemotedMarkerMemberId prefers the payload then ha-member.json", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await Deno.mkdir(managedDir(layout, MANAGED_ID), { recursive: true });
    await saveManagedHaMember(layout, {
      managedId: MANAGED_ID,
      memberId: MEMBER_ID,
      engine: "postgres",
      role: "primary",
      containerName: "db-1",
      replicaPeerCount: 1,
      updatedAt: "2026-10-08T12:00:00.000Z",
    });
    assertEquals(
      await resolveDemotedMarkerMemberId(layout, MANAGED_ID, OTHER_MEMBER),
      OTHER_MEMBER,
    );
    assertEquals(
      await resolveDemotedMarkerMemberId(layout, MANAGED_ID),
      MEMBER_ID,
    );
    assertEquals(
      await resolveDemotedMarkerMemberId(layout, MANAGED_ID, ""),
      MEMBER_ID,
    );
  });
});

test("markDemotedFenceUnsafe records an operator-visible alert on the marker", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    await markDemotedFenceUnsafe(layout, MANAGED_ID, "still writable");
    const marker = await readManagedDemotedMarker(layout, MANAGED_ID);
    assert(marker?.unsafe === true);
    assertEquals(marker?.unsafeReason, "still writable");
    assert(marker?.unsafeAt !== undefined);
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
    assert(await isManagedMemberDemoted(layout, MANAGED_ID));
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
      NO_DOCKER,
    );
    assert(await isManagedMemberDemoted(layout, MANAGED_ID));
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId: MANAGED_ID, memberRole: "replica" },
      "needs_resync",
      NO_DOCKER,
    );
    assert(await isManagedMemberDemoted(layout, MANAGED_ID));
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId: MANAGED_ID, memberRole: "replica", engine: "redis" },
      "ready",
      NO_DOCKER,
    );
    assertEquals(
      await isManagedMemberDemoted(layout, MANAGED_ID),
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

test("a postgres replica apply clears the marker but keeps the replica's standby.signal", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_marker_replica_${crypto.randomUUID()}`;
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
    const calls: string[][] = [];
    const run = (args: string[]): Promise<DockerCliResult> => {
      calls.push(args);
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "present\n",
        stderr: "",
      });
    };
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId, memberRole: "replica", engine: "postgres" },
      "ready",
      run,
    );
    // pg_basebackup -R wrote standby.signal; removing it would let the
    // replica come up writable on its next restart.
    assertEquals(
      calls.some((args) => args.some((arg) => arg.includes("rm -f"))),
      false,
    );
    assertEquals(await isManagedMemberDemoted(layout, managedId), false);
  });
});

test("a corrupt demoted marker can still be cleared", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await Deno.mkdir(managedDir(layout, MANAGED_ID), { recursive: true });
    await Deno.writeTextFile(
      `${managedDir(layout, MANAGED_ID)}/demoted.json`,
      "{not json",
    );
    assert(await isManagedMemberDemoted(layout, MANAGED_ID));
    await clearManagedDemotionArtifacts(layout, MANAGED_ID, {
      engine: "redis",
      run: NO_DOCKER,
    });
    assertEquals(await isManagedMemberDemoted(layout, MANAGED_ID), false);
  });
});

const MYSQL_COMPOSE = [
  "services:",
  "  db:",
  "    image: mysql:8.4",
  "    volumes:",
  "      - fence_data:/var/lib/mysql",
  "volumes:",
  "  fence_data:",
  "    name: fence_data",
  "",
].join("\n");

async function seedMysqlFence(
  layout: ReturnType<typeof resolveLayout>,
  managedId: string,
): Promise<void> {
  const root = managedDir(layout, managedId);
  await Deno.mkdir(join(root, "config"), { recursive: true });
  await Deno.writeTextFile(join(root, "docker-compose.yml"), MYSQL_COMPOSE);
  await Deno.writeTextFile(join(root, "config", MYSQL_FAMILY_CNF_FILE), "");
  await writeManagedDemotedMarker(
    layout,
    managedId,
    MEMBER_ID,
    "2026-10-08T12:00:00.000Z",
    "mysql",
  );
}

test("maybeClearDemotedMarkerAfterApply removes the mysql my.cnf fence block, then the marker", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_marker_clear_${crypto.randomUUID()}`;
    await seedMysqlFence(layout, managedId);
    const fake = fakeMysqlCnfDocker(
      withDemotedFenceBlock("[mysqld]\nport=3306\n", "mysql"),
    );
    await maybeClearDemotedMarkerAfterApply(
      layout,
      { managedId, memberRole: "replica", engine: "mysql" },
      "ready",
      fake.run,
    );
    assertEquals(fake.content(), "[mysqld]\nport=3306\n");
    assertEquals(await isManagedMemberDemoted(layout, managedId), false);
  });
});

for (
  const [label, options] of [
    ["read fails", { readFails: true }],
    ["write fails", { writeFails: true }],
    ["write is lost", { writeIsLost: true }],
  ] as const
) {
  test(`clearing a mysql fence keeps the marker when the my.cnf ${label}`, async () => {
    await withTempLayout(async ({ env }) => {
      const layout = resolveLayout(env);
      const managedId = `managed_marker_keep_${crypto.randomUUID()}`;
      await seedMysqlFence(layout, managedId);
      const fake = fakeMysqlCnfDocker(
        withDemotedFenceBlock("[mysqld]\n", "mysql"),
        options,
      );
      await assertRejects(() =>
        clearManagedDemotionArtifacts(layout, managedId, {
          engine: "mysql",
          run: fake.run,
        })
      );
      assert(await isManagedMemberDemoted(layout, managedId));
    });
  });
}

test("clearManagedDemotionArtifacts propagates a marker removal failure", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    await writeManagedDemotedMarker(
      layout,
      MANAGED_ID,
      MEMBER_ID,
      "2026-10-08T12:00:00.000Z",
    );
    const originalRemove = Deno.remove.bind(Deno);
    Deno.remove = () => Promise.reject(new Deno.errors.PermissionDenied("ro"));
    try {
      await assertRejects(
        () =>
          clearManagedDemotionArtifacts(layout, MANAGED_ID, {
            engine: "redis",
            run: NO_DOCKER,
          }),
        Deno.errors.PermissionDenied,
      );
    } finally {
      Deno.remove = originalRemove;
    }
    assert(await isManagedMemberDemoted(layout, MANAGED_ID));
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
    assert(await isManagedMemberDemoted(layout, managedId));
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
