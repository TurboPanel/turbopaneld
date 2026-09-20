import { assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const here = dirname(fromFileUrl(import.meta.url));
const runShPath = join(here, "../../scripts/run.sh");

function extractShellFunction(source: string, name: string): string {
  const needle = `${name}() {`;
  const start = source.indexOf(needle);
  if (start < 0) {
    throw new TypeError(`missing ${name} in run.sh`);
  }
  const brace = source.indexOf("{", start);
  let depth = 0;
  for (let i = brace; i < source.length; i++) {
    const ch = source[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, i + 1);
      }
    }
  }
  throw new TypeError(`unclosed ${name} in run.sh`);
}

async function evalHelper(
  helper: string,
  body: string,
): Promise<{ stdout: string; status: number }> {
  const script = `${helper}\n${body}\n`;
  const proc = new Deno.Command("sh", {
    args: ["-eu", "-c", script],
    stdout: "piped",
    stderr: "piped",
  });
  const out = await proc.output();
  return {
    stdout: new TextDecoder().decode(out.stdout),
    status: out.code,
  };
}

async function welcomeHelpers(): Promise<string> {
  const source = await Deno.readTextFile(runShPath);
  return [
    extractShellFunction(source, "tp_print_styled_line"),
    extractShellFunction(source, "tp_print_nonstable_channel_warning"),
    extractShellFunction(source, "tp_print_instance_welcome"),
  ].join("\n");
}

const stubs = [
  "tp_is_interactive() { return 1; }",
].join("\n");

const shPermissions = { read: true, run: true } as const;

test({
  name:
    "instance welcome names the installer, version, and license path on canary",
  permissions: shPermissions,
  fn: async () => {
    const result = await evalHelper(
      await welcomeHelpers(),
      [
        stubs,
        "tp_peek_instance_version() { printf '%s' '0.1.1-canary.20260919-143000-a1b2c3d'; }",
        "TURBOPANEL_UPDATE_CHANNEL=canary",
        "tp_print_instance_welcome",
      ].join("\n"),
    );
    assertEquals(result.status, 0, result.stdout);
    assertStringIncludes(
      result.stdout,
      "TurboPanel  ·  Self-Hosted Instance Installer / Updater",
    );
    assertStringIncludes(
      result.stdout,
      "v0.1.1-canary.20260919-143000-a1b2c3d",
    );
    assertStringIncludes(
      result.stdout,
      "This installs the full TurboPanel control plane on this host.",
    );
    assertStringIncludes(
      result.stdout,
      "copy the install command from Servers",
    );
    assertStringIncludes(
      result.stdout,
      "WARNING: PRE-RELEASE UPDATE CHANNEL (CANARY)",
    );
    assertStringIncludes(
      result.stdout,
      "Canary follows every green trunk merge. It is not a supported",
    );
    assertStringIncludes(
      result.stdout,
      "Supported release:  curl -fsSL turbopanel.sh | sh",
    );
  },
});

test({
  name: "instance welcome on release has no pre-release warning",
  permissions: shPermissions,
  fn: async () => {
    const result = await evalHelper(
      await welcomeHelpers(),
      [
        stubs,
        "tp_peek_instance_version() { printf '%s' '0.1.1'; }",
        "TURBOPANEL_UPDATE_CHANNEL=release",
        "tp_print_instance_welcome",
      ].join("\n"),
    );
    assertEquals(result.status, 0, result.stdout);
    assertStringIncludes(result.stdout, "v0.1.1");
    assertEquals(result.stdout.includes("WARNING"), false);
    assertEquals(result.stdout.includes("PRE-RELEASE"), false);
    assertEquals(result.stdout.includes("Supported release:"), false);
  },
});

test({
  name: "instance welcome on rc warns that it is a release candidate",
  permissions: shPermissions,
  fn: async () => {
    const result = await evalHelper(
      await welcomeHelpers(),
      [
        stubs,
        "tp_peek_instance_version() { printf '%s' '0.1.1-rc.1'; }",
        "TURBOPANEL_UPDATE_CHANNEL=rc",
        "tp_print_instance_welcome",
      ].join("\n"),
    );
    assertEquals(result.status, 0, result.stdout);
    assertStringIncludes(
      result.stdout,
      "WARNING: PRE-RELEASE UPDATE CHANNEL (RC)",
    );
    assertStringIncludes(
      result.stdout,
      "This is a release candidate, not a supported release. It may still",
    );
  },
});

test({
  name:
    "instance welcome falls back to the channel name when the version peek fails",
  permissions: shPermissions,
  fn: async () => {
    const result = await evalHelper(
      await welcomeHelpers(),
      [
        stubs,
        "tp_peek_instance_version() { return 1; }",
        "TURBOPANEL_UPDATE_CHANNEL=canary",
        "tp_print_instance_welcome",
      ].join("\n"),
    );
    assertEquals(result.status, 0, result.stdout);
    assertStringIncludes(result.stdout, "channel canary");
    assertEquals(result.stdout.includes("v0."), false);
  },
});

test({
  name: "run.sh no longer offers the control-plane vs daemon choice menu",
  permissions: { read: true },
  fn: async () => {
    const source = await Deno.readTextFile(runShPath);
    assertEquals(source.includes("Choice [1]:"), false);
    assertEquals(source.includes("Enrol this host as a daemon instead"), false);
    assertEquals(source.includes("No license given"), false);
  },
});
