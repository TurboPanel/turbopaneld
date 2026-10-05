import { assertEquals } from "@std/assert";
import {
  fetchLoopbackText,
  parsePrometheusExposition,
} from "./prom-exposition.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

function labelsOf(blob: string): Record<string, string> | undefined {
  return parsePrometheusExposition(`m{${blob}} 1`)[0]?.labels;
}

test("parsePrometheusExposition reads name, labels and value", () => {
  const samples = parsePrometheusExposition(
    [
      "# HELP http_requests_total Total requests.",
      "# TYPE http_requests_total counter",
      'http_requests_total{method="GET",code="200"} 42',
      "plain_gauge 1.5",
      "",
      "broken line without value",
      "nan_value NaN",
    ].join("\n"),
  );
  assertEquals(samples, [
    {
      name: "http_requests_total",
      labels: { method: "GET", code: "200" },
      value: 42,
    },
    { name: "plain_gauge", labels: {}, value: 1.5 },
  ]);
});

test('label values unescape only \\" and \\\\', () => {
  assertEquals(labelsOf(String.raw`a="x\"y",b="x\\y",c="\n\t"`), {
    a: 'x"y',
    b: String.raw`x\y`,
    c: String.raw`\n\t`,
  });
  assertEquals(labelsOf(String.raw`a="\\\\",b="\"\"",c=""`), {
    a: String.raw`\\`,
    b: '""',
    c: "",
  });
});

test("label pairs tolerate junk between them and take the last duplicate", () => {
  assertEquals(labelsOf(`a="1" junk , b="2"\tc="3"d="4"`), {
    a: "1",
    b: "2",
    c: "3",
    d: "4",
  });
  assertEquals(labelsOf(`a="1",a="2"`), { a: "2" });
  assertEquals(labelsOf(`1abc="x",_y="z"`), { abc: "x", _y: "z" });
});

test("malformed label blobs keep the pairs that parse", () => {
  assertEquals(labelsOf(`a=1,b="2"`), { b: "2" });
  assertEquals(labelsOf(`a= "1",b="2"`), { b: "2" });
  assertEquals(labelsOf(`a="x b="1"`), { a: "x b=" });
  assertEquals(labelsOf(`a="1",b="unterminated`), { a: "1" });
  assertEquals(labelsOf('a="1",b="x\\'), { a: "1" });
  assertEquals(labelsOf(String.raw`a="\"b=\"x"`), { a: '"b="x' });
  assertEquals(labelsOf(`abc=`), {});
  assertEquals(labelsOf(""), {});
});

test("label parsing stays linear on adversarial input", () => {
  const blob = `${"a".repeat(200_000)}="`;
  const started = performance.now();
  // Past the line-length cap the line is skipped outright; below it, the
  // scanner still handles the pathological shape in linear time.
  assertEquals(labelsOf(blob), undefined);
  assertEquals(labelsOf(`${"a".repeat(7_000)}="`), {});
  const elapsed = performance.now() - started;
  // The regex-based parser took seconds here; the scanner takes milliseconds.
  assertEquals(elapsed < 1_000, true, `took ${elapsed}ms`);
});

function textResponse(
  body: BodyInit | null,
  headers: Record<string, string> = { "content-type": "text/plain" },
): Response {
  return new Response(body, { headers });
}

test("fetchLoopbackText returns a normal exposition body", async () => {
  const text = await fetchLoopbackText("127.0.0.1:1", "/metrics", {
    fetch: () => Promise.resolve(textResponse("caddy_http_requests_total 5\n")),
  });
  assertEquals(text, "caddy_http_requests_total 5\n");
});

test("fetchLoopbackText gives up on an endless body at the byte cap", async () => {
  let cancelled = false;
  const endless = new ReadableStream<Uint8Array>({
    pull(controller) {
      controller.enqueue(new Uint8Array(64 * 1024));
    },
    cancel() {
      cancelled = true;
    },
  });
  const text = await fetchLoopbackText("127.0.0.1:1", "/metrics", {
    fetch: () => Promise.resolve(textResponse(endless)),
    maxBytes: 256 * 1024,
  });
  assertEquals(text, undefined);
  assertEquals(cancelled, true);
});

test("fetchLoopbackText rejects a declared oversize body and non-text content", async () => {
  assertEquals(
    await fetchLoopbackText("127.0.0.1:1", "/metrics", {
      fetch: () =>
        Promise.resolve(
          textResponse("x", {
            "content-type": "text/plain",
            "content-length": "99999999",
          }),
        ),
    }),
    undefined,
  );
  assertEquals(
    await fetchLoopbackText("127.0.0.1:1", "/metrics", {
      fetch: () =>
        Promise.resolve(
          textResponse("caddy_http_requests_total 5\n", {
            "content-type": "application/json",
          }),
        ),
    }),
    undefined,
  );
});

test("parsePrometheusExposition ignores implausible values and oversized lines", () => {
  const samples = parsePrometheusExposition(
    [
      "caddy_http_requests_total 5",
      "caddy_http_requests_total 9e30",
      `caddy_http_x{a="${"y".repeat(9000)}"} 1`,
    ].join("\n"),
  );
  assertEquals(samples.map((s) => s.value), [5]);
});
