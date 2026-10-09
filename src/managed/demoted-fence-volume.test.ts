import { assert, assertEquals } from "@std/assert";
import type { DockerCliResult } from "../deploy/docker-cli.ts";
import { resolveLayout } from "../paths/layout.ts";
import { withTempLayout } from "../testing/temp-layout.ts";
import { persistDemotedVolumeFence } from "./demoted-fence-volume.ts";
import { managedDir } from "./engine-paths.ts";

const test = Deno.test.bind(Deno);

const COMPOSE = [
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

test("persistDemotedVolumeFence plants postgres standby.signal on the data volume", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_fence_vol_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(`${root}/docker-compose.yml`, COMPOSE);

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

test("persistDemotedVolumeFence is a no-op for mysql", async () => {
  await withTempLayout(async ({ env }) => {
    const layout = resolveLayout(env);
    const managedId = `managed_fence_mysql_${crypto.randomUUID()}`;
    const root = managedDir(layout, managedId);
    await Deno.mkdir(root, { recursive: true });
    await Deno.writeTextFile(`${root}/docker-compose.yml`, COMPOSE);
    let runs = 0;
    const run = (): Promise<DockerCliResult> => {
      runs++;
      return Promise.resolve({
        success: true,
        code: 0,
        stdout: "",
        stderr: "",
      });
    };
    await persistDemotedVolumeFence(layout, managedId, "mysql", run);
    assertEquals(runs, 0);
  });
});
