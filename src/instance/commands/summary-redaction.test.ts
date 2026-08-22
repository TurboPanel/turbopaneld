/**
 * Failure-summary redaction.
 *
 * A transcript line is scrubbed on its way to the spool, but a *summary* — the
 * process stdout/stderr a handler turns into a thrown error, and the router
 * turns into `command-outcome.error` — bypasses that path entirely and is
 * persisted in command history. These tests pin that both halves are redacted:
 * a decrypted secret that shows up in Docker or hook stderr must reach neither.
 *
 * Host-free: every Docker call is injected, and the one real process spawned is
 * `sh` echoing a fixture string.
 */

import { assert, assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import type { DockerCliResult } from "../../deploy/docker-cli.ts";
import { RUNTIME_COMPOSE_FILENAME } from "../../deploy/compose-files.ts";
import { runDeployServiceHooks } from "../../deploy/run-deploy-hooks.ts";
import { createCommandOutputSink } from "../../logs/sink.ts";
import { REDACTED } from "../../logs/redactor.ts";
import {
  rememberSecretPlaintexts,
  resetSharedSecretRedactorForTests,
} from "../../logs/redactor.ts";
import type { CommandDispatchMessage } from "./contracts.ts";
import { handleEnvironmentStop } from "./stop-environment.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Stands in for a value the daemon just decrypted out of a sealed envelope. */
const FAKE_SECRET = "s3cr3t-decrypted-pgpassword-9f2c";

type TempStateDir = {
  stateDir: string;
  restore: () => Promise<void>;
};

async function withTempStateDir(prefix: string): Promise<TempStateDir> {
  const root = await Deno.makeTempDir({ prefix });
  const previous = {
    state: Deno.env.get("TURBOPANEL_STATE_DIR"),
    config: Deno.env.get("TURBOPANEL_CONFIG_DIR"),
  };
  const stateDir = join(root, "state");
  Deno.env.set("TURBOPANEL_STATE_DIR", stateDir);
  Deno.env.set("TURBOPANEL_CONFIG_DIR", join(root, "config"));
  return {
    stateDir,
    restore: async () => {
      if (previous.state === undefined) Deno.env.delete("TURBOPANEL_STATE_DIR");
      else Deno.env.set("TURBOPANEL_STATE_DIR", previous.state);
      if (previous.config === undefined) {
        Deno.env.delete("TURBOPANEL_CONFIG_DIR");
      } else Deno.env.set("TURBOPANEL_CONFIG_DIR", previous.config);
      await Deno.remove(root, { recursive: true });
    },
  };
}

/** Every transcript byte the sink handed to the uploader. */
function collectTranscript(chunks: string[]): string {
  return chunks.join("");
}

test({
  name:
    "docker stderr carrying a decrypted secret is redacted in the transcript and the thrown summary",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const temp = await withTempStateDir("tp-summary-docker-");
    const chunks: string[] = [];
    try {
      const environmentId = "envredact1";
      const projectId = "proj-1";
      const deploymentDir = join(
        temp.stateDir,
        "deployments",
        projectId,
        environmentId,
      );
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });
      await Deno.writeTextFile(
        join(deploymentDir, RUNTIME_COMPOSE_FILENAME),
        "services:\n  web:\n    image: nginx:alpine\n",
        { mode: 0o640 },
      );

      const logSink = createCommandOutputSink({
        commandId: "cmd-summary-1",
        phase: "environment.stop",
        secrets: [FAKE_SECRET],
        layout: { daemonStateDir: temp.stateDir },
        send: (params) => {
          chunks.push(params.bytes);
          return Promise.resolve({ nextSeq: params.seq + 1 });
        },
      });

      // Compose echoes the container's environment back on failure.
      const failingRunDocker = (): Promise<DockerCliResult> =>
        Promise.resolve({
          success: false,
          stdout: "",
          stderr:
            `Error response from daemon: POSTGRES_PASSWORD=${FAKE_SECRET} rejected`,
          code: 1,
        });

      const rejected = await assertRejects(
        () =>
          handleEnvironmentStop(
            {
              environmentId,
              projectId,
              projectName: "tp-demo-envredact",
            },
            new Date().toISOString(),
            { runDocker: failingRunDocker, logSink },
          ),
        Error,
      );

      assertEquals(rejected.message.includes(FAKE_SECRET), false);
      assert(rejected.message.includes(REDACTED));
      assert(rejected.message.includes("Error response from daemon"));

      await logSink.finalize();
      const transcript = collectTranscript(chunks);
      assert(transcript.length > 0);
      assertEquals(transcript.includes(FAKE_SECRET), false);
      assert(transcript.includes(REDACTED));
    } finally {
      await temp.restore();
    }
  },
});

