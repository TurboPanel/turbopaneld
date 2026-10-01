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
    args: ["-c", `${retry}\n${fetchLine}\n$TP_CURL_FETCH "$1"`, "sh", url],
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
  assertStringIncludes(source, "curl -fsSL %s --cacert %s");
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
