import { assert, assertEquals } from "@std/assert";
import { parse } from "yaml";
import { join } from "@std/path";
import { isSha256Hex } from "./download-verify.ts";
import { CLOUDFLARED_SHA256 } from "./assets.ts";
import { IMAGE_BUILD_SHA256 } from "../deploy/release/image-build.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROLES = new URL("../../orchestration/roles/", import.meta.url).pathname;

function readDefaults(role: string): Record<string, unknown> {
  return parse(
    Deno.readTextFileSync(join(ROLES, role, "defaults", "main.yml")),
  ) as Record<string, unknown>;
}

function digestMap(role: string, name: string): Record<string, string> {
  const value = readDefaults(role)[name];
  assert(
    typeof value === "object" && value !== null,
    `${role}: ${name} must be a map of digests`,
  );
  return value as Record<string, string>;
}

// Every downloaded artifact that is pinned per architecture: role, variable,
// and the architecture keys the role indexes it by.
const ROLE_DIGESTS: Array<[string, string, string[]]> = [
  ["buildkit", "buildkit_sha256", ["amd64", "arm64"]],
  ["buildkit", "railpack_sha256", ["amd64", "arm64"]],
  ["stripe-listen", "stripe_cli_sha256", ["x86_64", "arm64"]],
  ["nginx", "nginx_deb_sha256", ["amd64", "arm64"]],
  ["redis", "redis_deb_sha256", ["amd64", "arm64"]],
  ["openlitespeed", "openlitespeed_sha256", ["x86_64", "aarch64"]],
];

for (const [role, name, arches] of ROLE_DIGESTS) {
  test(`${role}: ${name} pins a SHA-256 for every architecture`, () => {
    const map = digestMap(role, name);
    assertEquals(Object.keys(map).sort(), [...arches].sort());
    for (const arch of arches) {
      assert(isSha256Hex(map[arch]), `${name}[${arch}] is not a SHA-256`);
    }
  });
}

test("cloudflared and the build tool pin both architectures in code", () => {
  assertEquals(Object.keys(CLOUDFLARED_SHA256).sort(), [
    "cloudflared-linux-amd64",
    "cloudflared-linux-arm64",
  ]);
  for (const digest of Object.values(CLOUDFLARED_SHA256)) {
    assert(isSha256Hex(digest));
  }
  for (const digest of Object.values(IMAGE_BUILD_SHA256)) {
    assert(isSha256Hex(digest));
  }
});

// Download tasks that are verified some other way, with the reason, keyed by
// task file and task name. Any other download, including a new one in these
// files, must carry a digest check, so a download without one fails.
const DOWNLOAD_EXCEPTIONS = new Map<string, string>([
  [
    "repo-key/tasks/main.yml: Download the key",
    "repository signing keys are checked by fingerprint under the key policy (warn by default), not by a file digest, so a key rotation never blocks installs",
  ],
  [
    "ui-build/tasks/main.yml: Download UI static export from CDN",
    "development-only checkout step; the artifact URL is chosen by the developer",
  ],
]);

// One block per task, nested tasks included, so a download is matched with
// the task that holds it.
function taskBlocks(text: string): string[] {
  return text.split(/\n(?= *- name:)/);
}

function taskName(block: string): string {
  return /name:\s*(.+)/.exec(block)?.[1] ?? "(unnamed)";
}

/** Why the task downloads without a digest check, or null when it is fine. */
function uncheckedDownload(block: string): string | null {
  const getsUrl = /ansible\.builtin\.get_url:/.test(block);
  if (getsUrl && !/\bchecksum:\s*"?(sha256|\{\{)/.test(block)) {
    return "get_url without checksum";
  }
  const curls = /\bcurl\s+-[a-zA-Z]*[fsSL]/.test(block);
  if (curls && !DIGEST_COMPARISON.test(block)) {
    return "curl without a digest comparison";
  }
  return null;
}

const DIGEST_COMPARISON = /\[ "\$GOT" = /;

function roleTaskFiles(): string[] {
  const files: string[] = [];
  for (const role of Deno.readDirSync(ROLES)) {
    if (!role.isDirectory) continue;
    const tasks = join(ROLES, role.name, "tasks");
    try {
      for (const f of Deno.readDirSync(tasks)) {
        if (f.isFile && f.name.endsWith(".yml")) {
          files.push(`${role.name}/tasks/${f.name}`);
        }
      }
    } catch (error) {
      if (!(error instanceof Deno.errors.NotFound)) throw error;
    }
  }
  return files.sort();
}

test("nginx and Redis pins name the trixie builds", () => {
  const nginx = readDefaults("nginx");
  assert(String(nginx.nginx_deb_version).endsWith("~trixie"));
  assertEquals(nginx.nginx_deb_dist, "trixie");
  const redisTasks = Deno.readTextFileSync(
    join(ROLES, "redis", "tasks", "main.yml"),
  );
  assert(
    redisTasks.includes("pool/trixie/") && redisTasks.includes("~trixie1_"),
  );
  assert(!redisTasks.includes("bookworm"));
});

test("every mismatch message names a pin file that exists", () => {
  const repo = join(ROLES, "..", "..");
  const missing: string[] = [];
  for (const rel of roleTaskFiles()) {
    const text = Deno.readTextFileSync(join(ROLES, rel));
    for (const m of text.matchAll(/(orchestration\/roles\/[\w./-]+\.yml)/g)) {
      try {
        Deno.statSync(join(repo, m[1]));
      } catch {
        missing.push(`${rel}: ${m[1]}`);
      }
    }
  }
  assertEquals(missing, []);
  // Every shell download's message must point at a defaults file.
  for (const rel of roleTaskFiles()) {
    const text = Deno.readTextFileSync(join(ROLES, rel));
    for (const block of taskBlocks(text)) {
      if (
        /\bcurl\s+-[a-zA-Z]*[fsSL]/.test(block) && DIGEST_COMPARISON.test(block)
      ) {
        assert(
          /update \w+ in orchestration\/roles\/[\w-]+\/defaults\/main\.yml/
            .test(block),
          `${rel}: mismatch message does not name its pin file`,
        );
        assert(
          /expected \$\{\w+\}, got \$\{GOT\}/.test(block),
          `${rel}: mismatch message must show the expected and received digest`,
        );
      }
    }
  }
});

test("every role download is checked against a pinned SHA-256", () => {
  const offenders: string[] = [];
  for (const rel of roleTaskFiles()) {
    const text = Deno.readTextFileSync(join(ROLES, rel));
    for (const block of taskBlocks(text)) {
      const task = `${rel}: ${taskName(block)}`;
      const problem = uncheckedDownload(block);
      if (problem !== null && !DOWNLOAD_EXCEPTIONS.has(task)) {
        offenders.push(`${task} (${problem})`);
      }
    }
  }
  assertEquals(offenders, []);
});

test("every download exception names a task that still downloads unchecked", () => {
  const unchecked = new Set<string>();
  for (const rel of roleTaskFiles()) {
    const text = Deno.readTextFileSync(join(ROLES, rel));
    for (const block of taskBlocks(text)) {
      if (uncheckedDownload(block) !== null) {
        unchecked.add(`${rel}: ${taskName(block)}`);
      }
    }
  }
  const stale = [...DOWNLOAD_EXCEPTIONS.keys()].filter((task) =>
    !unchecked.has(task)
  );
  assertEquals(stale, []);
});
