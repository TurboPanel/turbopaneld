import { assertEquals, assertStringIncludes } from "@std/assert";
import { resolveLayout } from "../../paths/layout.ts";
import {
  CRON_RANDOMIZED_DELAY_SEC,
  CRON_UNIT_PREFIX,
  cronRandomizedDelaySec,
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
  assertStringIncludes(content, "Group=appuser");
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
  // Every five minutes spreads by a quarter of the step again, not the default.
  assertStringIncludes(content, "RandomizedDelaySec=75");
  assertStringIncludes(content, "Persistent=false");
  assertStringIncludes(
    content,
    "Unit=turbopanel-cron-env-cron-blog-wp-cron.service",
  );
  assertStringIncludes(content, "WantedBy=timers.target");
});

test("cronServiceContent defaults the run ceiling and lets a job raise it", () => {
  // `Type=oneshot` makes ExecStart the unit's *start*, so TimeoutStartSec is
  // the run ceiling — a job that declares one replaces the default rather than
  // adding a second, weaker bound.
  assertStringIncludes(cronServiceContent(baseOpts), "TimeoutStartSec=900");

  const bounded = cronServiceContent({
    ...baseOpts,
    job: { ...baseOpts.job, timeoutSeconds: 30 },
  });
  assertStringIncludes(bounded, "TimeoutStartSec=30");
  assertEquals(bounded.includes("TimeoutStartSec=900"), false);
});

test("cronTimerContent carries a timezone the control plane appended", () => {
  // The zone rides the OnCalendar string; this side renders what it was handed
  // and never parses a zone of its own.
  const content = cronTimerContent({
    ...baseOpts,
    job: { ...baseOpts.job, schedule: "*-*-* 03:00:00 America/New_York" },
  });
  assertStringIncludes(content, "OnCalendar=*-*-* 03:00:00 America/New_York");
});

test("cronRandomizedDelaySec gives a per-minute job no spread and keeps the default for slow ones", () => {
  assertEquals(cronRandomizedDelaySec("*-*-* *:*:00"), 0);
  assertEquals(cronRandomizedDelaySec("*-*-* *:0/5:00"), 75);
  assertEquals(cronRandomizedDelaySec("*-*-* *:0/30:00"), 120);
  assertEquals(
    cronRandomizedDelaySec("*-*-* 03:00:00"),
    CRON_RANDOMIZED_DELAY_SEC,
  );
  assertEquals(
    cronRandomizedDelaySec("Mon *-*-* 03:00:00 Europe/Berlin"),
    CRON_RANDOMIZED_DELAY_SEC,
  );
  assertEquals(cronRandomizedDelaySec("hourly"), CRON_RANDOMIZED_DELAY_SEC);
});

test("cronServiceContent loads the site environment file and pins the PHP series only when given", () => {
  const plain = cronServiceContent(baseOpts);
  assertEquals(plain.includes("EnvironmentFile="), false);
  assertEquals(plain.includes("TURBOPANEL_PHP"), false);
  const site = cronServiceContent({
    ...baseOpts,
    environmentFile: "/etc/turbopanel/site-env/alice/web-0123456789ab.env",
    phpSeries: "8.4",
  });
  assertStringIncludes(
    site,
    "EnvironmentFile=/etc/turbopanel/site-env/alice/web-0123456789ab.env",
  );
  assertStringIncludes(site, "Environment=TURBOPANEL_PHP=8.4");
});
