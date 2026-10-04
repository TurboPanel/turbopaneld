import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const runShPath = join(here, "../../scripts/run.sh");

/** The `NAME=...` assignment line from run.sh, verbatim. */
function assignmentLine(source: string, name: string): string {
  const line = source.split("\n").find((l) => l.startsWith(`${name}=`));
  if (!line) throw new TypeError(`missing ${name}= in run.sh`);
  return line;
}

/** The `tp_curl_net_retry` function from run.sh, verbatim. */
function netRetryFunction(source: string): string {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.startsWith("tp_curl_net_retry() {"));
  if (start < 0) throw new TypeError("missing tp_curl_net_retry in run.sh");
  const end = lines.indexOf("}", start);
  return lines.slice(start, end + 1).join("\n");
}

/**
 * Run run.sh's tp_curl_net_retry with a stub `curl` that exits with each of
 * `exits` in turn (the last repeats) and prints "payload" on 0.
 */
async function runWithStubCurl(exits: number[]) {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      join(dir, "curl"),
      `#!/bin/sh
n=$(cat "$STUB_DIR/n" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$STUB_DIR/n"
set -- $STUB_EXITS
i=1
for e in "$@"; do code=$e; [ "$i" -ge "$n" ] && break; i=$((i + 1)); done
[ "$code" = 0 ] && printf payload
exit "$code"
`,
      { mode: 0o755 },
    );
    const source = await Deno.readTextFile(runShPath);
    const out = await new Deno.Command("sh", {
      args: [
        "-c",
        `set -eu\n${netRetryFunction(source)}\ntp_curl_net_retry -fsSL x`,
      ],
      env: {
        PATH: `${dir}:${Deno.env.get("PATH")}`,
        STUB_DIR: dir,
        STUB_EXITS: exits.join(" "),
        TP_CURL_NET_RETRY_UNIT: "0",
      },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const calls = Number(await Deno.readTextFile(join(dir, "n")));
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      calls,
    };
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

test("run.sh retries a DNS failure (curl exit 6) and then succeeds", async () => {
  const res = await runWithStubCurl([6, 6, 0]);
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "payload");
  assertEquals(res.calls, 3);
});

test("run.sh stops after four attempts on a persistent DNS failure", async () => {
  const res = await runWithStubCurl([6]);
  assertEquals(res.code, 6);
  assertEquals(res.calls, 4);
});

test("run.sh does not retry an HTTP error (curl exit 22)", async () => {
  const res = await runWithStubCurl([22, 0]);
  assertEquals(res.code, 22);
  assertEquals(res.calls, 1);
});

/** Serve `statuses` in turn (the last repeats); count requests. */
function serve(statuses: number[]) {
  const hits = { n: 0 };
  const server = Deno.serve({ hostname: "127.0.0.1", port: 0 }, () => {
    const status = statuses[Math.min(hits.n, statuses.length - 1)];
    hits.n += 1;
    return new Response(status === 200 ? "payload" : "no", { status });
  });
  return { hits, server, url: `http://127.0.0.1:${server.addr.port}/x` };
}

/** Run run.sh's own TP_CURL_FETCH against `url`, with the 3 s wait shortened. */
async function fetchViaRunSh(url: string) {
  const source = await Deno.readTextFile(runShPath);
  const retry = assignmentLine(source, "TP_CURL_RETRY").replace(
    "--retry-delay 3",
    "--retry-delay 1",
  );
  const fetchLine = assignmentLine(source, "TP_CURL_FETCH");
  const out = await new Deno.Command("sh", {
    args: [
      "-c",
      `set -eu\n${
        netRetryFunction(source)
      }\n${retry}\n${fetchLine}\n$TP_CURL_FETCH "$1"`,
      "sh",
      url,
    ],
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
  };
}

test("run.sh curl policy is two retries, 3 s apart, capped at 60 s", async () => {
  const source = await Deno.readTextFile(runShPath);
  assertEquals(
    assignmentLine(source, "TP_CURL_RETRY"),
    "TP_CURL_RETRY='--retry 2 --retry-delay 3 --retry-max-time 60'",
  );
  assertStringIncludes(source, "tp_curl_net_retry -fsSL %s --cacert %s");
});

test("run.sh curl retries a 503 and then succeeds", async () => {
  const s = serve([503, 200]);
  try {
    const res = await fetchViaRunSh(s.url);
    assertEquals(res.code, 0);
    assertEquals(res.stdout, "payload");
    assertEquals(s.hits.n, 2);
  } finally {
    await s.server.shutdown();
  }
});

test("run.sh curl gives up after three 504s", async () => {
  const s = serve([504]);
  try {
    const res = await fetchViaRunSh(s.url);
    assertEquals(res.code, 22);
    assertEquals(s.hits.n, 3);
  } finally {
    await s.server.shutdown();
  }
});

test("run.sh curl does not retry a 404", async () => {
  const s = serve([404, 200]);
  try {
    const res = await fetchViaRunSh(s.url);
    assertEquals(res.code, 22);
    assertEquals(s.hits.n, 1);
  } finally {
    await s.server.shutdown();
  }
});

test("run.sh never prints a download URL's query string on failure", async () => {
  const source = await Deno.readTextFile(runShPath);
  const lib = await Deno.readTextFile(
    join(here, "../../scripts/lib/release-artifacts.sh"),
  );
  for (const text of [source, lib]) {
    assertStringIncludes(text, "failed to download ${_fetch_url%%[?#]*}");
    assertEquals(text.includes("failed to download $_fetch_url"), false);
  }
  // The expansion itself drops a signed query and fragment.
  const out = await new Deno.Command("sh", {
    args: [
      "-c",
      '_fetch_url="https://h.test/a?X-Amz-Signature=abc&token=t#f"; printf %s "${_fetch_url%%[?#]*}"',
    ],
    stdout: "piped",
  }).output();
  assertEquals(new TextDecoder().decode(out.stdout), "https://h.test/a");
});
