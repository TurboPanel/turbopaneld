/**
 * Keeps `deno test` runs out of a real daemon's config and state roots.
 *
 * A control plane test run once replaced a dev box's real license files and
 * `server.id` and took the co-located daemon offline. The daemon writes the
 * same kind of files (`server.id`, the server key and its id, the sealing
 * key, the CA pin, `trust-level`) through
 * `writeDaemonFile` / `removeDaemonFile`, so those call
 * {@link assertTestRunMayWrite} first: in a `deno test` run a path that is not
 * inside a temp root (`/tmp`, `/var/tmp` or `TMPDIR`), as written and again with
 * symlinks resolved, throws before any I/O. A production daemon is never a
 * test run and passes straight through.
 */

const TEST_MODULE_PATTERN = /[._]test\.(?:ts|tsx|mts|js|mjs)$/;

/**
 * True when this process is a `deno test` run: the main module is a test file.
 * The compiled daemon and `main.ts` never match.
 */
export function isDenoTestRun(
  mainModule: string | undefined = denoMainModule(),
): boolean {
  return typeof mainModule === "string" && TEST_MODULE_PATTERN.test(mainModule);
}

function denoMainModule(): string | undefined {
  try {
    return Deno.mainModule;
  } catch {
    return undefined;
  }
}

function stripTrailingSlash(path: string): string {
  let end = path.length;
  while (end > 1 && path.codePointAt(end - 1) === 47) end--;
  return path.slice(0, end);
}

/** True when `path` is strictly inside `root`, with no `.` or `..` segment. */
export function isStrictlyInside(path: string, root: string): boolean {
  const normalizedRoot = stripTrailingSlash(root);
  const normalizedPath = stripTrailingSlash(path);
  if (!normalizedPath.startsWith(`${normalizedRoot}/`)) return false;
  return normalizedPath
    .slice(normalizedRoot.length + 1)
    .split("/")
    .every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

/** `/tmp`, `/var/tmp`, and `TMPDIR` when it is set and readable. */
function tempRoots(): string[] {
  const roots = ["/tmp", "/var/tmp"];
  try {
    const tmpdir = Deno.env.get("TMPDIR")?.trim();
    if (tmpdir?.startsWith("/") && tmpdir !== "/") roots.push(tmpdir);
  } catch {
    // No env grant for this test: the fixed roots still apply.
  }
  return roots;
}

/** The deepest existing path at or above `path` (by `lstat`, so a dangling link counts). */
function deepestExisting(path: string): string {
  let current = stripTrailingSlash(path);
  for (;;) {
    try {
      Deno.lstatSync(current);
      return current;
    } catch (err) {
      if (!(err instanceof Deno.errors.NotFound) || current === "/") throw err;
    }
    const cut = current.lastIndexOf("/");
    current = cut <= 0 ? "/" : current.slice(0, cut);
  }
}

/**
 * True when `path`, with every symlink resolved, still sits in `root`. A link
 * in `/tmp` that points at a real state dir resolves outside and is refused,
 * and so is a dangling one.
 */
function resolvesInside(path: string, root: string): boolean {
  try {
    const realRoot = Deno.realPathSync(root);
    const resolved = Deno.realPathSync(deepestExisting(path));
    return resolved === realRoot || isStrictlyInside(resolved, realRoot);
  } catch {
    return false;
  }
}

/**
 * Throw when a test run is about to write or remove `path` outside a temp
 * root. Production runs pass through untouched.
 */
export function assertTestRunMayWrite(
  path: string,
  opts: { testRun?: boolean; roots?: string[] } = {},
): void {
  if (!(opts.testRun ?? isDenoTestRun())) return;
  const roots = opts.roots ?? tempRoots();
  if (
    roots.some((root) =>
      isStrictlyInside(path, root) && resolvesInside(path, root)
    )
  ) {
    return;
  }
  throw new Error(
    `refusing to write ${path} from a test run: daemon files in tests go under a temp dir (createTempLayout)`,
  );
}
