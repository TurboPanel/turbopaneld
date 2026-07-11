import { runDockerSetup } from "../orchestration/ansible.ts";

const DOCKER_BIN = "/usr/bin/docker";

export async function ensureDocker(): Promise<void> {
  try {
    const stat = await Deno.stat(DOCKER_BIN);
    if (stat.isFile) return;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }

  await runDockerSetup();
}
