import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  createFakeClock,
  flushMicrotasks,
  withTempLayout,
  writeFixtureLeafCertificate,
} from "../testing/index.ts";
import {
  inspectIssuerCertificatePem,
  renderInstanceAcmeSettings,
} from "../deploy/instance-acme-issuer.ts";
import { withInstanceAcmeWindowLock } from "../deploy/instance-acme-http01.ts";
import type { InstanceAcmeWireSettings } from "../contracts/cell-messages.ts";
import { resolveLayout } from "../paths/layout.ts";
import type { InstanceAcmeIssuanceEventMessage } from "./instance-acme-observe.ts";
import {
  INSTANCE_ACME_FAILURE_BACKOFF_MIN_MS,
  INSTANCE_ACME_RENEWAL_CHECK_MS,
  instanceAcmeFailureBackoffMs,
  InstanceAcmeRenewalScheduler,
  instanceAcmeRenewalWaitMs,
} from "./instance-acme-renew.ts";
import { resolveInstanceCertsDir } from "./public-urls-apply.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const HOST = "panel.example.com";
const OTHER = "other.example.com";
const FIXED_NOW_MS = Date.parse("2026-09-23T12:00:00.000Z");
const SETTINGS: InstanceAcmeWireSettings = {
  contactEmail: "acme@example.com",
  tosAccepted: true,
  directoryUrl: "",
  useStaging: true,
};

test("failure backoff doubles from one hour and the wait stays inside it", () => {
  assertEquals(instanceAcmeFailureBackoffMs(1), 60 * 60 * 1000);
  assertEquals(instanceAcmeFailureBackoffMs(2), 2 * 60 * 60 * 1000);
  assertEquals(instanceAcmeFailureBackoffMs(3), 4 * 60 * 60 * 1000);
  assertEquals(
    instanceAcmeFailureBackoffMs(10),
    24 * 60 * 60 * 1000,
  );
  assertEquals(
    instanceAcmeRenewalWaitMs({
      nowMs: 0,
      intervalMs: INSTANCE_ACME_RENEWAL_CHECK_MS,
      reloadRetryMs: INSTANCE_ACME_FAILURE_BACKOFF_MIN_MS,
      reloadPending: false,
      nextAttemptAt: [60 * 60 * 1000],
    }),
    60 * 60 * 1000,
  );
  assertEquals(
    instanceAcmeRenewalWaitMs({
      nowMs: 0,
      intervalMs: INSTANCE_ACME_RENEWAL_CHECK_MS,
      reloadRetryMs: INSTANCE_ACME_FAILURE_BACKOFF_MIN_MS,
      reloadPending: true,
      nextAttemptAt: [],
    }),
    INSTANCE_ACME_FAILURE_BACKOFF_MIN_MS,
  );
});

test("withInstanceAcmeWindowLock runs one window at a time", async () => {
  let release = (): void => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let ran = false;
  const first = withInstanceAcmeWindowLock(() => gate);
  const second = withInstanceAcmeWindowLock(() => {
    ran = true;
    return Promise.resolve();
  });
  await flushMicrotasks();
  assertEquals(ran, false);
  release();
  await second;
  assertEquals(ran, true);
  await first;
});

