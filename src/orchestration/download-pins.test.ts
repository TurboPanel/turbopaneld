import { assert, assertEquals } from "@std/assert";
import { parse } from "yaml";
import { join } from "@std/path";
import { isSha256Hex } from "./download-verify.ts";
import { CLOUDFLARED_SHA256 } from "./assets.ts";
import { RAILPACK_SHA256 } from "../deploy/release/railpack-build.ts";

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
  for (const digest of Object.values(RAILPACK_SHA256)) {
    assert(isSha256Hex(digest));
  }
});

// Downloads that are verified some other way, with the reason. Anything not
// listed here must carry a digest check, so a new download without one fails.
const DOWNLOAD_EXCEPTIONS = new Map<string, string>([
  [
    "ui-build/tasks/main.yml",
    "development-only checkout step; the artifact URL is chosen by the developer",
  ],
]);

function taskBlocks(text: string): string[] {
  return text.split(/\n(?=(?:- name:| {4}- name:))/);
}

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
        /\bcurl\s+-[a-zA-Z]*[fsSL]/.test(block) && /sha256sum\s+-c/.test(block)
      ) {
        assert(
          /update \w+ in orchestration\/roles\/[\w-]+\/defaults\/main\.yml/
            .test(block),
          `${rel}: mismatch message does not name its pin file`,
        );
      }
    }
  }
});

test("every role download is checked against a pinned SHA-256", () => {
  const offenders: string[] = [];
  for (const rel of roleTaskFiles()) {
    if (DOWNLOAD_EXCEPTIONS.has(rel)) continue;
    const text = Deno.readTextFileSync(join(ROLES, rel));
    for (const block of taskBlocks(text)) {
      const name = /name:\s*(.+)/.exec(block)?.[1] ?? "(unnamed)";
      const getsUrl = /ansible\.builtin\.get_url:/.test(block);
      const curls = /\bcurl\s+-[a-zA-Z]*[fsSL]/.test(block);
      if (getsUrl && !/\bchecksum:\s*"?(sha256|\{\{)/.test(block)) {
        offenders.push(`${rel}: ${name} (get_url without checksum)`);
      }
      if (curls && !/sha256sum\s+-c/.test(block)) {
        offenders.push(`${rel}: ${name} (curl without sha256sum -c)`);
      }
    }
  }
  assertEquals(offenders, []);
});

test("download exceptions still exist", () => {
  for (const rel of DOWNLOAD_EXCEPTIONS.keys()) {
    const stat = Deno.statSync(join(ROLES, rel));
    assert(stat.isFile, rel);
  }
});
