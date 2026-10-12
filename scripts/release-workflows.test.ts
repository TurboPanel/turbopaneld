/**
 * Shape rules for the release workflows: the tags work out the version
 * (Road to 0.2.x, versioning Phase 3), no workflow gates on a minor, no release
 * step reads its version from deno.json, the trunk build refuses a canary
 * whose committed version fields disagree with the tags, a release opens the
 * "chore: start <next patch>" PR, and starting a minor or major is the
 * "Start Next Version" workflow (which opens the same kind of PR).
 */
import { assert, assertEquals, assertMatch } from "@std/assert";
import { fromFileUrl, join } from "@std/path";

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

function read(name: string): string {
  return Deno.readTextFileSync(join(WORKFLOWS, name));
}

/**
 * The text of every `run:` step in a workflow file (single-line and block
 * scalars), found by indentation so no YAML parser is needed.
 */
function runBodies(source: string): string[] {
  const lines = source.split("\n");
  const bodies: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)(?:- )?run:\s*(.*)$/.exec(lines[i]);
    if (!match) continue;
    const indent = match[1].length;
    if (!/^[|>][+-]?$/.test(match[2].trim())) {
      bodies.push(match[2]);
      continue;
    }
    const body: string[] = [];
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (
        line.trim() !== "" && line.length - line.trimStart().length <= indent
      ) break;
      body.push(line);
    }
    bodies.push(body.join("\n"));
  }
  return bodies;
}

