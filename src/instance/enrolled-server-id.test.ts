import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import { hasEnrolledServerId } from "./client.ts";

const test = Deno.test.bind(Deno);

test("hasEnrolledServerId is true only once a server id is on disk", async () => {
  const dir = await Deno.makeTempDir();
  try {
    assertEquals(await hasEnrolledServerId(dir), false);
    await Deno.writeTextFile(join(dir, "server.id"), "  \n");
    assertEquals(await hasEnrolledServerId(dir), false);
    await Deno.writeTextFile(join(dir, "server.id"), "srv-1\n");
    assertEquals(await hasEnrolledServerId(dir), true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
