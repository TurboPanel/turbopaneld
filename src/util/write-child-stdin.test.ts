import { assertEquals, assertRejects } from "@std/assert";
import { isClosedPipeError, writeChildStdin } from "./write-child-stdin.ts";

Deno.test("writeChildStdin delivers text to a child that reads it", async () => {
  const child = new Deno.Command("cat", {
    stdin: "piped",
    stdout: "piped",
  }).spawn();
  assertEquals(await writeChildStdin(child.stdin, "hello\n"), true);
  const out = await child.output();
  assertEquals(new TextDecoder().decode(out.stdout), "hello\n");
});

Deno.test("writeChildStdin reports a child that exited before reading", async () => {
  // Enough data that the pipe buffer cannot absorb it after the reader is gone.
  const big = "x".repeat(1 << 20);
  for (let i = 0; i < 20; i++) {
    const child = new Deno.Command("sh", {
      args: ["-c", "exit 3"],
      stdin: "piped",
    }).spawn();
    await child.status;
    assertEquals(await writeChildStdin(child.stdin, big), false);
  }
});

Deno.test("writeChildStdin still throws errors that are not a closed pipe", async () => {
  const stdin = new WritableStream<Uint8Array>({
    write() {
      throw new Error("disk on fire");
    },
  });
  await assertRejects(() => writeChildStdin(stdin, "x"), Error, "disk on fire");
});

Deno.test("isClosedPipeError recognises the closed-pipe wordings", () => {
  assertEquals(isClosedPipeError(new Error("Broken pipe (os error 32)")), true);
  assertEquals(
    isClosedPipeError(new TypeError("Writable stream is closed")),
    true,
  );
  assertEquals(isClosedPipeError(new Error("EPIPE")), true);
  assertEquals(isClosedPipeError(new Error("nope")), false);
});
