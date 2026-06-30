import { assertEquals } from "jsr:@std/assert";
import {
  AnsibleRunSummaryCollector,
  formatPlaybookRecap,
  sanitizeAnsibleSummaryText,
} from "./ansible-events.ts";

Deno.test("formatPlaybookRecap aggregates host stats", () => {
  assertEquals(
    formatPlaybookRecap({
      localhost: { ok: 3, changed: 1, failed: 0, unreachable: 0 },
    }),
    "ok=3 changed=1 failed=0 unreachable=0",
  );
});

Deno.test("AnsibleRunSummaryCollector builds recap and first failure", () => {
  const collector = new AnsibleRunSummaryCollector();

  collector.handleEvent({
    _event: "v2_runner_on_failed",
    _timestamp: "2026-01-01T00:00:00Z",
    task: { name: "Set hostname", id: "1", path: "", duration: { start: "" } },
    hosts: { localhost: { msg: "permission denied" } },
  });
  collector.handleEvent({
    _event: "v2_runner_on_failed",
    _timestamp: "2026-01-01T00:00:01Z",
    task: { name: "Later task", id: "2", path: "", duration: { start: "" } },
    hosts: { localhost: { msg: "ignored" } },
  });
  collector.handleEvent({
    _event: "v2_playbook_on_stats",
    _timestamp: "2026-01-01T00:00:02Z",
    stats: { localhost: { ok: 1, changed: 0, failed: 1, unreachable: 0 } },
    custom_stats: {},
    global_custom_stats: {},
  });

  assertEquals(
    collector.build(),
    "ok=1 changed=0 failed=1 unreachable=0; Set hostname: permission denied",
  );
});

Deno.test("sanitizeAnsibleSummaryText strips control characters and caps length", () => {
  const long = "a".repeat(600);
  assertEquals(sanitizeAnsibleSummaryText(long).length, 500);
  assertEquals(
    sanitizeAnsibleSummaryText("line1\nline2\t tab"),
    "line1 line2 tab",
  );
});
