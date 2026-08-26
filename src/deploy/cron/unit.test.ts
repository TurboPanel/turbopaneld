import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolveLayout } from "../../paths/layout.ts";
import {
  CRON_RANDOMIZED_DELAY_SEC,
  CRON_UNIT_PREFIX,
  cronServiceContent,
  cronServicePath,
  cronTimerContent,
  cronTimerPath,
  cronUnitName,
} from "./unit.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const layout = resolveLayout(
  {
    TURBOPANEL_CONFIG_DIR: "/etc/turbopanel",
    TURBOPANEL_PRINCIPAL_HOME_ROOT: "/srv/users",
  },
  { skipDiscovery: true, forceMode: "production" },
);

const identity = {
  environmentId: "env-cron",
  composeServiceName: "blog",
  jobName: "wp-cron",
};

const baseOpts = {
  layout,
  environmentId: identity.environmentId,
  composeServiceName: identity.composeServiceName,
  username: "appuser",
  workingDirectory: "/srv/users/appuser/sites/svc-1/webroot/public",
  job: {
    name: identity.jobName,
    schedule: "*-*-* *:0/5:00",
    command: ["/usr/local/bin/php", "wp-cron.php"],
  },
};

test("cronUnitName and path helpers encode environment, service, and job", () => {
  assertEquals(
    cronUnitName(identity),
    `${CRON_UNIT_PREFIX}env-cron-blog-wp-cron`,
  );
  assertEquals(
    cronServicePath(identity, "/tmp/systemd"),
    "/tmp/systemd/turbopanel-cron-env-cron-blog-wp-cron.service",
  );
  assertEquals(
    cronTimerPath(identity, "/tmp/systemd"),
    "/tmp/systemd/turbopanel-cron-env-cron-blog-wp-cron.timer",
  );
});

test("cronServiceContent quotes argv and hardens the oneshot service", () => {
  const content = cronServiceContent({
    ...baseOpts,
    job: {
      ...baseOpts.job,
      command: [
        "/usr/bin/php",
        'script with "quotes" and \\ backslashes',
      ],
    },
  });

  assertStringIncludes(content, "Type=oneshot");
  assertStringIncludes(content, "User=appuser");
  assertStringIncludes(content, "Group=appuser-grp");
  assertStringIncludes(content, "Slice=turbopanel-appuser.slice");
  assertStringIncludes(content, "Environment=HOME=/srv/users/appuser");
  assertStringIncludes(
    content,
    'ExecStart="/usr/bin/php" "script with \\"quotes\\" and \\\\ backslashes"',
  );
  assertStringIncludes(content, "CapabilityBoundingSet=");
  assertStringIncludes(content, "ReadWritePaths=/srv/users/appuser");
});

test("cronTimerContent wires OnCalendar and randomized delay", () => {
  const content = cronTimerContent(baseOpts);
  assertStringIncludes(content, "OnCalendar=*-*-* *:0/5:00");
  assertStringIncludes(
    content,
    `RandomizedDelaySec=${CRON_RANDOMIZED_DELAY_SEC}`,
  );
  assertStringIncludes(content, "Persistent=false");
  assertStringIncludes(
    content,
    "Unit=turbopanel-cron-env-cron-blog-wp-cron.service",
  );
  assertStringIncludes(content, "WantedBy=timers.target");
});
