import { assertEquals } from "@std/assert";
import {
  COMMAND_LOG_PHASES,
  createNoopCommandOutputSink,
  encodeCommandOutputEvent,
  lifecyclePhase,
} from "./contracts.ts";
import {
  rememberSecretPlaintexts,
  resetSharedSecretRedactorForTests,
} from "./redactor.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("lifecyclePhase maps compose actions and defaults unknown to start", () => {
  assertEquals(lifecyclePhase("start"), COMMAND_LOG_PHASES.LIFECYCLE_START);
  assertEquals(lifecyclePhase("stop"), COMMAND_LOG_PHASES.LIFECYCLE_STOP);
  assertEquals(lifecyclePhase("restart"), COMMAND_LOG_PHASES.LIFECYCLE_RESTART);
  assertEquals(lifecyclePhase("unknown"), COMMAND_LOG_PHASES.LIFECYCLE_START);
});

test("encodeCommandOutputEvent serializes one NDJSON line", () => {
  const encoded = encodeCommandOutputEvent({
    commandId: "cmd-1",
    sequence: 3,
    timestamp: "2026-08-21T00:00:00.000Z",
    stream: "stderr",
    phase: COMMAND_LOG_PHASES.COMPOSE_UP,
    message: "up",
  });
  assertEquals(encoded.endsWith("\n"), true);
  assertEquals(JSON.parse(encoded), {
    commandId: "cmd-1",
    sequence: 3,
    timestamp: "2026-08-21T00:00:00.000Z",
    stream: "stderr",
    phase: COMMAND_LOG_PHASES.COMPOSE_UP,
    message: "up",
  });
});

test("noop sink still redacts summaries from local and process-wide deny-sets", async () => {
  resetSharedSecretRedactorForTests();
  try {
    rememberSecretPlaintexts(["shared-secret"]);
    const sink = createNoopCommandOutputSink();
    sink.onLine("stdout", "ignored");
    sink.setPhase(COMMAND_LOG_PHASES.BUILD);
    sink.addSecrets(["local-secret", null, ""]);
    assertEquals(
      sink.redactSummary("local-secret and shared-secret"),
      "*** and ***",
    );
    await sink.finalize();
  } finally {
    resetSharedSecretRedactorForTests();
  }
});