test("a missing leaf is issued and the event carries notAfter from the file", async () => {
  await withTempLayout(async (fixture) => {
    const clock = createFakeClock({ now: FIXED_NOW_MS });
    const layout = resolveLayout(fixture.env);
    const certsDir = resolveInstanceCertsDir(fixture.env);
    await writeSidecar(layout.configDir, [HOST]);
    await writeSettings(layout.configDir);
    const sent: InstanceAcmeIssuanceEventMessage[] = [];
    const order: string[] = [];
    const scheduler = new InstanceAcmeRenewalScheduler({
      env: fixture.env,
      layout,
      now: () => clock.now(),
      withLock: (fn) => fn(),
      send: (message) => {
        sent.push(message);
        return true;
      },
      openWindow: () => {
        order.push("open");
        return Promise.resolve();
      },
      preflight: () => {
        order.push("preflight");
        return Promise.resolve();
      },
      issue: async (_layout, hosts) => {
        order.push(`issue:${hosts.join(",")}`);
        await writeFixtureLeafCertificate(
          join(certsDir, `letsencrypt-${HOST}.crt`),
          HOST,
          "20260923000000Z",
          "20270923000000Z",
        );
      },
      closeWindow: () => {
        order.push("close");
        return Promise.resolve();
      },
      reload: () => {
        order.push("reload");
        return Promise.resolve();
      },
    });
    await scheduler.check();
    const pem = await Deno.readTextFile(
      join(certsDir, `letsencrypt-${HOST}.crt`),
    );
    const notAfter = inspectIssuerCertificatePem(pem, clock.now())?.notAfter;
    if (!notAfter) throw new TypeError("fixture leaf has no expiry");
    assertEquals(order, [
      "open",
      "preflight",
      `issue:${HOST}`,
      "close",
      "reload",
    ]);
    assertEquals(sent, [{
      type: "instance-acme-issuance-event",
      hostname: HOST,
      ok: true,
      notAfter,
      at: new Date(FIXED_NOW_MS).toISOString(),
    }]);
    await scheduler.check();
    assertEquals(sent.length, 1);
  });
});

test("a leaf outside the renewal window is left alone", async () => {
  await withTempLayout(async (fixture) => {
    const clock = createFakeClock({ now: FIXED_NOW_MS });
    const layout = resolveLayout(fixture.env);
    const certsDir = resolveInstanceCertsDir(fixture.env);
    await writeSidecar(layout.configDir, [HOST]);
    await writeSettings(layout.configDir);
    await writeFixtureLeafCertificate(
      join(certsDir, `letsencrypt-${HOST}.crt`),
      HOST,
      "20260923000000Z",
      "20270923000000Z",
    );
    const pem = await Deno.readTextFile(
      join(certsDir, `letsencrypt-${HOST}.crt`),
    );
    const inspected = inspectIssuerCertificatePem(pem, FIXED_NOW_MS);
    if (!inspected || inspected.due) {
      throw new TypeError("fixture certificate is inside the renewal window");
    }
    let issued = 0;
    const scheduler = new InstanceAcmeRenewalScheduler({
      env: fixture.env,
      layout,
      now: () => clock.now(),
      withLock: (fn) => fn(),
      send: () => true,
      issue: () => {
        issued += 1;
        return Promise.resolve();
      },
      openWindow: () => Promise.resolve(),
      preflight: () => Promise.resolve(),
      closeWindow: () => Promise.resolve(),
      reload: () => Promise.resolve(),
    });
    await scheduler.check();
    assertEquals(issued, 0);
  });
});

test("a leaf inside the window is renewed and a current sibling is not", async () => {
  await withTempLayout(async (fixture) => {
    const clock = createFakeClock({ now: FIXED_NOW_MS });
    const layout = resolveLayout(fixture.env);
    const certsDir = resolveInstanceCertsDir(fixture.env);
    await writeSidecar(layout.configDir, [OTHER, HOST]);
    await writeSettings(layout.configDir);
    await writeFixtureLeafCertificate(
      join(certsDir, `letsencrypt-${HOST}.crt`),
      HOST,
      "20260705000000Z",
      "20261003000000Z",
    );
    await writeFixtureLeafCertificate(
      join(certsDir, `letsencrypt-${OTHER}.crt`),
      OTHER,
      "20260923000000Z",
      "20270923000000Z",
    );
    const due = inspectIssuerCertificatePem(
      await Deno.readTextFile(join(certsDir, `letsencrypt-${HOST}.crt`)),
      FIXED_NOW_MS,
    );
    if (!due?.due) {
      throw new TypeError("fixture certificate is outside the renewal window");
    }
    let hosts: readonly string[] = [];
    const scheduler = new InstanceAcmeRenewalScheduler({
      env: fixture.env,
      layout,
      now: () => clock.now(),
      withLock: (fn) => fn(),
      send: () => true,
      openWindow: () => Promise.resolve(),
      preflight: () => Promise.resolve(),
      closeWindow: () => Promise.resolve(),
      reload: () => Promise.resolve(),
      issue: async (_layout, issued) => {
        hosts = issued;
        await writeFixtureLeafCertificate(
          join(certsDir, `letsencrypt-${HOST}.crt`),
          HOST,
          "20260923000000Z",
          "20270923000000Z",
        );
      },
    });
    await scheduler.check();
    assertEquals(hosts, [HOST]);
  });
});

