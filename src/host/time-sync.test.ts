import { assertEquals } from "@std/assert";
import {
  parseEtcTimezone,
  parseTimedatectlShow,
  parseTimedatectlStatus,
  parseTimesyncdConf,
} from "./time-sync.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

test("parseTimedatectlShow maps Timezone / NTP / NTPSynchronized", () => {
  const parsed = parseTimedatectlShow(`
Timezone=America/Chicago
LocalRTC=no
CanNTP=yes
NTP=yes
NTPSynchronized=yes
TimeUSec=Fri 2026-07-24 12:00:00 CDT
`);
  assertEquals(parsed, {
    timezone: "America/Chicago",
    ntpEnabled: true,
    ntpSynced: true,
  });
});

test("parseTimedatectlShow treats no/false as disabled", () => {
  const parsed = parseTimedatectlShow(`
Timezone=UTC
NTP=no
NTPSynchronized=no
`);
  assertEquals(parsed, {
    timezone: "UTC",
    ntpEnabled: false,
    ntpSynced: false,
  });
});

test("parseTimedatectlStatus maps Time zone / NTP service / synchronized", () => {
  const parsed = parseTimedatectlStatus(`
               Local time: Fri 2026-07-24 14:52:00 CDT
           Universal time: Fri 2026-07-24 19:52:00 UTC
                 RTC time: Fri 2026-07-24 19:52:00
                Time zone: America/Chicago (CDT, -0500)
System clock synchronized: yes
              NTP service: active
          RTC in local TZ: no
`);
  assertEquals(parsed, {
    timezone: "America/Chicago",
    ntpEnabled: true,
    ntpSynced: true,
  });
});

test("parseTimedatectlStatus maps inactive NTP and legacy wording", () => {
  const modern = parseTimedatectlStatus(`
                Time zone: UTC
System clock synchronized: no
              NTP service: inactive
`);
  assertEquals(modern, {
    timezone: "UTC",
    ntpEnabled: false,
    ntpSynced: false,
  });

  const legacy = parseTimedatectlStatus(`
      NTP enabled: yes
 NTP synchronized: no
`);
  assertEquals(legacy, {
    ntpEnabled: true,
    ntpSynced: false,
  });
});

test("parseEtcTimezone reads the first non-comment IANA name", () => {
  assertEquals(parseEtcTimezone("America/Chicago\n"), "America/Chicago");
  assertEquals(
    parseEtcTimezone("# comment\nEurope/Berlin\n"),
    "Europe/Berlin",
  );
  assertEquals(parseEtcTimezone("# only comments\n\n"), undefined);
});

test("parseTimesyncdConf reads NTP and FallbackNTP server lists", () => {
  const parsed = parseTimesyncdConf(`
# Managed by TurboPanel
[Time]
NTP=0.debian.pool.ntp.org 1.debian.pool.ntp.org
FallbackNTP=time.cloudflare.com
`);
  assertEquals(parsed, {
    ntpServers: ["0.debian.pool.ntp.org", "1.debian.pool.ntp.org"],
    fallbackNtpServers: ["time.cloudflare.com"],
  });
});

test("parseTimesyncdConf returns empty servers when unset", () => {
  assertEquals(parseTimesyncdConf("[Time]\n"), { ntpServers: [] });
});
