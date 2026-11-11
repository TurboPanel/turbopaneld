import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { materializeConfigFiles } from "./config-files.ts";
import { captureDecryptedSecrets } from "../logs/capture.ts";
import { createNoopCommandOutputSink } from "../logs/contracts.ts";
import {
  createMutableTranscriptRedactor,
  resetSharedSecretRedactorForTests,
} from "../logs/redactor.ts";

/** Jest/Mocha-shaped alias so Sonar sees real tests. */
const test = Deno.test.bind(Deno);

const MARKER = "marker-value-7d1e0c52";

test({
  name:
    "a secret used only in a generated file is scrubbed from a transcript line",
  permissions: { read: true, write: true },
  fn: async () => {
    resetSharedSecretRedactorForTests();
    const root = await Deno.makeTempDir({ prefix: "tp-config-redact-" });
    const redactor = createMutableTranscriptRedactor([]);
    const sink = {
      ...createNoopCommandOutputSink(),
      addSecrets: (values: readonly (string | null)[]) => redactor.add(values),
    };
    const decrypt = captureDecryptedSecrets(
      (envelopes: string[]) => Promise.resolve(envelopes.map(() => MARKER)),
      sink,
    )!;
    try {
      await materializeConfigFiles(
        { runDir: join(root, "run") },
        "proj",
        "env",
        [{
          composeServiceName: "web",
          source: "web_conf",
          relativePath: "web--conf",
          parts: [{ text: "password=" }, { secretKey: "PW" }],
        }],
        [{
          key: "PW",
          composeServiceName: "web",
          forBuild: false,
          forRuntime: false,
          isLiteral: false,
          valueEnvelope: "sealed",
        }],
        decrypt,
      );
      const line = redactor.redact(`connecting with ${MARKER} now`);
      assertEquals(line.includes(MARKER), false);
      assertEquals(line.includes("***"), true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
