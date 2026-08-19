import { assertEquals } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const runShPath = join(here, "../../scripts/run.sh");

function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) {
    throw new TypeError(`missing ${name} in run.sh`);
  }
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new TypeError(`unclosed ${name} in run.sh`);
}

async function evalHelper(
  helper: string,
  body: string,
): Promise<{ stdout: string; status: number }> {
  const script = `${helper}\n${body}\n`;
  const proc = new Deno.Command("sh", {
    args: ["-eu", "-c", script],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    status: out.code,
  };
}

test("tp_curl_http_code normalizes a non-zero curl that already printed 000 to exactly 000", async () => {
  const source = await Deno.readTextFile(runShPath);
  if (source.includes('|| echo "000"')) {
    throw new Error(
      'run.sh still concatenates || echo "000" onto curl %{http_code}',
    );
  }
  const helper = extractShellFunction(source, "tp_curl_http_code");
  const result = await evalHelper(
    helper,
    [
      "fake_curl() { printf '%s' '000'; return 1; }",
      "got=$(tp_curl_http_code fake_curl)",
      "printf '%s' \"$got\"",
      '[ "$got" = "000" ]',
    ].join("\n"),
  );
  assertEquals(result.status, 0, `helper failed: ${result.stdout}`);
  assertEquals(result.stdout, "000");
});

test("tp_curl_http_code preserves a successful %{http_code}", async () => {
  const source = await Deno.readTextFile(runShPath);
  const helper = extractShellFunction(source, "tp_curl_http_code");
  const result = await evalHelper(
    helper,
    [
      "fake_curl() { printf '%s' '200'; return 0; }",
      "got=$(tp_curl_http_code fake_curl)",
      "printf '%s' \"$got\"",
    ].join("\n"),
  );
  assertEquals(result.status, 0);
  assertEquals(result.stdout, "200");
});

test("tp_ca_validates_leaf fails when curl exits non-zero", async () => {
  const source = await Deno.readTextFile(runShPath);
  const curlHelper = extractShellFunction(source, "tp_curl_http_code");
  const leafHelper = extractShellFunction(source, "tp_ca_validates_leaf");
  const result = await evalHelper(
    `${curlHelper}\n${leafHelper}`,
    [
      "HOST_URL=https://example.test",
      "curl() { printf '%s' '000'; return 1; }",
      "if tp_ca_validates_leaf /dev/null; then",
      "  printf fail",
      "  exit 1",
      "fi",
      "printf ok",
    ].join("\n"),
  );
  assertEquals(result.status, 0);
  assertEquals(result.stdout, "ok");
});
