import { assertEquals } from "@std/assert";
import { parseLoadavg } from "./parse-loadavg.ts";
import { it } from "@std/testing/bdd";

function fixture(name: string): string {
  return Deno.readTextFileSync(
    new URL(`./testdata/${name}`, import.meta.url),
  );
}

it("parseLoadavg extracts 1/5/15 minute averages", () => {
  const load = parseLoadavg(fixture("proc-loadavg.txt"));
  assertEquals(load, { one: 1.25, five: 0.75, fifteen: 0.5 });
});

it("parseLoadavg returns null for short input", () => {
  assertEquals(parseLoadavg("1.0 2.0"), null);
});

it("parseLoadavg returns null for non-numeric fields", () => {
  assertEquals(parseLoadavg("foo bar baz"), null);
});
