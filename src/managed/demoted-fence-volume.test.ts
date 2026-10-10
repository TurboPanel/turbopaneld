import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  clearDemotedVolumeFence,
  DEMOTED_FENCE_BEGIN,
  DEMOTED_FENCE_END,
  MYSQL_FAMILY_CNF_FILE,
  persistDemotedVolumeFence,
  withDemotedFenceBlock,
  withoutDemotedFenceBlock,
} from "./demoted-fence-volume.ts";
import { fakeMysqlCnfDocker } from "../testing/fake-mysql-cnf-docker.ts";
import { managedDir } from "./engine-paths.ts";

const test = Deno.test.bind(Deno);

const POSTGRES_COMPOSE = [
  "services:",
  "  db:",
  "    image: postgres:18",
  "    volumes:",
  "      - fence_data:/var/lib/postgresql",
  "volumes:",
  "  fence_data:",
  "    name: fence_data",
  "",
].join("\n");

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

test("persistDemotedVolumeFence plants postgres standby.signal on the data volume", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_fence_vol_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(`${root}/docker-compose.yml`, POSTGRES_COMPOSE);

    const touched: string[] = [];
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "run") {
        const script = args.at(-1) ?? "";
        if (script.startsWith("touch ")) touched.push(script);
        return Promise.resolve({
          success: true,
          code: 0,
          stdout: touched.length > 0 ? "present\n" : "absent\n",
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

    await persistDemotedVolumeFence(layout, managedId, "postgres", run);
    assertEquals(touched.length, 1);
    assert(touched[0]!.includes("standby.signal"));
  });
});

test("persistDemotedVolumeFence skips planting when standby.signal already exists", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_fence_present_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(`${root}/docker-compose.yml`, POSTGRES_COMPOSE);
    const touched: string[] = [];
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "run") {
        const script = args.at(-1) ?? "";
        if (script.startsWith("touch ")) touched.push(script);
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
    await persistDemotedVolumeFence(layout, managedId, "postgres", run);
    assertEquals(touched.length, 0);
  });
});

test("clearDemotedVolumeFence propagates postgres standby.signal removal failures", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_fence_clear_fail_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(`${root}/docker-compose.yml`, POSTGRES_COMPOSE);
    const run = (args: string[]): Promise<DockerCliResult> => {
      if (args[0] === "run") {
        const script = args.at(-1) ?? "";
        if (script.includes("rm -f")) {
          return Promise.resolve({
            success: false,
            code: 1,
            stdout: "",
            stderr: "rm failed",
          });
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
    await assertRejects(
      () => clearDemotedVolumeFence(layout, managedId, "postgres", run),
      Error,
      "could not remove standby.signal",
    );
  });
});

test("clearDemotedVolumeFence fails when standby.signal survives the remove", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_fence_clear_lost_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(`${root}/docker-compose.yml`, POSTGRES_COMPOSE);
    // Every probe still reports the file: the remove "succeeded" but did not.
    const run = (): Promise<DockerCliResult> =>
      Promise.resolve({
        success: true,
        code: 0,
        stdout: "present\n",
        stderr: "",
      });
    await assertRejects(
      () => clearDemotedVolumeFence(layout, managedId, "postgres", run),
      Error,
      "still present after clear",
    );
  });
});

test("persistDemotedVolumeFence fails when standby.signal is missing after the write", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_fence_plant_lost_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(`${root}/docker-compose.yml`, POSTGRES_COMPOSE);
    const run = (): Promise<DockerCliResult> =>
      Promise.resolve({
        success: true,
        code: 0,
        stdout: "absent\n",
        stderr: "",
      });
    await assertRejects(
      () => persistDemotedVolumeFence(layout, managedId, "postgres", run),
      Error,
      "missing after write",
    );
  });
});

function seedMysqlFamily(
  engine: "mysql" | "mariadb",
  withCnf = true,
) {
  const managedId = `managed_fence_${engine}_${crypto.randomUUID()}`;
  return {
    managedId,
    seed: async (layout: ReturnType<typeof resolveLayout>) => {
      const root = managedDir(layout, managedId);
      await Deno.mkdir(join(root, "config"), { recursive: true });
      await Deno.writeTextFile(
        `${root}/docker-compose.yml`,
        MYSQL_COMPOSE.replace(
          "mysql:8.4",
          engine === "mariadb" ? "mariadb:11" : "mysql:8.4",
        ),
      );
      if (withCnf) {
        await Deno.writeTextFile(
          join(root, "config", MYSQL_FAMILY_CNF_FILE),
          "",
        );
      }
    },
  };
}

