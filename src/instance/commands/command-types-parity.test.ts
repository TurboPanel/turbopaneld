import { assertEquals } from "jsr:@std/assert";
import { COMMAND_TYPES } from "./contracts.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/** Byte-identical order with instance `src/lib/commands/types.ts` COMMAND_TYPES. */
const INSTANCE_COMMAND_TYPES = [
  "daemon.ping",
  "server.hostname.set",
  "server.ntp.set",
  "server.reboot",
  "server.timezone.set",
  "environment.deploy",
  "environment.stop",
] as const;

test("COMMAND_TYPES matches instance canonical order", () => {
  assertEquals([...COMMAND_TYPES], [...INSTANCE_COMMAND_TYPES]);
});
