import { DockerClient, DockerMonitor } from "./docker/index.ts";
import { connectInstance } from "./instance/client.ts";
import { logInfo, logWarn } from "./logger.ts";
import { createSentinel, type SentinelOptions } from "./monitor/index.ts";
import {
  initOrchestration,
  shouldConnectToInstance,
  shouldEnableDockerIntegration,
} from "./orchestration/setup.ts";
import { startTunnels } from "./tunnels.ts";

logInfo("daemon", "starting up");

const orchestrationReady = await initOrchestration();

const abort = new AbortController();
let shuttingDown = false;

let dockerClient: DockerClient | undefined;
const sentinelOptions: SentinelOptions = {};
if (orchestrationReady && shouldEnableDockerIntegration()) {
  dockerClient = new DockerClient();
  if (!(await dockerClient.ping())) {
    logWarn(
      "docker",
      "Docker socket not reachable yet — monitor will retry on each poll",
    );
  }
  sentinelOptions.dockerMonitor = new DockerMonitor(dockerClient);
}
const sentinel = createSentinel(sentinelOptions);
// TODO(deferred): daemon-side SQLite monitoring store will subscribe to
// sentinel.onTransition() and sentinel.buildHeartbeat() here.
sentinel.start(abort.signal);

await startTunnels(abort.signal);

const instanceHandle = { stop() {} };
let instance: { stop(): void } = instanceHandle;

if (shouldConnectToInstance()) {
  instance = await connectInstance();
} else {
  logInfo(
    "instance",
    "connection deferred until development environment opt-in (TURBOPANEL_DEV_INSTANCE)",
  );
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  Deno.addSignalListener(signal, () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logInfo("daemon", "shutting down");
    instance.stop();
    sentinel.stop();
    try {
      dockerClient?.close();
    } catch {
      // HttpClient may already be closed during systemd restart.
    }
    dockerClient = undefined;
    abort.abort();
  });
}

await new Promise<void>((resolve) => {
  abort.signal.addEventListener("abort", () => resolve());
});

logInfo("daemon", "shut down");
Deno.exit(0);
