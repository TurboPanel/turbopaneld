import { assert, assertEquals } from "@std/assert";
import { join, relative } from "@std/path";
import { DAEMON_ROOT } from "./assets.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * Every systemd unit template Ansible installs, rendered the way Ansible
 * renders it, across the values its conditions branch on.
 *
 * `ansible.builtin.template` runs Jinja2 with `trim_blocks=True`, so a block
 * tag ending a directive line eats that line's newline and glues the next
 * directive onto it. turbopaneld.service shipped that way (After=, Wants= and
 * OnFailure= on one line) and the update-guard rollback never fired; this
 * suite checks every unit template, not just the one that broke.
 */
const ORCHESTRATION = join(DAEMON_ROOT, "orchestration");
const UNIT_TEMPLATE = /\.(service|timer|slice|socket|path|mount)\.j2$/;

async function* unitTemplates(dir: string): AsyncGenerator<string> {
  for await (const entry of Deno.readDir(dir)) {
    const path = join(dir, entry.name);
    if (entry.isDirectory) yield* unitTemplates(path);
    else if (UNIT_TEMPLATE.test(entry.name)) yield path;
  }
}

const TEMPLATES = await (async () => {
  const found: string[] = [];
  for await (const path of unitTemplates(ORCHESTRATION)) found.push(path);
  return found.sort((a, b) => a.localeCompare(b));
})();

/**
 * Renders each template once per variant: every variable a placeholder
 * path, every variable empty, and then one variable at a time switched to
 * each value the template compares it with (and to empty and "true"), so
 * every `{% if %}` arm is taken at least once. Ansible's environment:
 * trim_blocks on, lstrip_blocks off, and its `bool` / `dirname` filters.
 */
const RENDER_PY = String.raw`
import json, os, re, sys
import jinja2
from jinja2 import meta

def to_bool(value):
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in ("yes", "on", "1", "true", "y", "t")

env = jinja2.Environment(
    trim_blocks=True,
    lstrip_blocks=False,
    keep_trailing_newline=True,
    undefined=jinja2.StrictUndefined,
)
env.filters["bool"] = to_bool
env.filters["dirname"] = os.path.dirname
env.filters["basename"] = os.path.basename
env.filters["quote"] = lambda s: "'" + str(s).replace("'", "'\"'\"'") + "'"

out = {}
for path in json.load(sys.stdin):
    source = open(path).read()
    names = sorted(meta.find_undeclared_variables(env.parse(source)))
    template = env.from_string(source)
    compared = {}
    for name, value in re.findall(
        r"(\w+)(?:\s*\|\s*default\([^)]*\))?\s*\)?\s*[!=]=\s*'([^']*)'", source
    ):
        compared.setdefault(name, set()).add(value)
    base = {name: "/placeholder/" + name for name in names}
    variants = [("placeholders", base), ("all empty", {n: "" for n in names})]
    for name in names:
        for value in sorted(compared.get(name, set()) | {"", "true"}):
            variants.append((name + "=" + json.dumps(value), {**base, name: value}))
        if re.search(r"\b" + name + r"\s+is\s+(not\s+)?defined", source):
            variants.append((name + " undefined", {k: v for k, v in base.items() if k != name}))
    rendered = []
    for label, values in variants:
        try:
            rendered.append({"variant": label, "text": template.render(**values)})
        except jinja2.UndefinedError as err:
            rendered.append({"variant": label, "error": str(err)})
    out[path] = rendered
json.dump(out, sys.stdout)
`;

async function hasJinja(python: string): Promise<boolean> {
  try {
    const { success } = await new Deno.Command(python, {
      args: ["-c", "import jinja2"],
      stdout: "null",
      stderr: "null",
    }).output();
    return success;
  } catch {
    return false;
  }
}

/** A Python with Jinja2: the vendored Ansible's, or CI's pip-installed toolchain. */
async function findJinjaPython(): Promise<string | undefined> {
  const candidates = [
    Deno.env.get("TURBOPANEL_JINJA_PYTHON"),
    "/opt/turbopanel/vendor/ansible/current/bin/python3",
    "python3",
    "python",
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  for (const candidate of candidates) {
    if (await hasJinja(candidate)) return candidate;
  }
  return undefined;
}

const JINJA_PYTHON = await findJinjaPython();
// CI installs the Ansible toolchain (and with it Jinja2) before the tests run.
const RENDER_REQUIRED = Deno.env.get("CI") === "true";

type Rendered = { variant: string; text?: string; error?: string };

async function renderAll(
  templates: string[],
): Promise<Record<string, Rendered[]>> {
  assert(JINJA_PYTHON, "no Python with jinja2 found to render the units");
  const child = new Deno.Command(JINJA_PYTHON, {
    args: ["-c", RENDER_PY],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const writer = child.stdin.getWriter();
  await writer.write(new TextEncoder().encode(JSON.stringify(templates)));
  await writer.close();
  const { success, stdout, stderr } = await child.output();
  assert(success, `render failed: ${new TextDecoder().decode(stderr)}`);
  return JSON.parse(new TextDecoder().decode(stdout));
}

const SECTIONS = new Set([
  "Unit",
  "Service",
  "Timer",
  "Socket",
  "Path",
  "Mount",
  "Slice",
  "Install",
]);

/**
 * Problems with one rendered unit: every non-blank, non-comment line must be
 * a known `[Section]` or a `Key=Value` inside one, and no value may carry a
 * second directive from `directives` straight after a word (two directives
 * glued onto one line). Option names inside a value (`-o IdentitiesOnly=yes`)
 * are not systemd directives, so they pass.
 */
function unitProblems(
  text: string,
  directives: ReadonlySet<string>,
): string[] {
  const problems: string[] = [];
  let section: string | undefined;
  let continued = false;
  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trimEnd();
    const where = `line ${index + 1}`;
    const continues = line.endsWith("\\");
    if (continued) {
      continued = continues;
      continue;
    }
    continued = continues;
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    const header = /^\[([A-Za-z]+)\]$/.exec(line);
    if (header) {
      section = header[1];
      if (!SECTIONS.has(section)) {
        problems.push(`${where}: unknown [${section}]`);
      }
      continue;
    }
    const pair = /^([A-Z][A-Za-z0-9]*)=(.*)$/.exec(line);
    if (!pair) {
      problems.push(`${where} is not Key=Value: ${JSON.stringify(line)}`);
      continue;
    }
    if (section === undefined) problems.push(`${where} precedes any [Section]`);
    const glued = [...pair[2].matchAll(/[a-z0-9.)\]]([A-Z][A-Za-z0-9]*)=/g)]
      .some((match) => directives.has(match[1]));
    if (glued) {
      problems.push(
        `${where}: ${pair[1]}= swallowed another directive: ${
          JSON.stringify(line)
        }`,
      );
    }
  }
  if (continued) problems.push("ends inside a line continuation");
  return problems;
}

