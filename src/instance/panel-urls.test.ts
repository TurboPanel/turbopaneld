import { assertEquals, assertThrows } from "@std/assert";
import type { ClassifiedConnectFailure } from "./connect-failure.ts";
import {
  identityDocumentUrls,
  normalizePanelUrl,
  panelUrlCandidates,
  PanelUrlRotation,
  URL_WRAP_BASE_MS,
  URL_WRAP_CAP_MS,
  URL_WRAP_FLOOR_MS,
  urlListsDiffer,
  urlWrapDelayMs,
} from "./panel-urls.ts";

/** Alias so Sonar sees real tests (see src/AGENTS.md). */
const test = Deno.test.bind(Deno);

const A = "https://a.example";
const B = "https://b.example:8443";
const C = "https://c.example";

function fail(kind: string, reason = kind): ClassifiedConnectFailure {
  return { kind: kind as ClassifiedConnectFailure["kind"], reason };
}

test("normalizePanelUrl keeps https origins and refuses anything with a path or credentials", () => {
  assertEquals(normalizePanelUrl(`${A}/`), A);
  assertEquals(normalizePanelUrl(B), B);
  assertEquals(normalizePanelUrl("http://a.example"), null);
  assertEquals(normalizePanelUrl("https://a.example/x"), null);
  assertEquals(normalizePanelUrl("https://u@a.example"), null);
  assertEquals(normalizePanelUrl("https://a.example,b"), null);
  assertEquals(
    normalizePanelUrl("https://[2001:db8::1]:8443"),
    "https://[2001:db8::1]:8443",
  );
  for (
    const bad of ["https://a\tb", "https://a{{x}}", "https://a$b", "https://-a"]
  ) {
    assertEquals(normalizePanelUrl(bad), null, bad);
  }
  assertEquals(normalizePanelUrl(7), null);
});

test("panelUrlCandidates puts the pin's list first and the installer's address last, once", () => {
  assertEquals(panelUrlCandidates([A, B], C), [A, B, C]);
  assertEquals(panelUrlCandidates([A, B], `${A}/`), [A, B]);
  assertEquals(panelUrlCandidates([], A), [A]);
  assertEquals(panelUrlCandidates(["bad", A], undefined), [A]);
});

test("identityDocumentUrls returns the exact list, or null for an empty or malformed one", () => {
  assertEquals(identityDocumentUrls(JSON.stringify({ urls: [A, B] })), [A, B]);
  assertEquals(identityDocumentUrls(JSON.stringify({ urls: [] })), null);
  assertEquals(identityDocumentUrls(JSON.stringify({})), null);
  assertEquals(identityDocumentUrls("not json"), null);
  assertEquals(
    identityDocumentUrls(JSON.stringify({ urls: [A, `${B}/`] })),
    null,
  );
  assertEquals(
    identityDocumentUrls(JSON.stringify({ urls: [A, "https://a/x"] })),
    null,
  );
  assertEquals(identityDocumentUrls(JSON.stringify({ urls: [A, B, A] })), null);
});

test("urlListsDiffer counts order", () => {
  assertEquals(urlListsDiffer([A, B], [A, B]), false);
  assertEquals(urlListsDiffer([A, B], [B, A]), true);
  assertEquals(urlListsDiffer([A], [A, B]), true);
});

test("urlWrapDelayMs is full jitter between 0 and an exponential ceiling capped at 5 minutes", () => {
  assertEquals(urlWrapDelayMs(1, () => 0), URL_WRAP_FLOOR_MS);
  assertEquals(urlWrapDelayMs(1, () => 0.999999), URL_WRAP_BASE_MS);
  assertEquals(urlWrapDelayMs(2, () => 0.999999), 2 * URL_WRAP_BASE_MS);
  assertEquals(urlWrapDelayMs(40, () => 0.999999), URL_WRAP_CAP_MS);
});

test("PanelUrlRotation tries each address in order, then wraps to URL 0 with a wait", () => {
  const rotation = new PanelUrlRotation([A, B, C], () => 0.5);
  assertEquals(rotation.active, A);
  assertEquals(rotation.failOver(fail("transient")), { kind: "next", url: B });
  assertEquals(rotation.failOver(fail("panel-identity")), {
    kind: "next",
    url: C,
  });
  const wrapped = rotation.failOver(fail("tls-trust"));
  assertEquals(rotation.active, A);
  assertEquals(wrapped, {
    kind: "wrapped",
    url: A,
    delayMs: URL_WRAP_FLOOR_MS +
      Math.floor(0.5 * (URL_WRAP_BASE_MS - URL_WRAP_FLOOR_MS + 1)),
    // One address was only unreachable: a pass to retry, never a park.
    worst: fail("transient"),
  });
});

test("PanelUrlRotation reports a refusal only when every address of the pass refused", () => {
  const rotation = new PanelUrlRotation([A, B], () => 0);
  rotation.failOver(fail("tls-trust", "untrusted at A"));
  const severe = rotation.failOver(fail("panel-identity", "bad key at B"));
  assertEquals(
    severe.kind === "wrapped" ? severe.worst : null,
    fail("panel-identity", "bad key at B"),
  );
  // URL 0 briefly down, URL 1 refusing: retried, so a short outage never parks.
  rotation.failOver(fail("transient", "A down"));
  const mixed = rotation.failOver(fail("panel-identity", "bad key at B"));
  assertEquals(
    mixed.kind === "wrapped" ? mixed.worst : null,
    fail("transient", "A down"),
  );
});

test("PanelUrlRotation leaves failures that are not about the address to the caller", () => {
  const rotation = new PanelUrlRotation([A, B]);
  for (const kind of ["permanent", "awaiting-license", "awaiting-seat"]) {
    assertEquals(rotation.failOver(fail(kind)), { kind: "none" });
  }
  assertEquals(rotation.active, A);
  assertEquals(new PanelUrlRotation([A]).failOver(fail("transient")), {
    kind: "none",
  });
});

test("PanelUrlRotation restart goes back to URL 0 and resets the wait", () => {
  const rotation = new PanelUrlRotation([A, B], () => 0.999999);
  rotation.failOver(fail("transient"));
  rotation.failOver(fail("transient"));
  rotation.failOver(fail("transient"));
  rotation.restart();
  assertEquals(rotation.active, A);
  rotation.failOver(fail("transient"));
  const wrapped = rotation.failOver(fail("transient"));
  assertEquals(wrapped, {
    kind: "wrapped",
    url: A,
    delayMs: URL_WRAP_BASE_MS,
    worst: fail("transient"),
  });
});

test("PanelUrlRotation replace keeps the active address when it is still listed", () => {
  const rotation = new PanelUrlRotation([A, B]);
  rotation.failOver(fail("transient"));
  rotation.replace([C, B]);
  assertEquals(rotation.active, B);
  rotation.replace([C]);
  assertEquals(rotation.active, C);
  rotation.replace([]);
  assertEquals(rotation.urls, [C]);
  assertThrows(() => new PanelUrlRotation([]), TypeError);
});
