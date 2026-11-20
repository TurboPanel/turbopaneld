/**
 * The database images declare a VOLUME, so a container removed without `-v`
 * leaves an anonymous volume (about 170 MB) behind on every run. This guards
 * every real-server suite against calling `docker rm -f` without `-v`.
 */
import { assert } from "@std/assert";

const DIR = new URL(".", import.meta.url);

Deno.test("docker suites remove containers together with their volumes", async () => {
  const offenders: string[] = [];
  let suites = 0;
  for await (const entry of Deno.readDir(DIR)) {
    if (!entry.name.endsWith(".docker.test.ts")) continue;
    suites++;
    const text = await Deno.readTextFile(new URL(entry.name, DIR));
    for (const match of text.matchAll(/\[\s*"rm"\s*,[^\]]*\]/g)) {
      if (match[0].includes('"volume"') || match[0].includes('"network"')) {
        continue;
      }
      if (!/"-[a-z]*v[a-z]*"/.test(match[0])) {
        offenders.push(`${entry.name}: ${match[0].replace(/\s+/g, " ")}`);
      }
    }
  }
  assert(suites > 0, "no docker suites found");
  assert(
    offenders.length === 0,
    `docker rm without -v leaves volumes behind:\n${offenders.join("\n")}`,
  );
});
