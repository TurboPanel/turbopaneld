/**
 * Host-free coverage for the census parsers every engine runtime's
 * `readCensus` reduces through.
 */

import { assertEquals } from "@std/assert";
import {
  DOWN_ENGINE_CENSUS,
  parseCensusCount,
  parseMysqlConnectionCensus,
  parsePostgresConnectionCensus,
  UNREAD_ENGINE_CENSUS,
} from "./census.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseCensusCount accepts a bare non-negative integer and nothing else", () => {
  assertEquals(parseCensusCount("12"), 12);
  assertEquals(parseCensusCount(" 0 \n"), 0);
  assertEquals(parseCensusCount(""), null);
  assertEquals(parseCensusCount(undefined), null);
  assertEquals(parseCensusCount("-1"), null);
  assertEquals(parseCensusCount("1.5"), null);
  assertEquals(parseCensusCount("NULL"), null);
  // Above Number.MAX_SAFE_INTEGER — digits, but not a safe integer.
  assertEquals(parseCensusCount("9007199254740993"), null);
});

test("parsePostgresConnectionCensus reads used and max from the one tuples-only row", () => {
  assertEquals(parsePostgresConnectionCensus([["7", "100"]]), {
    healthy: true,
    connectionsUsed: 7,
    connectionsMax: 100,
  });
  // A missing or unparseable cell is null, never 0 — and never unhealthy.
  assertEquals(parsePostgresConnectionCensus([["7"]]), {
    healthy: true,
    connectionsUsed: 7,
    connectionsMax: null,
  });
  assertEquals(parsePostgresConnectionCensus([]), UNREAD_ENGINE_CENSUS);
});

test("parseMysqlConnectionCensus reads the SHOW GLOBAL STATUS row and the bare @@max_connections line", () => {
  assertEquals(parseMysqlConnectionCensus("Threads_connected\t12\n151\n"), {
    healthy: true,
    connectionsUsed: 12,
    connectionsMax: 151,
  });
  // MariaDB capitalises the variable name the same way; be case-insensitive anyway.
  assertEquals(parseMysqlConnectionCensus("threads_connected\t3\n\n50\n"), {
    healthy: true,
    connectionsUsed: 3,
    connectionsMax: 50,
  });
  assertEquals(parseMysqlConnectionCensus("151\n"), {
    healthy: true,
    connectionsUsed: null,
    connectionsMax: 151,
  });
  assertEquals(parseMysqlConnectionCensus(""), UNREAD_ENGINE_CENSUS);
  // Extra two-cell rows that are not Threads_connected are ignored; a second
  // bare integer does not overwrite a max already captured.
  assertEquals(
    parseMysqlConnectionCensus("Uptime\t99\nThreads_connected\t4\n151\n200\n"),
    {
      healthy: true,
      connectionsUsed: 4,
      connectionsMax: 151,
    },
  );
});

test("the down and unread sentinels differ only in health", () => {
  assertEquals(DOWN_ENGINE_CENSUS.healthy, false);
  assertEquals(UNREAD_ENGINE_CENSUS.healthy, true);
  assertEquals(DOWN_ENGINE_CENSUS.connectionsUsed, null);
  assertEquals(UNREAD_ENGINE_CENSUS.connectionsMax, null);
});
