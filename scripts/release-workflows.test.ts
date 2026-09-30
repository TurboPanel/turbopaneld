/**
 * Shape rules for the release workflows since versions come from git tags
 * (Road to 0.2.x, versioning Phase 3): no workflow opens a "Start x.y.z" PR or
 * gates on a minor, no release step reads deno.json's version, and the one
 * deliberate act, starting a minor or major, is the "Start Next Version"
 * workflow.
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

function workflowFiles(): string[] {
  return [...Deno.readDirSync(WORKFLOWS)]
    .filter((entry) => entry.isFile && entry.name.endsWith(".yml"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

test("no workflow opens a Start PR or gates on a minor", () => {
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
  const stamp = text.indexOf("- name: Stamp the version into deno.json");
  const compile = text.indexOf("- name: Compile native binary");
  assert(version > 0 && version < stamp && stamp < compile);
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
  // A manual run (Start Next Version's rebuild) only ever builds trunk.
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
      "TurboPanel/turbopaneld:publish-daemon-trunk.yml",
      "TurboPanel/turbopanel:build.yml",
      "TurboPanel/ui:verify.yml",
      "TurboPanel/website:promote-prs.yml",
    ]
  ) {
    assert(call.includes(spec), `start-version.sh is not given ${spec}`);
  }
});

test("the release workflows pin one TurboPanel/dev commit", () => {
  const pins = new Set<string>();
  for (
    const file of [
      "publish-daemon-trunk.yml",
      "publish-rc.yml",
      "publish-release.yml",
      "promote-prs.yml",
      "promote-ok.yml",
      "start-next-version.yml",
    ]
  ) {
    const text = read(file);
    for (
      const m of text.matchAll(
        /TurboPanel\/dev\/\.github\/(?:workflows\/[\w.-]+|actions\/version)@([0-9a-f]{40})/g,
      )
    ) {
      pins.add(m[1]);
    }
    for (
      const m of text.matchAll(/^ +(?:dev-)?ref: ([0-9a-f]{40})(?: #.*)?$/gm)
    ) {
      pins.add(m[1]);
    }
  }
  assertEquals(pins.size, 1, `pins: ${[...pins].join(", ")}`);
});