const PRIMARY_CNF = "[mysqld]\nserver_id=1\nread_only=OFF\n";

for (const engine of ["mysql", "mariadb"] as const) {
  test(`persistDemotedVolumeFence appends a read-only block to the mounted my.cnf for ${engine}`, async () => {
    await withTempLayout(async ({ env }) => {
      const layout = resolveLayout(env);
      const { managedId, seed } = seedMysqlFamily(engine);
      await seed(layout);
      const fake = fakeMysqlCnfDocker(PRIMARY_CNF);
      await persistDemotedVolumeFence(layout, managedId, engine, fake.run);
      const cnf = fake.content();
      assert(cnf.startsWith(PRIMARY_CNF));
      // The fence block comes last so it wins over the primary's read_only=OFF.
      assert(cnf.trimEnd().endsWith(DEMOTED_FENCE_END));
      assert(cnf.includes("read_only=1"));
      assertEquals(cnf.includes("super_read_only=1"), engine === "mysql");
      // The helper runs as root against the config dir the engine mounts.
      const write = fake.calls.find((args) => args.includes("sh"));
      assert(write?.includes("0"));
      assert(write?.some((arg) => arg.endsWith("/config:/c")));
      // Re-planting a complete block is a read-only check.
      await persistDemotedVolumeFence(layout, managedId, engine, fake.run);
      assertEquals(fake.writes(), 1);
      await clearDemotedVolumeFence(layout, managedId, engine, fake.run);
      assertEquals(fake.content(), PRIMARY_CNF);
    });
  });
}

test("persistDemotedVolumeFence repairs a half-written mysql fence block", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const { managedId, seed } = seedMysqlFamily("mysql");
    await seed(layout);
    const fake = fakeMysqlCnfDocker(
      `${PRIMARY_CNF}\n${DEMOTED_FENCE_BEGIN}\n[mysqld]\nread_on`,
    );
    await persistDemotedVolumeFence(layout, managedId, "mysql", fake.run);
    assertEquals(
      fake.content(),
      withDemotedFenceBlock(PRIMARY_CNF, "mysql"),
    );
    assertEquals(fake.content().split(DEMOTED_FENCE_BEGIN).length, 2);
  });
});

for (
  const [label, options, message] of [
    ["the read fails", { readFails: true }, "could not read"],
    ["the write fails", { writeFails: true }, "could not write"],
    ["the write is lost", { writeIsLost: true }, "missing after write"],
  ] as const
) {
  test(`persistDemotedVolumeFence throws for mysql when ${label}`, async () => {
    await withTempLayout(async ({ env }) => {
      const layout = resolveLayout(env);
      const { managedId, seed } = seedMysqlFamily("mysql");
      await seed(layout);
      const fake = fakeMysqlCnfDocker(PRIMARY_CNF, options);
      await assertRejects(
        () => persistDemotedVolumeFence(layout, managedId, "mysql", fake.run),
        Error,
        message,
      );
    });
  });
}

test("persistDemotedVolumeFence throws for mysql when config/my.cnf is missing", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const { managedId, seed } = seedMysqlFamily("mysql", false);
    await seed(layout);
    const fake = fakeMysqlCnfDocker("");
    await assertRejects(
      () => persistDemotedVolumeFence(layout, managedId, "mysql", fake.run),
      Error,
      "missing",
    );
  });
});

test("clearDemotedVolumeFence for mysql is a no-op without my.cnf and fails when the block survives", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const missing = seedMysqlFamily("mysql", false);
    await missing.seed(layout);
    const none = fakeMysqlCnfDocker("");
    await clearDemotedVolumeFence(layout, missing.managedId, "mysql", none.run);
    assertEquals(none.calls.length, 0);

    const present = seedMysqlFamily("mysql");
    await present.seed(layout);
    const lost = fakeMysqlCnfDocker(
      withDemotedFenceBlock(PRIMARY_CNF, "mysql"),
      { writeIsLost: true },
    );
    await assertRejects(
      () =>
        clearDemotedVolumeFence(layout, present.managedId, "mysql", lost.run),
      Error,
      "still present after clear",
    );
  });
});

test("withoutDemotedFenceBlock leaves a file without a block unchanged", () => {
  assertEquals(withoutDemotedFenceBlock(PRIMARY_CNF), PRIMARY_CNF);
  assertEquals(withoutDemotedFenceBlock(""), "");
  assertEquals(
    withDemotedFenceBlock("", "mariadb"),
    `${DEMOTED_FENCE_BEGIN}\n[mariadb]\nread_only=1\n${DEMOTED_FENCE_END}\n`,
  );
});
