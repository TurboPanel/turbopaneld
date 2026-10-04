import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  ansibleFailureLine,
  AnsibleFailureTracker,
  playbookFailureMessage,
} from "./ansible-failure.ts";
import type {
  AnsibleHostResult,
  AnsibleTaskResultEvent,
} from "./ansible-events.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function failed(
  name: string,
  host: AnsibleHostResult,
  event: AnsibleTaskResultEvent["_event"] = "v2_runner_on_failed",
): AnsibleTaskResultEvent {
  return {
    _event: event,
    _timestamp: "2026-01-01T00:00:00Z",
    task: { name, id: "1", path: "", duration: { start: "" } },
    hosts: { localhost: host },
  };
}

test("an informative msg is the cause", () => {
  assertEquals(
    ansibleFailureLine(
      failed("Install Caddy", { msg: "Could not get lock /var/lib/dpkg/lock" }),
    ),
    "Install Caddy: Could not get lock /var/lib/dpkg/lock",
  );
});

test("a generic 'non-zero return code' msg gives way to the last stderr line", () => {
  assertEquals(
    ansibleFailureLine(
      failed("Build assets", {
        msg: "non-zero return code",
        stderr: "npm WARN deprecated\nnext: not found\n",
      }),
    ),
    "Build assets: next: not found",
  );
});

test("module_stderr is used when stderr is empty", () => {
  assertEquals(
    ansibleFailureLine(
      failed("Run module", {
        msg: "MODULE FAILURE\nSee stdout/stderr for the exact error",
        stderr: "",
        module_stderr: "Traceback\nPermissionError: [Errno 13] denied",
      }),
    ),
    "Run module: PermissionError: [Errno 13] denied",
  );
});

test("a looped task names the failing item's reason", () => {
  assertEquals(
    ansibleFailureLine(
      failed("Install packages", {
        msg: "All items completed",
        results: [
          { msg: "ok item" },
          { failed: true, msg: "No package foo available" },
        ],
      }),
    ),
    "Install packages: All items completed",
  );
  assertEquals(
    ansibleFailureLine(
      failed("Install packages", {
        msg: "non-zero return code",
        results: [
          { msg: "ok item" },
          { failed: true, msg: "No package foo available" },
        ],
      }),
    ),
    "Install packages: No package foo available",
  );
});

test("an unreachable host reports its connection message", () => {
  assertEquals(
    ansibleFailureLine(
      failed(
        "Gather facts",
        { unreachable: true, msg: "Failed to connect: Connection refused" },
        "v2_runner_on_unreachable",
      ),
    ),
    "Gather facts: Failed to connect: Connection refused",
  );
});

test("a task that ignores its errors is not the cause", () => {
  assertEquals(
    ansibleFailureLine(failed("Optional", { msg: "x", ignore_errors: true })),
    null,
  );
  const tracker = new AnsibleFailureTracker();
  tracker.handleEvent(failed("Real", { msg: "disk full" }));
  tracker.handleEvent(failed("Optional", { msg: "x", ignore_errors: true }));
  assertEquals(tracker.describe(), "Real: disk full");
});

test("a failure with no detail still names the task", () => {
  assertEquals(ansibleFailureLine(failed("Ping", {})), "Ping: unknown error");
});

test("signed URLs in the cause lose their query string", () => {
  const line = ansibleFailureLine(
    failed("Download", {
      msg:
        "HTTP Error 403 for https://objects.example.com/a.tgz?X-Amz-Signature=abc123&token=zzz",
    }),
  );
  assertStringIncludes(
    line ?? "",
    "https://objects.example.com/a.tgz?[redacted]",
  );
  assertEquals((line ?? "").includes("abc123"), false);
});

test("a long cause keeps its end", () => {
  const line = ansibleFailureLine(
    failed("Long", { msg: `${"progress ".repeat(100)}the real reason` }),
  ) ?? "";
  assertEquals(line.length <= 300, true);
  assertEquals(line.endsWith("the real reason"), true);
});

test("the latest real task failure wins; stderr is the fallback", () => {
  const tracker = new AnsibleFailureTracker();
  assertEquals(tracker.describe(), null);
  tracker.handleStderrLine("   ");
  tracker.handleStderrLine("ERROR! the playbook could not be found");
  assertEquals(tracker.describe(), "ERROR! the playbook could not be found");
  tracker.handleEvent(failed("First", { msg: "one" }));
  tracker.handleEvent(failed("Second", { msg: "two" }));
  assertEquals(tracker.describe(), "Second: two");
});

test("playbookFailureMessage puts the cause last", () => {
  const tracker = new AnsibleFailureTracker();
  assertEquals(
    playbookFailureMessage("ansible-playbook", 2, tracker),
    "ansible-playbook failed (exit 2)",
  );
  tracker.handleEvent(failed("Install Caddy", { msg: "apt lock held" }));
  assertEquals(
    playbookFailureMessage("ansible-playbook", 2, tracker),
    "ansible-playbook failed (exit 2): Install Caddy: apt lock held",
  );
});
