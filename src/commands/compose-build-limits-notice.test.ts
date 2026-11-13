import { assertEquals } from "@std/assert";
import {
  COMPOSE_BUILD_LIMITS_NOTICE,
  noteComposeBuildLimits,
} from "./deploy-environment.ts";

const test = Deno.test.bind(Deno);

type Payload = Parameters<typeof noteComposeBuildLimits>[0];

function payloadWith(sourceMaterial: unknown): Payload {
  return { sourceMaterial } as Payload;
}

function lines(payload: Payload): string[] {
  const out: string[] = [];
  noteComposeBuildLimits(payload, (event) => out.push(event.line));
  return out;
}

test("the compose build says its limits do not apply when a source entry carries limits", () => {
  const limits = { cores: { cores: 2, source: "server" } };
  assertEquals(
    lines(payloadWith([{ composeServiceName: "web", buildLimits: limits }])),
    [COMPOSE_BUILD_LIMITS_NOTICE],
  );
});

test("no limits on any source entry, no notice", () => {
  assertEquals(lines(payloadWith(undefined)), []);
  assertEquals(lines(payloadWith([{ composeServiceName: "web" }])), []);
});