/** Values an outsider can shape (a tag name, a dispatch input, a job output built from one). */
const SHELL_UNSAFE =
  /\$\{\{\s*(inputs\.|github\.ref_name|github\.head_ref|needs\.[\w-]+\.outputs\.)/;

function workflowFiles(): string[] {
  return [...Deno.readDirSync(WORKFLOWS)]
    .filter((entry) => entry.isFile && entry.name.endsWith(".yml"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

test("no workflow opens an old-style Start PR or gates on a minor", () => {
  const files = workflowFiles();
  assert(files.length > 0);
  for (const file of files) {
    const text = read(file);
    for (
      const gone of [
        /gh-next-version/,
        /gh-minor-gate|minor-gate/,
        /start-minor/,
        /--label minor/,
        /--title "Start /,
      ]
    ) {
      assert(!gone.test(text), `${file} still matches ${gone}`);
    }
  }
});

test("no release step reads the version from deno.json", () => {
  for (
    const file of [
      "publish-daemon-trunk.yml",
      "publish-rc.yml",
      "publish-release.yml",
      "promote-prs.yml",
      "promote-ok.yml",
      "promote-ok-recheck.yml",
    ]
  ) {
    const text = read(file);
    assert(!/contents\/deno\.json/.test(text), `${file} reads deno.json`);
    assert(!/version-file:/.test(text), `${file} passes a version file`);
    assert(
      !/json\.load\(open\("deno\.json"\)\)\["version"\]\)'\)"/.test(text),
      `${file} takes its version from deno.json`,
    );
  }
});

test("the trunk build stamps the tag-derived base into deno.json before compiling", () => {
  const text = read("publish-daemon-trunk.yml");
  const version = text.indexOf(
    "- name: Work out this build's version from the tags",
  );
  const check = text.indexOf(
    "- name: Check the committed version matches the tags",
  );
  const stamp = text.indexOf("- name: Stamp the version into deno.json");
  const compile = text.indexOf("- name: Compile native binary");
  assert(version > 0 && version < check && check < stamp && stamp < compile);
  assertMatch(
    text,
    /BASE_VERSION: \$\{\{ steps\.version\.outputs\.base \}\}\n {8}run: node scripts\/set-version\.mjs --check "\$BASE_VERSION"\n/,
  );
  assertMatch(
    text,
    /uses: TurboPanel\/dev\/\.github\/actions\/version@[0-9a-f]{40} # dev#\d+\n {8}with:\n {10}mode: canary\n/,
  );
  assertMatch(text, /BASE_VERSION: \$\{\{ steps\.version\.outputs\.base \}\}/);
  assertMatch(
    text,
    /CANARY_VERSION: \$\{\{ steps\.version\.outputs\.version \}\}/,
  );
  assert(
    !text.includes("GITHUB_RUN_NUMBER"),
    "the canary counter is not the run number",
  );
  // A manual run only ever builds trunk.
  assertMatch(text, /^ {2}workflow_dispatch:$/m);
  assertMatch(
    text,
    /^ {2}verify:\n {4}if: github\.ref == 'refs\/heads\/trunk'$/m,
  );
});

test("Start Next Version is a manual minor|major button over the four repos", () => {
  const text = read("start-next-version.yml");
  assertMatch(text, /^name: Start Next Version$/m);
  assertMatch(text, /^on:\n {2}workflow_dispatch:\n/m);
  assert(!/^ {2}(push|pull_request|schedule|workflow_run):/m.test(text));
  assertMatch(
    text,
    /^ {6}bump:\n(?: {8}.*\n)*? {8}type: choice\n {8}options:\n {10}- minor\n {10}- major\n/m,
  );
  assertMatch(text, /^ {6}dry-run:\n(?: {8}.*\n)*? {8}type: boolean\n/m);
  assertMatch(text, /^permissions:\n {2}contents: read\n\n/m);
  assertMatch(
    text,
    /repositories: \|\n {12}turbopaneld\n {12}turbopanel\n {12}ui\n {12}website\n/,
  );
  const call = text.slice(text.indexOf("start-version.sh"));
  for (
    const spec of [
      "TurboPanel/turbopaneld",
      "TurboPanel/turbopanel",
      "TurboPanel/ui",
      "TurboPanel/website",
    ]
  ) {
    assert(call.includes(spec), `start-version.sh is not given ${spec}`);
  }
});

const RELEASE_WORKFLOWS = [
  "publish-daemon-trunk.yml",
  "publish-rc.yml",
  "publish-release.yml",
  "promote-prs.yml",
  "promote-ok.yml",
  "start-next-version.yml",
];

/**
 * The TurboPanel/dev shas pinned across the release workflows, split in two:
 * the reusable promote workflows (`.github/workflows/gh-*.yml` and the
 * `dev-ref:` they are handed), and the scripts (the composite actions and the
 * checkouts of `scripts/promote`). Each group must be one sha; the groups may
 * differ because a reusable workflow's inputs and secrets can change between
 * dev commits, while the scripts only add steps.
 */
function devPins(): { workflows: Set<string>; scripts: Set<string> } {
  const workflows = new Set<string>();
  const scripts = new Set<string>();
  for (const file of RELEASE_WORKFLOWS) {
    const text = read(file);
    for (
      const m of text.matchAll(
        /TurboPanel\/dev\/\.github\/workflows\/[\w.-]+@([0-9a-f]{40})/g,
      )
    ) workflows.add(m[1]);
    for (const m of text.matchAll(/^ +dev-ref: ([0-9a-f]{40})(?: #.*)?$/gm)) {
      workflows.add(m[1]);
    }
    for (
      const m of text.matchAll(
        /TurboPanel\/dev\/\.github\/actions\/[\w-]+@([0-9a-f]{40})/g,
      )
    ) scripts.add(m[1]);
    for (const m of text.matchAll(/^ +ref: ([0-9a-f]{40})(?: #.*)?$/gm)) {
      scripts.add(m[1]);
    }
  }
  return { workflows, scripts };
}

test("the release workflows pin one TurboPanel/dev commit per kind", () => {
  const { workflows, scripts } = devPins();
  assertEquals(
    workflows.size,
    1,
    `workflow pins: ${[...workflows].join(", ")}`,
  );
  assertEquals(scripts.size, 1, `script pins: ${[...scripts].join(", ")}`);
});

test("a release opens the next patch's version PR after it is finalized", () => {
  const text = read("publish-release.yml");
  const job = text.slice(text.indexOf("\n  start-next:\n"));
  assert(job.length > 1, "publish-release.yml has no start-next job");
  assertMatch(job, /^ {4}needs: \[prepare, finalize\]$/m);
  assertMatch(job, /^ {4}permissions:\n {6}contents: read\n {4}steps:/m);
  assertMatch(
    job,
    /uses: actions\/create-github-app-token@[0-9a-f]{40} # v[\d.]+\n(?: {8}.*\n)*? {10}repositories: turbopaneld\n/,
  );
  const base = job.indexOf("mode: base");
  const guard = job.indexOf('[ "$NEWEST" != "$RELEASED" ]');
  const pr = job.indexOf("TurboPanel/dev/.github/actions/start-version-pr@");
  assert(
    base > 0 && base < guard && guard < pr,
    "base, then the check, then the PR",
  );
  assertMatch(job, /version: \$\{\{ steps\.next\.outputs\.base \}\}/);
  assertMatch(
    job,
    /reason: It was opened after v\$\{\{ needs\.prepare\.outputs\.version \}\} was released\./,
  );
  assertMatch(job, /^ {10}auto-merge: "true"$/m);
  assertMatch(text, /^permissions:\n {2}contents: read\n/m);
});

test("no run: step splices an input, the ref name or a job output into the shell", () => {
  for (const file of workflowFiles()) {
    for (const body of runBodies(read(file))) {
      assertEquals(
        SHELL_UNSAFE.test(body),
        false,
        `${file}: pass it through env: instead`,
      );
    }
  }
});
