import { assertEquals, assertRejects } from "@std/assert";
import {
  _internal,
  readRemoteFiles,
  resolveDefaultBranch,
} from "./read-remote-files.ts";

const test = Deno.test.bind(Deno);

async function git(args: string[], cwd: string): Promise<void> {
  const { code, stderr } = await new Deno.Command("git", {
    args,
    cwd,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`,
    );
  }
}

/** A real local repository — the reader talks to git, so fixtures would lie. */
async function makeRepo(): Promise<
  { path: string; cleanup: () => Promise<void> }
> {
  const path = await Deno.makeTempDir({ prefix: "tp-repo-fixture-" });
  await git(["init", "-q", "-b", "main"], path);
  await git(["config", "user.email", "t@example.com"], path);
  await git(["config", "user.name", "T"], path);
  await Deno.writeTextFile(
    `${path}/docker-compose.yml`,
    "services:\n  web:\n    image: nginx\n",
  );
  await Deno.writeTextFile(`${path}/README.md`, "hello\n");
  await Deno.mkdir(`${path}/public`);
  await Deno.writeTextFile(`${path}/public/index.html`, "<h1>hi</h1>\n");
  await Deno.writeFile(
    `${path}/logo.png`,
    new Uint8Array([0x89, 0x50, 0x00, 0x01]),
  );
  await git(["add", "-A"], path);
  await git(["commit", "-qm", "init"], path);
  return { path, cleanup: () => Deno.remove(path, { recursive: true }) };
}

test("readRemoteFiles returns content at a pinned commit", async () => {
  const repo = await makeRepo();
  try {
    const result = await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      paths: ["docker-compose.yml", "public/index.html", "missing.yml"],
      maxBytesPerFile: 256 * 1024,
    });
    assertEquals(result.commitSha.length, 40);
    const compose = result.files.find((f) => f.path === "docker-compose.yml");
    assertEquals(compose?.found, true);
    assertEquals(compose?.content?.includes("image: nginx"), true);
    assertEquals(
      result.files.find((f) => f.path === "public/index.html")?.found,
      true,
    );
    // A missing file is an ANSWER, not a failure — it is what the wizard renders.
    const missing = result.files.find((f) => f.path === "missing.yml");
    assertEquals(missing?.found, false);
    assertEquals(missing?.reason, "not_found");
  } finally {
    await repo.cleanup();
  }
});

test("readRemoteFiles refuses binary and oversized blobs", async () => {
  const repo = await makeRepo();
  try {
    const result = await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      paths: ["logo.png", "README.md"],
      // Small enough that README trips the size gate.
      maxBytesPerFile: 3,
    });
    assertEquals(
      result.files.find((f) => f.path === "logo.png")?.reason,
      "too_large",
    );
    assertEquals(
      result.files.find((f) => f.path === "README.md")?.reason,
      "too_large",
    );
  } finally {
    await repo.cleanup();
  }
});

test("readRemoteFiles reports a NUL-bearing blob as binary", async () => {
  const repo = await makeRepo();
  try {
    const result = await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      paths: ["logo.png"],
      maxBytesPerFile: 256 * 1024,
    });
    // Returning binary as a lossy string would be worse than refusing it.
    assertEquals(result.files[0]?.reason, "binary");
  } finally {
    await repo.cleanup();
  }
});

test("readRemoteFiles refuses a path that could escape the repository", async () => {
  const repo = await makeRepo();
  try {
    const result = await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      // `:` would separate rev from path in `rev:path`; `..` walks out.
      paths: ["../etc/passwd", "a:b", "/etc/passwd"],
      maxBytesPerFile: 256 * 1024,
    });
    assertEquals(result.files.every((f) => f.found === false), true);
  } finally {
    await repo.cleanup();
  }
});

test("readRemoteFiles lists a directory", async () => {
  const repo = await makeRepo();
  try {
    const result = await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      paths: [],
      listPath: "",
      maxBytesPerFile: 256 * 1024,
    });
    const names = result.entries.map((e) => e.path).sort();
    assertEquals(names.includes("docker-compose.yml"), true);
    assertEquals(names.includes("public"), true);
  } finally {
    await repo.cleanup();
  }
});

test("readRemoteFiles fails loudly on an unreachable remote", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(() =>
      readRemoteFiles({
        cloneUrl: `${dir}/does-not-exist`,
        ref: "main",
        paths: ["x.yml"],
        maxBytesPerFile: 1024,
      })
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("readRemoteFiles leaves no scratch or credential material behind", async () => {
  const repo = await makeRepo();
  const scratchRoot = await Deno.makeTempDir({ prefix: "tp-scratch-root-" });
  try {
    await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      paths: ["README.md"],
      maxBytesPerFile: 256 * 1024,
      credential: "ghp_exampletoken",
      credentialKind: "token",
      credentialUsername: "x-access-token",
    }, scratchRoot);

    // The askpass script holds the token in plaintext at 0600; the scratch dir
    // is the only place it ever exists, and it must be gone either way.
    const left = [...Deno.readDirSync(scratchRoot)];
    assertEquals(left, []);
  } finally {
    await Deno.remove(scratchRoot, { recursive: true });
    await repo.cleanup();
  }
});

test("readRemoteFiles cleans up even when the read throws", async () => {
  const scratchRoot = await Deno.makeTempDir({ prefix: "tp-scratch-root-" });
  try {
    await assertRejects(() =>
      readRemoteFiles({
        cloneUrl: `${scratchRoot}/nope`,
        ref: "main",
        paths: ["x"],
        maxBytesPerFile: 1024,
        credential: "ghp_exampletoken",
        credentialKind: "token",
      }, scratchRoot)
    );
    assertEquals([...Deno.readDirSync(scratchRoot)], []);
  } finally {
    await Deno.remove(scratchRoot, { recursive: true });
  }
});

test("resolveDefaultBranch reports the remote's HEAD branch", async () => {
  const repo = await makeRepo();
  try {
    const result = await resolveDefaultBranch(repo.path);
    assertEquals(result.defaultBranch, "main");
  } finally {
    await repo.cleanup();
  }
});

test('resolveDefaultBranch is not hardcoded to "main"', async () => {
  const path = await Deno.makeTempDir({ prefix: "tp-repo-fixture-" });
  try {
    await git(["init", "-q", "-b", "trunk"], path);
    await git(["config", "user.email", "t@example.com"], path);
    await git(["config", "user.name", "T"], path);
    await Deno.writeTextFile(`${path}/README.md`, "hello\n");
    await git(["add", "-A"], path);
    await git(["commit", "-qm", "init"], path);

    const result = await resolveDefaultBranch(path);
    assertEquals(result.defaultBranch, "trunk");
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

test("resolveDefaultBranch fails loudly on an unreachable remote", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await assertRejects(() => resolveDefaultBranch(`${dir}/does-not-exist`));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("resolveDefaultBranch leaves no scratch directory behind", async () => {
  const repo = await makeRepo();
  const scratchRoot = await Deno.makeTempDir({ prefix: "tp-scratch-root-" });
  try {
    await resolveDefaultBranch(repo.path, scratchRoot);
    assertEquals([...Deno.readDirSync(scratchRoot)], []);
  } finally {
    await Deno.remove(scratchRoot, { recursive: true });
    await repo.cleanup();
  }
});

test("isSafeRepoPath rejects empty, oversized, and escape-prone paths", () => {
  assertEquals(_internal.isSafeRepoPath(""), false);
  assertEquals(_internal.isSafeRepoPath("a".repeat(201)), false);
  assertEquals(_internal.isSafeRepoPath("\\windows"), false);
  assertEquals(_internal.isSafeRepoPath("foo\0bar"), false);
  assertEquals(_internal.isSafeRepoPath("foo bar"), false);
  assertEquals(_internal.isSafeRepoPath("docker-compose.yml"), true);
  assertEquals(_internal.isSafeRepoPath("public/index.html"), true);
});

test("readRemoteFiles lists a nested directory and ignores an unsafe listPath", async () => {
  const repo = await makeRepo();
  try {
    const nested = await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      paths: [],
      listPath: "public",
      maxBytesPerFile: 256 * 1024,
    });
    assertEquals(
      nested.entries.some((entry) => entry.path === "public/index.html"),
      true,
    );

    const unsafe = await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      paths: [],
      listPath: "../etc",
      maxBytesPerFile: 256 * 1024,
    });
    assertEquals(unsafe.entries, []);
  } finally {
    await repo.cleanup();
  }
});

test("resolveDefaultBranch returns null when HEAD is not a branch", async () => {
  const path = await Deno.makeTempDir({ prefix: "tp-repo-detached-" });
  try {
    await git(["init", "-q", "-b", "main"], path);
    await git(["config", "user.email", "t@example.com"], path);
    await git(["config", "user.name", "T"], path);
    await Deno.writeTextFile(`${path}/README.md`, "hello\n");
    await git(["add", "-A"], path);
    await git(["commit", "-qm", "init"], path);
    await git(["checkout", "--detach", "HEAD"], path);
    await git(["branch", "-D", "main"], path);

    const result = await resolveDefaultBranch(path);
    assertEquals(result.defaultBranch, null);
  } finally {
    await Deno.remove(path, { recursive: true });
  }
});

test("readRemoteFiles lists an empty tree when ls-tree cannot read the path", async () => {
  const repo = await makeRepo();
  try {
    const result = await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      paths: [],
      listPath: "README.md",
      maxBytesPerFile: 256 * 1024,
    });
    assertEquals(result.entries, []);
  } finally {
    await repo.cleanup();
  }
});

test("readRemoteFiles treats a git spawn throw as a failed command", async () => {
  const original = Deno.Command;
  Deno.Command = class {
    output() {
      return Promise.reject(new TypeError("git exec failed"));
    }
  } as unknown as typeof Deno.Command;
  try {
    await assertRejects(
      () =>
        readRemoteFiles({
          cloneUrl: "https://example.com/o/r.git",
          ref: "main",
          paths: ["README.md"],
          maxBytesPerFile: 256 * 1024,
        }),
      Error,
    );
  } finally {
    Deno.Command = original;
  }
});

test("readRemoteFiles stringifies a non-Error git spawn throw", async () => {
  const original = Deno.Command;
  Deno.Command = class {
    output() {
      return Promise.reject("git exploded");
    }
  } as unknown as typeof Deno.Command;
  try {
    await assertRejects(
      () =>
        readRemoteFiles({
          cloneUrl: "https://example.com/o/r.git",
          ref: "main",
          paths: ["README.md"],
          maxBytesPerFile: 256 * 1024,
        }),
      Error,
    );
  } finally {
    Deno.Command = original;
  }
});

test("readRemoteFiles fails when git init is denied", async () => {
  const original = Deno.Command;
  Deno.Command = class {
    output() {
      return Promise.resolve({
        code: 1,
        success: false,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode("cannot init"),
        signal: null,
      });
    }
  } as unknown as typeof Deno.Command;
  try {
    await assertRejects(
      () =>
        readRemoteFiles({
          cloneUrl: "https://example.com/o/r.git",
          ref: "main",
          paths: ["README.md"],
          maxBytesPerFile: 256 * 1024,
        }),
      Error,
      "cannot init",
    );
  } finally {
    Deno.Command = original;
  }
});

test("readRemoteFiles fails when git remote add is denied", async () => {
  const original = Deno.Command;
  let calls = 0;
  Deno.Command = class {
    output() {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve({
          code: 0,
          success: true,
          stdout: new Uint8Array(),
          stderr: new Uint8Array(),
          signal: null,
        });
      }
      return Promise.resolve({
        code: 1,
        success: false,
        stdout: new Uint8Array(),
        stderr: new TextEncoder().encode("cannot add remote"),
        signal: null,
      });
    }
  } as unknown as typeof Deno.Command;
  try {
    await assertRejects(
      () =>
        readRemoteFiles({
          cloneUrl: "https://example.com/o/r.git",
          ref: "main",
          paths: ["README.md"],
          maxBytesPerFile: 256 * 1024,
        }),
      Error,
      "cannot add remote",
    );
  } finally {
    Deno.Command = original;
  }
});

test("readRemoteFiles swallows scratch cleanup errors", async () => {
  const repo = await makeRepo();
  const originalRemove = Deno.remove;
  Deno.remove = () => Promise.reject(new TypeError("busy"));
  try {
    const result = await readRemoteFiles({
      cloneUrl: repo.path,
      ref: "main",
      paths: ["README.md"],
      credential: "ghp_exampletoken",
      credentialKind: "token",
      maxBytesPerFile: 256 * 1024,
    });
    assertEquals(result.files[0]?.found, true);
  } finally {
    Deno.remove = originalRemove;
    await repo.cleanup();
  }
});
