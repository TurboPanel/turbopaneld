/**
 * Bounded on-demand container log tail.
 *
 * Transport: correlated cell request `container-logs-request` →
 * `container-logs-result` (see instance `daemon/cell/protocol.ts`). A snapshot
 * per request — never `--follow`, which would hold the Durable Object awake.
 * Output is redacted and discarded; nothing is stored.
 */

import {
  createStreamedRunner,
  type DockerCliResult,
  runDocker as defaultRunDocker,
  type RunDockerOptions,
} from "../deploy/docker-cli.ts";
import {
  LABEL_COMPOSE_PROJECT,
  LABEL_COMPOSE_SERVICE,
} from "../deploy/labels.ts";
import {
  listLocalDeploymentManifests,
  type LocalDeploymentManifest,
} from "../deploy/compose-files.ts";
import { sanitizeForLog } from "../logger.ts";
import {
  type MutableTranscriptRedactor,
  sharedSecretRedactor,
} from "./redactor.ts";

type RunDockerFn = (
  args: string[],
  options?: RunDockerOptions,
) => Promise<DockerCliResult>;

type ListManifestsFn = (layout: {
  stateDir: string;
}) => Promise<LocalDeploymentManifest[]>;

const DEFAULT_TAIL = 200;
const MAX_TAIL = 2_000;
/** Stay under the cell `MAX_DAEMON_WS_LOGS_CHARS` / UTF-8 frame wire cap. */
const MAX_LOG_BYTES = 200 * 1024;
const COLLECT_TIMEOUT_MS = 15_000;
const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();

/** Docker ids and names: letters, digits, underscore, dot, hyphen. */
const SAFE_CONTAINER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export type CollectContainerLogsOptions = {
  tail?: number;
  stateDir: string;
};

export type CollectContainerLogsDeps = {
  runDocker?: RunDockerFn;
  listManifests?: ListManifestsFn;
  redactor?: MutableTranscriptRedactor;
  now?: () => number;
};

function clampTail(raw: number | undefined): number {
  const value = raw ?? DEFAULT_TAIL;
  return Math.min(Math.max(1, Math.floor(value)), MAX_TAIL);
}

/** Keep the tail of `text` within {@link MAX_LOG_BYTES} UTF-8 bytes. */
function truncateLogs(text: string): string {
  const encoded = utf8Encoder.encode(text);
  if (encoded.byteLength <= MAX_LOG_BYTES) return text;
  const slice = encoded.subarray(encoded.byteLength - MAX_LOG_BYTES);
  let start = 0;
  // Skip a leading continuation so the cut stays on a code-point boundary.
  while (
    start < slice.length && (slice[start]! & 0b1100_0000) === 0b1000_0000
  ) {
    start += 1;
  }
  return utf8Decoder.decode(slice.subarray(start));
}

function combineLogOutput(lines: string[], result: DockerCliResult): string {
  if (lines.length > 0) return lines.join("\n");
  const chunks: string[] = [];
  if (result.stdout.length > 0) chunks.push(result.stdout);
  if (result.stderr.length > 0) chunks.push(result.stderr);
  return chunks.join("\n");
}

async function runWithTimeout(
  work: Promise<DockerCliResult>,
  timeoutMs: number,
  now: () => number,
): Promise<DockerCliResult> {
  const started = now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<DockerCliResult>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error("container logs timed out"));
        }, Math.max(1, timeoutMs - (now() - started)));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function parseComposeLabels(stdout: string): {
  composeProject: string;
  composeService: string;
} {
  const [projectLine, serviceLine] = stdout.split("\n");
  return {
    composeProject: projectLine?.trim() ?? "",
    composeService: serviceLine?.trim() ?? "",
  };
}

function isOwnedByLocalManifests(
  composeProject: string,
  composeService: string,
  manifests: readonly LocalDeploymentManifest[],
): boolean {
  if (composeProject.length === 0 || composeService.length === 0) return false;
  for (const { manifest } of manifests) {
    if (manifest.projectName !== composeProject) continue;
    if (manifest.serviceIds?.[composeService]) return true;
  }
  return false;
}

/**
 * `docker container logs --tail <N> --timestamps`, after confirming the
 * container belongs to a `deployment.json` this daemon wrote.
 */
export async function collectContainerLogs(
  containerId: string,
  options: CollectContainerLogsOptions,
  deps: CollectContainerLogsDeps = {},
): Promise<string> {
  if (!SAFE_CONTAINER_ID_RE.test(containerId)) {
    throw new Error("containerId contains unsupported characters");
  }

  const run = deps.runDocker ?? defaultRunDocker;
  const listManifests = deps.listManifests ?? listLocalDeploymentManifests;
  const redactor = deps.redactor ?? sharedSecretRedactor();
  const now = deps.now ?? Date.now;
  const tail = clampTail(options.tail);

  const inspect = await runWithTimeout(
    run([
      "inspect",
      "--format",
      `{{index .Config.Labels "${LABEL_COMPOSE_PROJECT}"}}\n{{index .Config.Labels "${LABEL_COMPOSE_SERVICE}"}}`,
      containerId,
    ]),
    COLLECT_TIMEOUT_MS,
    now,
  );
  if (!inspect.success) {
    throw new Error(
      `container inspect failed: ${
        sanitizeForLog(inspect.stderr || "inspect failed")
      }`,
    );
  }

  const { composeProject, composeService } = parseComposeLabels(inspect.stdout);
  const manifests = await listManifests({ stateDir: options.stateDir });
  if (!isOwnedByLocalManifests(composeProject, composeService, manifests)) {
    throw new Error("container is not owned by this host");
  }

  const lines: string[] = [];
  const result = await runWithTimeout(
    createStreamedRunner(deps.runDocker)(
      [
        "container",
        "logs",
        "--tail",
        String(tail),
        "--timestamps",
        containerId,
      ],
      { onLine: ({ line }) => lines.push(line) },
    ),
    COLLECT_TIMEOUT_MS,
    now,
  );

  if (!result.success) {
    throw new Error(
      `container logs failed: ${
        sanitizeForLog(result.stderr || "container logs failed")
      }`,
    );
  }

  const combined = combineLogOutput(lines, result);
  // Redact first so replacements cannot grow past the UTF-8 protocol cap.
  return truncateLogs(redactor.redact(combined));
}