test("a failed attempt backs off, reports the issuer error, and survives restart", async () => {
  await withTempLayout(async (fixture) => {
    const clock = createFakeClock({ now: FIXED_NOW_MS });
    const layout = resolveLayout(fixture.env);
    await writeSidecar(layout.configDir, [HOST]);
    await writeSettings(layout.configDir);
    const sent: InstanceAcmeIssuanceEventMessage[] = [];
    let allowSend = false;
    let issues = 0;
    let closed = 0;
    const options = {
      env: fixture.env,
      layout,
      now: () => clock.now(),
      withLock: <T>(fn: () => Promise<T>) => fn(),
      send: (message: InstanceAcmeIssuanceEventMessage) => {
        if (!allowSend) return false;
        sent.push(message);
        return true;
      },
      openWindow: () => Promise.resolve(),
      preflight: () => Promise.resolve(),
      closeWindow: () => {
        closed += 1;
        return Promise.resolve();
      },
      reload: () => Promise.resolve(),
      issue: () => {
        issues += 1;
        return Promise.reject(
          new Error("instance ACME issuer failed: challenge failed"),
        );
      },
    };
    const scheduler = new InstanceAcmeRenewalScheduler(options);
    await scheduler.check();
    assertEquals(issues, 1);
    assertEquals(closed, 1);
    assertEquals(sent, []);
    allowSend = true;
    scheduler.flush();
    assertEquals(sent.length, 1);
    assertEquals(sent[0]?.ok, false);
    assertStringIncludes(sent[0]?.errorMessage ?? "", "challenge failed");
    await scheduler.check();
    assertEquals(issues, 1);
    const restarted = new InstanceAcmeRenewalScheduler(options);
    await restarted.check();
    assertEquals(issues, 1);
    await clock.advance(INSTANCE_ACME_FAILURE_BACKOFF_MIN_MS);
    await restarted.check();
    assertEquals(issues, 2);
  });
});

test("a reload failure is retried without issuing again", async () => {
  await withTempLayout(async (fixture) => {
    const clock = createFakeClock({ now: FIXED_NOW_MS });
    const layout = resolveLayout(fixture.env);
    const certsDir = resolveInstanceCertsDir(fixture.env);
    await writeSidecar(layout.configDir, [HOST]);
    await writeSettings(layout.configDir);
    let issues = 0;
    let reloads = 0;
    const options = {
      env: fixture.env,
      layout,
      now: () => clock.now(),
      withLock: <T>(fn: () => Promise<T>) => fn(),
      send: () => true,
      openWindow: () => Promise.resolve(),
      preflight: () => Promise.resolve(),
      closeWindow: () => Promise.resolve(),
      issue: async () => {
        issues += 1;
        await writeFixtureLeafCertificate(
          join(certsDir, `letsencrypt-${HOST}.crt`),
          HOST,
          "20260923000000Z",
          "20270923000000Z",
        );
      },
      reload: () => {
        reloads += 1;
        if (reloads === 1) return Promise.reject(new Error("reload failed"));
        return Promise.resolve();
      },
    };
    const scheduler = new InstanceAcmeRenewalScheduler(options);
    await scheduler.check();
    assertEquals(issues, 1);
    assertEquals(reloads, 1);
    const restarted = new InstanceAcmeRenewalScheduler(options);
    await restarted.check();
    assertEquals(issues, 1);
    assertEquals(reloads, 2);
    await restarted.check();
    assertEquals(reloads, 2);
  });
});

