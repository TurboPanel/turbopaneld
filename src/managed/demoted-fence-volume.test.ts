import { assert, assertEquals } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import {
  clearDemotedVolumeFence,
  MYSQL_FAMILY_DEMOTED_FENCE_CNF_REL,
  persistDemotedVolumeFence,
} from "./demoted-fence-volume.ts";
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
          stdout: "absent\n",
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

for (const engine of ["mysql", "mariadb"] as const) {
  test(`persistDemotedVolumeFence writes read_only config for ${engine}`, async () => {
    await withTempLayout(async ({ env }) => {
      const layout = resolveLayout(env);
      const managedId = `managed_fence_${engine}_${crypto.randomUUID()}`;
      const root = managedDir(layout, managedId);
      await Deno.mkdir(root, { recursive: true });
      await Deno.writeTextFile(
        `${root}/docker-compose.yml`,
        MYSQL_COMPOSE.replace(
          "mysql:8.4",
          engine === "mariadb" ? "mariadb:11" : "mysql:8.4",
        ),
      );
      const run = (): Promise<DockerCliResult> =>
        Promise.resolve({
          success: true,
          code: 0,
          stdout: "",
          stderr: "",
        });
      await persistDemotedVolumeFence(layout, managedId, engine, run);
      const cnf = await Deno.readTextFile(
        join(root, "config", MYSQL_FAMILY_DEMOTED_FENCE_CNF_REL),
      );
      assert(cnf.includes("read_only=1"));
      if (engine === "mysql") {
        assert(cnf.includes("super_read_only=1"));
      } else {
        assertEquals(cnf.includes("super_read_only"), false);
      }
      await clearDemotedVolumeFence(layout, managedId, engine, run);
      let statErr: unknown;
      try {
        await Deno.stat(
          join(root, "config", MYSQL_FAMILY_DEMOTED_FENCE_CNF_REL),
        );
      } catch (err) {
        statErr = err;
      }
      assert(statErr instanceof Deno.errors.NotFound);
    });
  });
}
