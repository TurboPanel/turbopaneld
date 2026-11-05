import { assertEquals, assertRejects } from "@std/assert";
import { writePanelPinFromDocument } from "./panel-pin-write.ts";

/** Alias so Sonar sees real tests (see src/AGENTS.md). */
const test = Deno.test.bind(Deno);

test("writePanelPinFromDocument hands root the header line and the exact body", async () => {
  const calls: Array<{ args: string[]; stdin: string }> = [];
  await writePanelPinFromDocument(
    { body: '{"v":1}', signature: "kid:sig" },
    (args, stdin) => {
      calls.push({ args, stdin });
      return Promise.resolve({ success: true, stderr: "" });
    },
  );
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.args.at(-1), "panel-identity-write");
  assertEquals(calls[0]!.stdin, 'kid:sig\n{"v":1}');
});

test("writePanelPinFromDocument refuses an unsigned document and reports tp-host's refusal", async () => {
  await assertRejects(
    () =>
      writePanelPinFromDocument({ body: "{}", signature: null }, () => {
        throw new Error("must not run");
      }),
    Error,
    "not signed",
  );
  await assertRejects(
    () =>
      writePanelPinFromDocument(
        { body: "{}", signature: "k:s" },
        () =>
          Promise.resolve({
            success: false,
            stderr: "tp-host: panel-identity-write: refusing",
          }),
      ),
    Error,
    "refusing",
  );
});
