/**
 * The enforcing gate in front of a real Docker engine, driven by the real
 * `docker` client, for the one allowance that has to line up with the daemon's
 * own writer: the files Compose `secrets:` and `configs:` bind from
 * `<runDir>/deployments/<project>/<environment>/(secrets|configs)/<name>`.
 * Those sources sit under the denied `/run` prefix, so the gate must let the
 * platform's own generated files through for the tenant that owns them, and
 * refuse everything else under `/run`: another project's files, a writable
 * mount, a directory, a link, a container nothing stamped, and any other path.
 *
 * The paths come from the daemon's writer functions (`secretHostPath`,
 * `configHostDirectory`), so a change to either side that stops them agreeing
 * fails here. Containers are only created (never started), then removed.
 * Runs only where Docker is reachable, an image is available and the daemon's
 * run folder is writable (the Incus test VM, a CI runner).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  loadConfig,
  startGate,
} from "../../orchestration/roles/docker-gate/files/main.ts";
import type { LogRecord } from "../../orchestration/roles/docker-gate/files/proxy.ts";
import { configHostDirectory } from "../deploy/config-files.ts";
import { secretHostPath, writeFileAtomic } from "../deploy/secret-runtime.ts";
import { PROD_RUN_DIR_DEFAULT } from "../paths/layout.ts";
import { docker, dockerReachable } from "../testing/docker-run.ts";

const test = Deno.test.bind(Deno);

const IMAGE =
  "docker.io/library/alpine:3.22@sha256:5291449c3df73caf6ed85e649dec1b9e818b39a5d8c871e97afc13e9cd5e8fa8";
const ENGINE_SOCKET = "/var/run/docker.sock";
const LAYOUT = { runDir: PROD_RUN_DIR_DEFAULT };

async function runDirWritable(): Promise<boolean> {
  try {
    const probe = await Deno.makeTempDir({ dir: LAYOUT.runDir });
    await Deno.remove(probe);
    return true;
  } catch {
    return false;
  }
}

async function imageAvailable(): Promise<boolean> {
  if ((await docker(["image", "inspect", IMAGE])).success) return true;
  return (await docker(["pull", "--quiet", IMAGE])).success;
}

const AVAILABLE = await dockerReachable() && await runDirWritable() &&
  await imageAvailable();

type Created = { ok: boolean; stderr: string };

async function viaGate(
  socket: string,
  args: string[],
): Promise<Created> {
  const child = await new Deno.Command("docker", {
    args,
    env: { DOCKER_HOST: `unix://${socket}`, PATH: Deno.env.get("PATH") ?? "" },
    clearEnv: true,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    ok: child.success,
    stderr: new TextDecoder().decode(child.stderr),
  };
}

test({
  name:
    "enforce mode against a real engine: a tenant binds its own generated files and nothing else under /run",
  ignore: !AVAILABLE,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "tp-gate-e2e-" });
    const projectId = crypto.randomUUID();
    const otherProjectId = crypto.randomUUID();
    const environmentId = crypto.randomUUID();
    const logs: LogRecord[] = [];
    const created: string[] = [];
    const gateSocket = join(tmp, "docker.sock");
    const gate = await startGate(
      loadConfig({
        TP_DOCKER_GATE_MODE: "enforce",
        TP_DOCKER_GATE_SOCKET: gateSocket,
        TP_DOCKER_GATE_UPSTREAM: ENGINE_SOCKET,
        TP_DOCKER_GATE_SUMMARY_SEC: "3600",
      }),
      (record) => logs.push(record),
    );
    const mine = secretHostPath(
      LAYOUT,
      projectId,
      environmentId,
      "db_password",
    );
    const theirs = secretHostPath(
      LAYOUT,
      otherProjectId,
      environmentId,
      "db_password",
    );
    const configDir = configHostDirectory(LAYOUT, projectId, environmentId);
    const link = join(configDir, "linked.conf");
    const label = (project: string) => [
      "--label",
      `io.turbopanel.project=${project}`,
      "--label",
      `io.turbopanel.environment=${environmentId}`,
    ];
    let seq = 0;
    const create = async (
      labels: string[],
      mount: string,
    ): Promise<Created> => {
      const name = `tp-gate-e2e-${projectId.slice(0, 8)}-${seq++}`;
      const result = await viaGate(gateSocket, [
        "create",
        "--name",
        name,
        ...labels,
        "-v",
        mount,
        IMAGE,
        "true",
      ]);
      if (result.ok) created.push(name);
      return result;
    };
    try {
      await writeFileAtomic(mine, "s3cret\n", 0o444);
      await writeFileAtomic(theirs, "other\n", 0o444);
      await writeFileAtomic(join(configDir, "app.conf"), "a=1\n", 0o444);
      await Deno.symlink("/etc/passwd", link);

      // The platform's own generated files, read-only, for the owning tenant.
      const secret = await create(
        label(projectId),
        `${mine}:/run/secrets/x:ro`,
      );
      assert(
        secret.ok,
        `a tenant's own secret file is refused: ${secret.stderr}`,
      );
      const config = await create(
        label(projectId),
        `${join(configDir, "app.conf")}:/etc/app.conf:ro`,
      );
      assert(
        config.ok,
        `a tenant's own config file is refused: ${config.stderr}`,
      );

      // Everything else under /run (and the same file the wrong way) is a 403.
      const hostile: Array<[string, string[], string]> = [
        ["another project's secret", label(projectId), `${theirs}:/x:ro`],
        ["the same file, writable", label(projectId), `${mine}:/x`],
        [
          "the secrets directory",
          label(projectId),
          `${join(mine, "..")}:/x:ro`,
        ],
        ["a link in the config folder", label(projectId), `${link}:/x:ro`],
        ["the run folder", label(projectId), `${LAYOUT.runDir}:/x:ro`],
        [
          "a daemon file outside deployments",
          label(projectId),
          `${join(LAYOUT.runDir, "daemon.lock")}:/x:ro`,
        ],
        ["a secret of an unstamped container", [], `${mine}:/x:ro`],
        ["the engine socket", label(projectId), `${ENGINE_SOCKET}:/x:ro`],
        ["the host root", label(projectId), "/:/x:ro"],
        ["a path under /run", label(projectId), "/run/lock:/x:ro"],
      ];
      for (const [what, labels, mount] of hostile) {
        const result = await create(labels, mount);
        assertEquals(result.ok, false, `${what} was created`);
        assertStringIncludes(
          result.stderr,
          "refused by the Docker gate",
          `${what}: not the gate's refusal (${result.stderr})`,
        );
      }

      const denied = logs.filter((l) => l.event === "docker-gate.denied");
      assertEquals(denied.length, hostile.length);
      // Each finding is logged once (would-deny, the rule that fired) and each
      // refused request once more as denied; the two allowed creates add none.
      const findings = logs.filter((l) => l.event === "docker-gate.would-deny");
      assert(findings.length >= hostile.length);
      // Nothing the gate refused exists in the engine.
      const listed = await docker([
        "ps",
        "-a",
        "--filter",
        `name=tp-gate-e2e-${projectId.slice(0, 8)}`,
        "--format",
        "{{.Names}}",
      ]);
      assertEquals(
        listed.stdout.split("\n").filter(Boolean).sort(),
        [...created].sort(),
      );
    } finally {
      for (const name of created) await docker(["rm", "-f", name]);
      await gate.stop();
      for (const id of [projectId, otherProjectId]) {
        await Deno.remove(join(LAYOUT.runDir, "deployments", id), {
          recursive: true,
        }).catch(() => {});
      }
      await Deno.remove(tmp, { recursive: true });
    }
  },
});
