import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  instanceAcmeRowFailure,
  instanceAcmeWindowFailure,
  plainInstanceAcmeFailure,
} from "./instance-acme-failure.ts";

const { test } = Deno;

test("rate limit becomes plain words", () => {
  const raw =
    'instance ACME issuer failed: {"level":"error","error":"urn:ietf:params:acme:error:rateLimited: too many failed authorizations"}';
  assertStringIncludes(plainInstanceAcmeFailure(raw), "is limiting requests");
});

test("port 80 holder keeps the process name", () => {
  assertStringIncludes(
    plainInstanceAcmeFailure("port 80 is held by nginx"),
    "port 80 is held by nginx",
  );
});

test("DNS, unauthorized and unknown errors map to plain words", () => {
  assertStringIncludes(
    plainInstanceAcmeFailure("DNS problem: NXDOMAIN looking up A"),
    "DNS does not point",
  );
  assertStringIncludes(
    plainInstanceAcmeFailure('{"msg":"challenge failed"}'),
    "could not validate",
  );
  const generic = plainInstanceAcmeFailure('{"weird":"json"}');
  assertEquals(generic.includes("{"), false);
});

test("row failure carries the stored prefix and never the raw detail", () => {
  const err = instanceAcmeRowFailure(
    new Error('instance ACME issuer failed: {"x":"rateLimited"}'),
    "panel.example.com",
  );
  assertStringIncludes(
    err.message,
    "Let's Encrypt HTTP-01 preflight failed for panel.example.com: ",
  );
  assertEquals(err.message.includes("{"), false);
});

test("preflight errors pass through untouched", () => {
  const original = new Error(
    "Let's Encrypt HTTP-01 preflight failed for a.example.com: nope",
  );
  assertEquals(instanceAcmeRowFailure(original, "a.example.com"), original);
});

test("window errors map only the port 80 holder", () => {
  assertStringIncludes(
    instanceAcmeWindowFailure(
      new Error("port 80 is held by nginx"),
      "a.example.com",
    )
      .message,
    "preflight failed for a.example.com: port 80 is held by nginx",
  );
  assertEquals(
    instanceAcmeWindowFailure(new Error("hosting Caddy reload failed"), "a")
      .message,
    "hosting Caddy reload failed",
  );
});
