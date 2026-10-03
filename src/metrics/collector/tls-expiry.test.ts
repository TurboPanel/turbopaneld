import { assertEquals } from "@std/assert";
import {
  parseCertDates,
  readTlsExpiry,
  TlsExpirySampler,
} from "./tls-expiry.ts";

const test = Deno.test.bind(Deno);
const NOW = Date.parse("2026-10-01T00:00:00Z");

test("parseCertDates reports the soonest notAfter in whole days and the count", () => {
  const reading = parseCertDates(
    "Nov 1 00:00:00 2026 GMT\nOct 11 12:00:00 2026 GMT\nnot a date\n",
    NOW,
  );
  assertEquals(reading, { soonestExpiryDays: 10, certificateCount: 2 });
});

test("parseCertDates is null with nothing parsable", () => {
  assertEquals(parseCertDates("", NOW), null);
  assertEquals(parseCertDates("garbage\n", NOW), null);
});

test("readTlsExpiry runs the tp-host verb and degrades to null", async () => {
  const seen: string[][] = [];
  const reading = await readTlsExpiry(NOW, (_c, args) => {
    seen.push(args);
    return Promise.resolve({
      success: true,
      stdout: "Oct 3 00:00:00 2026 GMT",
      stderr: "",
    });
  });
  assertEquals(reading?.soonestExpiryDays, 2);
  assertEquals(seen[0]!.at(-1), "cert-dates");
  assertEquals(
    await readTlsExpiry(
      NOW,
      () => Promise.resolve({ success: false, stdout: "", stderr: "x" }),
    ),
    null,
  );
});

test("the sampler keeps its last good reading across a failed poll", async () => {
  let next: { soonestExpiryDays: number; certificateCount: number } | null = {
    soonestExpiryDays: 5,
    certificateCount: 1,
  };
  const sampler = new TlsExpirySampler({ read: () => Promise.resolve(next) });
  assertEquals(sampler.latest(), null);
  await sampler.refresh();
  assertEquals(sampler.latest()?.soonestExpiryDays, 5);
  next = null;
  await sampler.refresh();
  assertEquals(sampler.latest()?.soonestExpiryDays, 5);
});
