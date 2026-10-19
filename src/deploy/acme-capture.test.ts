import { assertEquals } from "@std/assert";
import { createCertificateCapture } from "./acme-capture.ts";

const test = Deno.test.bind(Deno);

const PAIR = { certificatePem: "CERT\n", privateKeyPem: "KEY\n" };

class StatusError extends Error {
  constructor(readonly status: number) {
    super("PRIVATE-KEY-MUST-NOT-APPEAR");
  }
}

test("does nothing until the control plane advertises the feature", async () => {
  let exported = 0;
  const capture = createCertificateCapture({
    supported: () => false,
    report: () => Promise.resolve({ stored: true }),
    exportPair: () => {
      exported += 1;
      return Promise.resolve(PAIR);
    },
  });
  assertEquals(await capture("a.example.com"), "retry");
  assertEquals(exported, 0);
});

test("retries when the pair is not on disk yet", async () => {
  const capture = createCertificateCapture({
    supported: () => true,
    report: () => Promise.resolve({ stored: true }),
    exportPair: () => Promise.resolve(null),
  });
  assertEquals(await capture("a.example.com"), "retry");
});

test("sends the hostname and the pair, then reports done", async () => {
  const sent: unknown[] = [];
  const capture = createCertificateCapture({
    supported: () => true,
    report: (input) => {
      sent.push(input);
      return Promise.resolve({ stored: false });
    },
    exportPair: () => Promise.resolve(PAIR),
  });
  assertEquals(await capture("a.example.com"), "done");
  assertEquals(sent, [{ hostname: "a.example.com", ...PAIR }]);
});

test("a refusal (4xx) counts as handled, a 429 or 5xx retries, and the reason never holds the pair", async () => {
  const reasons: string[] = [];
  const run = async (status: number) =>
    await createCertificateCapture({
      supported: () => true,
      report: () => Promise.reject(new StatusError(status)),
      exportPair: () => Promise.resolve(PAIR),
      onFailure: (_host, reason) => reasons.push(reason),
    })("a.example.com");
  assertEquals(await run(400), "done");
  assertEquals(await run(403), "done");
  assertEquals(await run(429), "retry");
  assertEquals(await run(503), "retry");
  assertEquals(reasons, [
    "status 400",
    "status 403",
    "status 429",
    "status 503",
  ]);
  assertEquals(reasons.some((r) => r.includes("KEY")), false);
});

test("a network failure retries", async () => {
  const capture = createCertificateCapture({
    supported: () => true,
    report: () => Promise.reject(new Error("socket closed")),
    exportPair: () => Promise.resolve(PAIR),
  });
  assertEquals(await capture("a.example.com"), "retry");
});
