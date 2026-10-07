/**
 * Upstream version watch (network part). Reads our pins, fetches the upstream
 * package lists and release feeds, and writes the tracking-issue body to the
 * path given as the first argument (stdout when none). The checks themselves
 * live in `scripts/lib/upstream-versions.ts`.
 *
 *   deno run --allow-read=orchestration --allow-write=. \
 *     --allow-net=rpms.litespeedtech.com,packages.sury.org,nginx.org,api.github.com,downloads.apache.org \
 *     --allow-env=GH_TOKEN,LOG_TOKENS,LOG_STREAM scripts/check-upstream-versions.ts report.md
 *
 * Exits 1 after writing the report when an upstream could not be read.
 */
import {
  readPins,
  renderReport,
  watchUpstream,
} from "./lib/upstream-versions.ts";

const root = new URL("../orchestration/", import.meta.url);
const read = (path: string) => Deno.readTextFile(new URL(path, root));

async function fetchText(url: string): Promise<string> {
  const headers: Record<string, string> = {
    "User-Agent": "turbopaneld-upstream-watch",
  };
  const token = Deno.env.get("GH_TOKEN");
  if (token && new URL(url).hostname === "api.github.com") {
    headers.Authorization = `Bearer ${token}`;
  }
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel();
    throw new Error(`${url}: HTTP ${response.status}`);
  }
  const body = url.endsWith(".gz")
    ? response.body.pipeThrough(new DecompressionStream("gzip"))
    : response.body;
  return await new Response(body).text();
}

if (import.meta.main) {
  const pins = readPins({
    registryJson: await read("runtime-registry.json"),
    openlitespeedDefaults: await read("roles/openlitespeed/defaults/main.yml"),
    nginxDefaults: await read("roles/nginx/defaults/main.yml"),
    apacheDefaults: await read("roles/apache/defaults/main.yml"),
  });
  const result = await watchUpstream(pins, fetchText);
  const report = renderReport(result, new Date().toISOString().slice(0, 10));
  const out = Deno.args[0];
  if (out) await Deno.writeTextFile(out, report);
  else console.log(report);
  const actions = result.findings.filter((finding) =>
    finding.level === "action"
  ).length;
  console.error(
    `upstream watch: ${actions} action needed, ${
      result.findings.length - actions
    } information only, ${result.failures.length} could not be checked`,
  );
  if (result.failures.length > 0) Deno.exit(1);
}
