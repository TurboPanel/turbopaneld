import { assertEquals } from "@std/assert";
import {
  collectMetricsLegacyFailures,
  isAllowedPath,
  reportMetricsLegacyFailures,
  runMetricsLegacyCheck,
} from "./check-metrics-legacy.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("isAllowedPath admits only managed-engine code paths", () => {
  assertEquals(isAllowedPath("turbopaneld/src/managed/engines/index.ts"), true);
  assertEquals(
    isAllowedPath("turbopaneld/src/instance/commands/contracts.ts"),
    true,
  );
  assertEquals(isAllowedPath("turbopanel/src/lib/managed/types.ts"), true);
  assertEquals(isAllowedPath("turbopanel/src/client/openapi/managed.ts"), true);
  assertEquals(isAllowedPath("turbopanel/src/lib/db/schema.ts"), true);
  assertEquals(
    isAllowedPath("ui/src/components/org/managed/managed-version-picker.tsx"),
    true,
  );
  assertEquals(isAllowedPath("ui/src/lib/managed-services.ts"), true);
  // Metrics plumbing is never allowed back.
  assertEquals(
    isAllowedPath("turbopanel/src/daemon/metrics/backends/duckdb/store.ts"),
    false,
  );
  assertEquals(
    isAllowedPath(
      "turbopaneld/orchestration/roles/system-compose/tasks/main.yml",
    ),
    false,
  );
  assertEquals(isAllowedPath("dev/src/lib/service-urls.ts"), false);
});

test("collectMetricsLegacyFailures flags code and comments, case-insensitively", () => {
  const failures = collectMetricsLegacyFailures(
    "dev/src/lib/example.ts",
    'const url = "http://127.0.0.1:8123";\n// talks to ClickHouse\nconst gui = "Tabix";\n',
  );
  assertEquals(failures.length, 2);
  assertEquals(
    failures[0],
    'dev/src/lib/example.ts:2 references retired metrics infrastructure ("ClickHouse")',
  );
  assertEquals(
    failures[1],
    'dev/src/lib/example.ts:3 references retired metrics infrastructure ("Tabix")',
  );
});

test("collectMetricsLegacyFailures skips allowlisted managed-engine paths", () => {
  const failures = collectMetricsLegacyFailures(
    "turbopanel/src/lib/managed/types.ts",
    "export type ManagedEngine = 'clickhouse';\n",
  );
  assertEquals(failures, []);
});

test("runMetricsLegacyCheck passes on the current workspace", async () => {
  assertEquals(await runMetricsLegacyCheck(), []);
});

test("reportMetricsLegacyFailures exits non-zero only on failures", () => {
  const errors: string[] = [];
  const logs: string[] = [];
  let exitCode: number | null = null;
  reportMetricsLegacyFailures(["dev/src/x.ts:1 references ..."], {
    error: (message) => errors.push(message),
    log: (message) => logs.push(message),
    exit: (code) => {
      exitCode = code;
    },
  });
  assertEquals(exitCode, 1);
  assertEquals(logs, []);

  exitCode = null;
  reportMetricsLegacyFailures([], {
    error: (message) => errors.push(message),
    log: (message) => logs.push(message),
    exit: (code) => {
      exitCode = code;
    },
  });
  assertEquals(exitCode, null);
  assertEquals(logs.length, 1);
});
