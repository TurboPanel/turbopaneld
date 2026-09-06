import { assertEquals } from "@std/assert";
import { parsePrometheusExposition } from "./prom-exposition.ts";

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
  assertEquals(labelsOf(blob), {});
  const elapsed = performance.now() - started;
  // The regex-based parser took seconds here; the scanner takes milliseconds.
  assertEquals(elapsed < 1_000, true, `took ${elapsed}ms`);
});
