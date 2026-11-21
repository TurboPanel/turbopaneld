/**
 * The database images declare a VOLUME, so a container removed without `-v`
 * leaves an anonymous volume (about 170 MB) behind on every run. This guards
 * every real-server suite against calling `docker rm` without `-v`.
 */
import { assert } from "@std/assert";

const DIR = new URL("../../", import.meta.url).pathname;
const SUITE = /\.(docker|real[\w-]*)\.test\.ts$/;
// A docker call whose argv starts with `rm` or `container rm`.
const DOCKER_RM =
  /\b\w*[dD]ocker\w*\(\s*(\[\s*(?:"container"\s*,\s*)?"rm"\s*,[^\]]*\])/g;
const HAS_VOLUMES = /"-[a-zA-Z]*v[a-zA-Z]*"|"--volumes"/;

async function* walk(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) yield* walk(path);
    else if (entry.isFile) yield path;
  }
}

Deno.test("docker suites remove containers together with their volumes", async () => {
  const offenders: string[] = [];
  let suites = 0;
  for await (const url of walk(DIR)) {
    if (!SUITE.test(url)) continue;
    suites++;
    const text = await Deno.readTextFile(url);
    for (const match of text.matchAll(DOCKER_RM)) {
      if (!HAS_VOLUMES.test(match[1])) {
        offenders.push(
          `${url.split("/src/")[1]}: ${match[1].replace(/\s+/g, " ")}`,
        );
      }
    }
  }
  assert(suites > 0, "no docker suites found");
  assert(
    offenders.length === 0,
    `docker rm without -v leaves volumes behind:\n${offenders.join("\n")}`,
  );
});