/** Directives a glue would most often hide, whether or not a unit sets them. */
const COMMON_DIRECTIVES = [
  "After",
  "Before",
  "Wants",
  "Requires",
  "BindsTo",
  "PartOf",
  "Conflicts",
  "OnFailure",
  "Description",
  "Type",
  "User",
  "Group",
  "ExecStart",
  "ExecStartPre",
  "ExecStop",
  "ExecReload",
  "Restart",
  "RestartSec",
  "Environment",
  "EnvironmentFile",
  "WorkingDirectory",
  "WantedBy",
  "RequiredBy",
  "Unit",
  "OnCalendar",
  "Persistent",
];

/** Every directive any rendered unit sets on a line of its own. */
function directiveNames(texts: Iterable<string>): Set<string> {
  const names = new Set<string>(COMMON_DIRECTIVES);
  for (const text of texts) {
    for (const match of text.matchAll(/^([A-Z][A-Za-z0-9]*)=/gm)) {
      names.add(match[1]);
    }
  }
  return names;
}

const SAMPLE_DIRECTIVES = new Set(["After", "Wants", "OnFailure", "WantedBy"]);

test("the unit parser flags glued directives, stray lines and unknown sections", () => {
  const unitProblemsOf = (text: string) =>
    unitProblems(text, SAMPLE_DIRECTIVES);
  assertEquals(
    unitProblemsOf(
      "[Unit]\nAfter=a.target\nWants=a.target\n[Install]\nWantedBy=x\n",
    ),
    [],
  );
  assertEquals(
    unitProblemsOf(
      "[Unit]\nAfter=network-online.targetWants=network-online.target\n",
    ),
    [
      'line 2: After= swallowed another directive: "After=network-online.targetWants=network-online.target"',
    ],
  );
  assertEquals(unitProblemsOf("After=x\n"), ["line 1 precedes any [Section]"]);
  assertEquals(unitProblemsOf("[Serivce]\n"), ["line 1: unknown [Serivce]"]);
  assertEquals(unitProblemsOf("[Service]\n{{ x }}\n"), [
    'line 2 is not Key=Value: "{{ x }}"',
  ]);
  assertEquals(
    unitProblemsOf("[Service]\nExecStart=/bin/sh -c \\\n  'echo A=b'\n"),
    [],
  );
  assertEquals(
    unitProblemsOf(
      '[Service]\nEnvironment="GIT_SSH_COMMAND=ssh -o IdentitiesOnly=yes"\n',
    ),
    [],
  );
  assertEquals(unitProblemsOf("[Service]\nExecStart=/x \\"), [
    "ends inside a line continuation",
  ]);
});

test("every systemd unit template in orchestration is found", () => {
  assert(TEMPLATES.length >= 20, `only ${TEMPLATES.length} unit templates`);
  const names = TEMPLATES.map((path) => path.split("/").at(-1));
  assert(names.includes("turbopaneld.service.j2"));
  assert(names.includes("turbopanel-instance.service.j2"));
});

test({
  name: "a Python with jinja2 is available where unit templates must render",
  ignore: !RENDER_REQUIRED,
  fn: () => {
    assert(JINJA_PYTHON, "CI must provide jinja2 for the unit template tests");
  },
});

test({
  name:
    "every unit template renders one directive per line in every branch (Ansible trim_blocks)",
  ignore: !JINJA_PYTHON,
  fn: async () => {
    const rendered = await renderAll(TEMPLATES);
    const directives = directiveNames(
      Object.values(rendered).flat().flatMap((variant) => variant.text ?? []),
    );
    const failures: string[] = [];
    for (const path of TEMPLATES) {
      const name = relative(ORCHESTRATION, path);
      const variants = rendered[path] ?? [];
      assert(variants.length >= 2, `${name} was not rendered`);
      assert(
        variants.some((variant) => variant.text !== undefined),
        `${name} renders in no variant: ${variants[0]?.error}`,
      );
      for (const variant of variants) {
        if (variant.text === undefined) continue;
        for (const problem of unitProblems(variant.text, directives)) {
          failures.push(`${name} [${variant.variant}] ${problem}`);
        }
      }
    }
    assertEquals(failures, []);
  },
});