test("the scheduler checks at start and again after the renewal interval", async () => {
  await withTempLayout(async (fixture) => {
    const clock = createFakeClock({ now: FIXED_NOW_MS });
    const layout = resolveLayout(fixture.env);
    const certsDir = resolveInstanceCertsDir(fixture.env);
    await writeSidecar(layout.configDir, [HOST]);
    await writeSettings(layout.configDir);
    let lists = 0;
    let issues = 0;
    let slept = 0;
    const scheduler = new InstanceAcmeRenewalScheduler({
      env: fixture.env,
      layout,
      now: () => clock.now(),
      delay: (ms) => {
        slept = ms;
        return clock.delay(ms);
      },
      withLock: (fn) => fn(),
      send: () => true,
      listHostnames: () => {
        lists += 1;
        return Promise.resolve([HOST]);
      },
      readSettings: () => Promise.resolve(SETTINGS),
      openWindow: () => Promise.resolve(),
      preflight: () => Promise.resolve(),
      closeWindow: () => Promise.resolve(),
      reload: () => Promise.resolve(),
      issue: async () => {
        issues += 1;
        await writeFixtureLeafCertificate(
          join(certsDir, `letsencrypt-${HOST}.crt`),
          HOST,
          "20260923000000Z",
          "20270923000000Z",
        );
      },
    });
    try {
      const first = scheduler.whenChecked(1);
      scheduler.start();
      await first;
      assertEquals(issues, 1);
      assertEquals(slept, INSTANCE_ACME_RENEWAL_CHECK_MS);
      const listsAfterFirst = lists;
      const second = scheduler.whenChecked(2);
      await clock.advance(INSTANCE_ACME_RENEWAL_CHECK_MS - 1);
      assertEquals(lists, listsAfterFirst);
      await clock.advance(1);
      await second;
      assertEquals(lists > listsAfterFirst, true);
      assertEquals(issues, 1);
    } finally {
      scheduler.stop();
    }
  });
});

test("renewal waits while another window holds the lock", async () => {
  await withTempLayout(async (fixture) => {
    const layout = resolveLayout(fixture.env);
    await writeSidecar(layout.configDir, [HOST]);
    await writeSettings(layout.configDir);
    let release = (): void => {};
    let released = false;
    const gate = new Promise<void>((resolve) => {
      release = () => {
        if (released) return;
        released = true;
        resolve();
      };
    });
    const held = withInstanceAcmeWindowLock(() => gate);
    let opened = false;
    const scheduler = new InstanceAcmeRenewalScheduler({
      env: fixture.env,
      layout,
      now: () => FIXED_NOW_MS,
      send: () => true,
      openWindow: () => {
        opened = true;
        return Promise.resolve();
      },
      preflight: () => Promise.resolve(),
      issue: () => Promise.resolve(),
      closeWindow: () => Promise.resolve(),
      reload: () => Promise.resolve(),
      readSettings: () => Promise.resolve(SETTINGS),
    });
    const pending = scheduler.check();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assertEquals(opened, false);
    release();
    await held;
    await pending;
    assertEquals(opened, true);
  });
});

async function writeSidecar(configDir: string, hosts: readonly string[]) {
  const dir = join(configDir, "caddy");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "instance-hostnames.json"),
    JSON.stringify(hosts.map((host) => ({ host, source: "lets-encrypt" }))),
  );
}

async function writeSettings(configDir: string) {
  const dir = join(configDir, "caddy");
  await Deno.mkdir(dir, { recursive: true });
  await Deno.writeTextFile(
    join(dir, "instance-acme-settings.json"),
    renderInstanceAcmeSettings(SETTINGS),
  );
}
