import { assertEquals, assertThrows } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  type ReleaseArtifactKind,
  releaseManifestUrlAllowed,
  resolvePinnedManifestUrl,
} from "./urls.ts";
import {
  assertReleaseManifestUrl,
  rootHelperInstanceUpdateInvocation,
  rootHelperReconcileInvocation,
  UpdatePreflightError,
} from "../instance/run-reconcile.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const ROOT = join(dirname(fromFileUrl(import.meta.url)), "..", "..");
const CORPUS_PATH = join(
  ROOT,
  "src",
  "testing",
  "release-manifest-url-corpus.json",
);
const SHELL_COPIES = [
  join(ROOT, "scripts", "run.sh"),
  join(ROOT, "orchestration", "scripts", "tp-orchestrate"),
];
const FUNCTION = "tp_release_manifest_url_ok";

type Case = { kind: string; url: string; allow: boolean; why: string };

async function loadCorpus(): Promise<Case[]> {
  const raw = JSON.parse(await Deno.readTextFile(CORPUS_PATH)) as {
    cases?: unknown;
  };
  if (!Array.isArray(raw.cases)) throw new TypeError("corpus has no cases");
  return raw.cases as Case[];
}

function extractShellFunction(source: string, path: string): string {
  const start = source.indexOf(`${FUNCTION}() {`);
  if (start < 0) throw new TypeError(`missing ${FUNCTION} in ${path}`);
  const end = source.indexOf("\n}\n", start);
  if (end < 0) throw new TypeError(`unclosed ${FUNCTION} in ${path}`);
  return source.slice(start, end + 2);
}

/** One `sh` process runs every case; stdout is one `1`/`0` per case. */
async function shellVerdicts(fn: string, cases: Case[]): Promise<string> {
  const args = cases.flatMap((c) => [c.kind, c.url]);
  const script = `${fn}
while [ $# -gt 0 ]; do
  if ${FUNCTION} "$1" "$2"; then printf 1; else printf 0; fi
  shift 2
done
`;
  const out = await new Deno.Command("sh", {
    args: ["-c", script, "sh", ...args],
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(out.stderr);
  if (out.code !== 0 || stderr) {
    throw new TypeError(`${FUNCTION} harness failed: ${stderr}`);
  }
  return new TextDecoder().decode(out.stdout);
}

function mismatches(
  cases: Case[],
  verdict: (c: Case, i: number) => boolean,
): string[] {
  return cases.flatMap((c, i) =>
    verdict(c, i) === c.allow ? [] : [
      `${c.allow ? "refused" : "accepted"} ${c.kind} ${
        JSON.stringify(c.url)
      } (${c.why})`,
    ]
  );
}

test("release-manifest URL corpus covers both verdicts for every kind", async () => {
  const cases = await loadCorpus();
  for (const kind of ["daemon", "instance", "ui"]) {
    const ofKind = cases.filter((c) => c.kind === kind);
    assertEquals(ofKind.some((c) => c.allow), true, `${kind} benign`);
    assertEquals(ofKind.some((c) => !c.allow), true, `${kind} hostile`);
  }
});

test("releaseManifestUrlAllowed matches the shared corpus", async () => {
  const cases = await loadCorpus();
  assertEquals(
    mismatches(cases, (c) => releaseManifestUrlAllowed(c.kind, c.url)),
    [],
  );
});

for (const path of SHELL_COPIES) {
  const label = path.slice(ROOT.length + 1);
  test(`${label} ${FUNCTION} matches the shared corpus`, async () => {
    const cases = await loadCorpus();
    const fn = extractShellFunction(await Deno.readTextFile(path), path);
    const verdicts = await shellVerdicts(fn, cases);
    assertEquals(verdicts.length, cases.length);
    assertEquals(mismatches(cases, (_c, i) => verdicts[i] === "1"), []);
  });
}

test(`${FUNCTION} is byte-identical in run.sh and tp-orchestrate`, async () => {
  const [runSh, orchestrate] = await Promise.all(
    SHELL_COPIES.map(async (p) =>
      extractShellFunction(await Deno.readTextFile(p), p)
    ),
  );
  assertEquals(orchestrate, runSh);
});

test("resolvePinnedManifestUrl ignores a pin off its kind's release rail", async () => {
  const env: Record<ReleaseArtifactKind, string> = {
    daemon: "TURBOPANEL_MANIFEST_URL",
    instance: "TURBOPANEL_INSTANCE_MANIFEST_URL",
    ui: "TURBOPANEL_UI_MANIFEST_URL",
  };
  const cases = (await loadCorpus()).filter((c) =>
    c.kind in env && c.url.trim() === c.url && c.url !== ""
  );
  assertEquals(
    mismatches(cases, (c) => {
      const kind = c.kind as ReleaseArtifactKind;
      return resolvePinnedManifestUrl({ [env[kind]]: c.url }, kind) !== null;
    }),
    [],
  );
});

const TRAVERSAL =
  "https://github.com/TurboPanel/turbopanel/releases/download/../../../../attacker/repo/releases/download/v1/manifest.json";

test("assertReleaseManifestUrl refuses with preflight_manifest", () => {
  const err = assertThrows(
    () => assertReleaseManifestUrl("instance", TRAVERSAL, "manifestUrl"),
    UpdatePreflightError,
  );
  assertEquals(err.code, "preflight_manifest");
  assertReleaseManifestUrl(
    "instance",
    "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json",
    "manifestUrl",
  );
});

test("root-helper invocations never carry an off-rail manifest URL", () => {
  assertThrows(
    () =>
      rootHelperReconcileInvocation(["--no-start"], {
        manifestUrl: TRAVERSAL.replace("turbopanel/", "turbopaneld/"),
      }),
    UpdatePreflightError,
  );
  assertThrows(
    () =>
      rootHelperInstanceUpdateInvocation({
        channel: "release",
        manifestUrl: TRAVERSAL,
      }),
    UpdatePreflightError,
  );
  assertThrows(
    () =>
      rootHelperInstanceUpdateInvocation({
        channel: "release",
        uiManifestUrl:
          "https://github.com/TurboPanel/turbopanel/releases/download/v0.1.1/manifest.json",
      }),
    UpdatePreflightError,
  );
  const ok = rootHelperInstanceUpdateInvocation({
    channel: "release",
    manifestUrl:
      "https://github.com/TurboPanel/turbopanel/releases/latest/download/manifest.json",
    uiManifestUrl:
      "https://github.com/TurboPanel/ui/releases/latest/download/manifest.json",
  });
  assertEquals(ok.args.includes("--ui-manifest-url"), true);
});
