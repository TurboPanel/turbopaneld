import { assertEquals } from "@std/assert";
import { parseUptime } from "./parse-uptime.ts";
import { it } from "@std/testing/bdd";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("parseUptime returns integer seconds from first field", () => {
  assertEquals(parseUptime(fixture("proc-uptime.txt")), 12345);
});

it("parseUptime returns null for empty input", () => {
  assertEquals(parseUptime(""), null);
});

it("parseUptime returns null for non-numeric input", () => {
  assertEquals(parseUptime("not-a-number 1.0"), null);
});