test({
  name:
    "deploy hook stderr carrying a decrypted secret is redacted in the transcript and the thrown summary",
  permissions: { env: true, read: true, write: true, run: true },
  fn: async () => {
    const temp = await withTempStateDir("tp-summary-hook-");
    const chunks: string[] = [];
    try {
      const deploymentDir = join(temp.stateDir, "hookcwd");
      await Deno.mkdir(deploymentDir, { recursive: true, mode: 0o750 });

      const logSink = createCommandOutputSink({
        commandId: "cmd-summary-2",
        phase: "pre-deploy",
        secrets: [FAKE_SECRET],
        layout: { daemonStateDir: temp.stateDir },
        send: (params) => {
          chunks.push(params.bytes);
          return Promise.resolve({ nextSeq: params.seq + 1 });
        },
      });

      const rejected = await assertRejects(
        () =>
          runDeployServiceHooks(
            [{
              composeServiceName: "web",
              preDeployCommand:
                `printf 'migrate failed for %s\\n' "${FAKE_SECRET}" >&2; exit 1`,
            }],
            {
              projectName: "tp-demo-hookredact",
              composePaths: [join(deploymentDir, RUNTIME_COMPOSE_FILENAME)],
              deploymentDir,
              runDocker: () =>
                Promise.resolve({
                  success: true,
                  stdout: "",
                  stderr: "",
                  code: 0,
                }),
              onOutput: (stream, line) => logSink.onLine(stream, line),
              redactSummary: (text) => logSink.redactSummary(text),
            },
          ),
        Error,
      );

      assertEquals(rejected.message.includes(FAKE_SECRET), false);
      assert(rejected.message.includes(REDACTED));
      assert(rejected.message.includes("migrate failed for"));

      await logSink.finalize();
      const transcript = collectTranscript(chunks);
      assertEquals(transcript.includes(FAKE_SECRET), false);
      assert(transcript.includes(REDACTED));
    } finally {
      await temp.restore();
    }
  },
});

test({
  name:
    "command-outcome.error is redacted against the deny-set on the router's catch path",
  permissions: { env: true, sys: ["hostname"], read: true, write: true },
  fn: async () => {
    const temp = await withTempStateDir("tp-summary-router-");
    const {
      handleCommandDispatch,
      setCommandRouterHandlersForTests,
    } = await import("./command-router.ts");
    resetSharedSecretRedactorForTests();
    try {
      // The decrypt seam remembers every plaintext it produced, process-wide.
      rememberSecretPlaintexts([FAKE_SECRET]);
      setCommandRouterHandlersForTests({
        handleEnvironmentDeploy: () => {
          throw new Error(
            `ansible-playbook failed: vault_password=${FAKE_SECRET}`,
          );
        },
      });

      const frames: string[] = [];
      const ws = {
        readyState: WebSocket.OPEN,
        send: (data: string) => frames.push(data),
      } as unknown as WebSocket;
      const message: CommandDispatchMessage = {
        type: "command-dispatch",
        id: "req-redact",
        commandId: "cmd-summary-3",
        commandType: "environment.deploy",
        payload: {
          environmentId: "env-1",
          projectId: "proj-1",
          organizationId: "org-1",
          projectName: "tp-demo-redact",
          composeFiles: [{
            filename: "compose.yaml",
            role: "runtime",
            content: "services: {}\n",
          }],
          hostings: [],
        },
        at: new Date().toISOString(),
      };

      await handleCommandDispatch(message, ws, {
        sendCommandLogChunk: () => Promise.resolve({ nextSeq: 1 }),
      });

      const outcome = frames
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .find((frame) => frame.type === "command-outcome");
      assertEquals(outcome?.ok, false);
      const error = String(outcome?.error ?? "");
      assertEquals(error.includes(FAKE_SECRET), false);
      assert(error.includes(REDACTED));
      assert(error.includes("ansible-playbook failed"));
    } finally {
      setCommandRouterHandlersForTests(null);
      resetSharedSecretRedactorForTests();
      await temp.restore();
    }
  },
});
