/**
 * Road to 0.2.x row r2-signing-key-environment: the release signing key is an
 * environment secret, so only a job that names a GitHub environment can read
 * it. A job that reads it without declaring one would sign with a plain
 * repo-level secret that any code on a trunk workflow could use.
 */
import { assert } from "@std/assert";
import { fromFileUrl, join } from "@std/path";
import { parse } from "yaml";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const WORKFLOWS = join(
  fromFileUrl(new URL(".", import.meta.url)),
  "..",
  ".github",
  "workflows",
);

type Job = { environment?: unknown } & Record<string, unknown>;

function workflowJobs(file: string): Array<[string, Job]> {
  const doc = parse(Deno.readTextFileSync(join(WORKFLOWS, file))) as {
    jobs?: Record<string, Job>;
  };
  return Object.entries(doc.jobs ?? {});
}

const SIGNING_SECRET = /secrets\.[A-Z_]*SIGNING_KEY/;

test("every job that reads a signing-key secret names a GitHub environment", () => {
  let readers = 0;
  for (const entry of Deno.readDirSync(WORKFLOWS)) {
    if (!entry.isFile || !entry.name.endsWith(".yml")) continue;
    for (const [jobName, job] of workflowJobs(entry.name)) {
      if (!SIGNING_SECRET.test(JSON.stringify(job))) continue;
      readers++;
      const environment = job.environment;
      assert(
        typeof environment === "string" && environment.length > 0,
        `${entry.name} job ${jobName} reads the signing key but declares no environment`,
      );
    }
  }
  assert(readers > 0, "no job reads the signing key: the scan found nothing");
});

test("a job on the live channel signs from the protected release environment", () => {
  const release = workflowJobs("release.yml").find(([, job]) =>
    SIGNING_SECRET.test(JSON.stringify(job))
  );
  assert(release, "release.yml has no signing job");
  assert(
    String(release[1].environment).includes("'release'"),
    "release.yml's signing job must resolve to the `release` environment for the live channel",
  );
});
