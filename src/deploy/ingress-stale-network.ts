import type { DockerCliResult, RunDockerOptions } from "./docker-cli.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

const NETWORK_ENTRY_FORMAT =
  "{{.Id}} {{range $name, $net := .NetworkSettings.Networks}}{{$name}}={{$net.NetworkID}} {{end}}";

/**
 * Container ids in `lines` (one `<id> <network>=<networkId> ...` row each,
 * from {@link NETWORK_ENTRY_FORMAT}) that are attached to `network` under an
 * id other than `networkId`: they were created before the network was removed
 * and recreated, so Docker can no longer start them.
 */
export function staleNetworkContainerIds(
  lines: string,
  network: string,
  networkId: string,
): string[] {
  const prefix = `${network}=`;
  return lines.split("\n").flatMap((line) => {
    const [id, ...attachments] = line.trim().split(/\s+/);
    if (!id) return [];
    const attached = attachments.find((a) => a.startsWith(prefix));
    return attached !== undefined && attached.slice(prefix.length) !== networkId
      ? [id]
      : [];
  });
}

/**
 * Remove the containers of compose project `project` that still point at a
 * deleted incarnation of `network`. A network deleted by hand and recreated
 * under the same name gets a new id; `compose up` reuses the old container
 * and fails with "network <id> not found" on every later deploy. Removing it
 * lets `compose up` recreate it on the live network. Containers on the live
 * network are untouched.
 */
export async function removeStaleNetworkContainers(
  project: string,
  network: string,
  run: RunDockerFn,
): Promise<void> {
  const net = await run(["network", "inspect", "-f", "{{.Id}}", network]);
  const networkId = net.success ? net.stdout.trim() : "";
  if (networkId === "") return;
  const listed = await run([
    "ps",
    "-aq",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);
  const ids = listed.success ? listed.stdout.split(/\s+/).filter(Boolean) : [];
  if (ids.length === 0) return;
  const inspected = await run([
    "inspect",
    "-f",
    NETWORK_ENTRY_FORMAT,
    ...ids,
  ]);
  if (!inspected.success) return;
  const stale = staleNetworkContainerIds(inspected.stdout, network, networkId);
  if (stale.length === 0) return;
  const removed = await run(["rm", "-f", ...stale]);
  if (!removed.success) {
    throw new Error(
      removed.stderr || "Removing stale ingress containers failed",
    );
  }
}
