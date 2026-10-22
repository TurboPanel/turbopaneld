import { assertEquals, assertStringIncludes } from "@std/assert";
import { join } from "@std/path";
import {
  extractShellFunction,
  RUN_SH_PATH,
} from "../testing/run-sh-manifest-verifier.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

/**
 * What the install script prints while it runs: the runtime's start-up notes
 * about optional tools are left out, details line up, and the last step names
 * the setup wizard address.
 */

const FILTER = ["tp_quiet_runtime_notes", "tp_quiet_runtime_notes_abort"];

const NOTE_NVIDIA =
  "Info Failed to resolve 'nvidia-smi' for allow-run: cannot find binary path";
const NOTE_DOCKER =
  "Info Failed to resolve 'docker' for allow-run: cannot find binary path";

async function shell(
  functions: string[],
  lines: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  const body = functions.map((name) => extractShellFunction(source, name))
    .join("\n");
  const out = await new Deno.Command("sh", {
    args: ["-eu", "-c", `${body}\n${lines.join("\n")}`],
    env,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
}

test("tp_quiet_runtime_notes drops only the optional-tool notes", async () => {
  const res = await shell(FILTER, [
    `tp_noisy() {`,
    `  echo "stdout line"`,
    `  echo "${NOTE_NVIDIA}" >&2`,
    `  echo "a real warning" >&2`,
    `  echo "${NOTE_DOCKER}" >&2`,
    `  echo "Info Failed to resolve something else" >&2`,
    `}`,
    `tp_quiet_runtime_notes tp_noisy`,
  ]);
  assertEquals(res.code, 0);
  assertEquals(res.stdout, "stdout line\n");
  assertEquals(
    res.stderr,
    "a real warning\nInfo Failed to resolve something else\n",
  );
});

test("tp_quiet_runtime_notes passes the exit status through under set -e", async () => {
  const res = await shell(FILTER, [
    `tp_fails() { echo "boom" >&2; return 7; }`,
    `rc=0`,
    `tp_quiet_runtime_notes tp_fails || rc=$?`,
    `echo "rc=$rc"`,
    `tp_quiet_runtime_notes true`,
    `echo "after-true"`,
  ]);
  assertEquals(res.code, 0);
  assertStringIncludes(res.stdout, "rc=7");
  assertStringIncludes(res.stdout, "after-true");
  assertStringIncludes(res.stderr, "boom");
});

test("tp_quiet_runtime_notes does not wait for a process left running, and leaves it unharmed", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-qrn-" });
  try {
    const marker = join(dir, "survived");
    const res = await shell(FILTER, [
      // The leftover process keeps the command's stderr for 5 seconds, then
      // writes a note, a real message and a marker file.
      `tp_leaves_one() {`,
      `  ( sleep 5; echo "${NOTE_NVIDIA}" >&2; echo "late message" >&2; echo ok > "${marker}" ) >/dev/null &`,
      `}`,
      `start=$(date +%s)`,
      `tp_quiet_runtime_notes tp_leaves_one`,
      `end=$(date +%s)`,
      `echo "waited=$((end - start))"`,
      // Outlive the leftover process so its late write has happened.
      `sleep 4`,
    ]);
    assertEquals(res.code, 0);
    const waited = Number(/waited=(\d+)/.exec(res.stdout)?.[1] ?? "99");
    assertEquals(
      waited <= 3,
      true,
      `waited ${waited}s for the leftover process`,
    );
    assertEquals(
      (await Deno.readTextFile(marker)).trim(),
      "ok",
      "the leftover process must survive its next write to stderr",
    );
    assertStringIncludes(res.stderr, "late message");
    assertEquals(res.stderr.includes("Failed to resolve"), false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("tp_quiet_runtime_notes_abort stops the filter, removes the folder and exits with the given status", async () => {
  const dir = await Deno.makeTempDir({ prefix: "tp-qrn-abort-" });
  try {
    const scratch = join(dir, "scratch");
    const res = await shell(FILTER, [
      `mkdir "${scratch}"`,
      `sleep 30 &`,
      `_qrn_pid=$!`,
      `_qrn_dir="${scratch}"`,
      `( tp_quiet_runtime_notes_abort 130 ) || echo "status=$?"`,
      `if kill -0 "$_qrn_pid" 2>/dev/null; then echo filter-alive; else echo filter-stopped; fi`,
      `[ -e "${scratch}" ] && echo folder-left || echo folder-removed`,
    ]);
    assertStringIncludes(res.stdout, "status=130");
    assertStringIncludes(res.stdout, "filter-stopped");
    assertStringIncludes(res.stdout, "folder-removed");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

test("tp_print_detail indents under its step", async () => {
  const res = await shell(["tp_print_detail"], [
    `tp_print_detail "Commit 7819829e"`,
  ]);
  assertEquals(res.stdout, "   Commit 7819829e\n");
});

async function hostAddress(
  ip: string,
  hostname: string,
): Promise<string> {
  const bin = await Deno.makeTempDir({ prefix: "tp-ip-" });
  try {
    await Deno.writeTextFile(join(bin, "ip"), `#!/bin/sh\n${ip}\n`);
    await Deno.writeTextFile(join(bin, "hostname"), `#!/bin/sh\n${hostname}\n`);
    await Deno.chmod(join(bin, "ip"), 0o755);
    await Deno.chmod(join(bin, "hostname"), 0o755);
    const res = await shell(["tp_host_address"], [`tp_host_address`], {
      PATH: `${bin}:/usr/bin:/bin`,
    });
    return res.stdout;
  } finally {
    await Deno.remove(bin, { recursive: true });
  }
}

const IP_V4_ROUTE =
  `case "$1" in -4) echo '1.1.1.1 via 10.0.0.1 dev eth0 src 10.0.0.5 uid 0' ;; *) exit 1 ;; esac`;
const IP_V6_ONLY =
  `case "$1" in -4) exit 0 ;; -6) echo '2606:4700:4700::1111 from :: via fe80::1 dev eth0 src 2001:db8::5 metric 1024 pref medium' ;; esac`;
const IP_NO_ROUTE = `exit 1`;

test("tp_host_address reads the IPv4 address from the default route", async () => {
  assertEquals(await hostAddress(IP_V4_ROUTE, "echo 172.17.0.1"), "10.0.0.5");
});

test("tp_host_address brackets an IPv6 address when there is no IPv4 route", async () => {
  assertEquals(await hostAddress(IP_V6_ONLY, "echo 10.9.9.9"), "[2001:db8::5]");
});

test("tp_host_address falls back to the first reachable address and skips local ones", async () => {
  assertEquals(
    await hostAddress(
      IP_NO_ROUTE,
      "echo 127.0.0.1 172.17.0.1 169.254.1.2 fe80::1 ::1 10.0.0.7 2001:db8::9",
    ),
    "10.0.0.7",
  );
});

test("tp_host_address brackets an IPv6 address found by the fallback", async () => {
  assertEquals(
    await hostAddress(IP_NO_ROUTE, "echo fe80::1 2001:db8::9"),
    "[2001:db8::9]",
  );
});

test("tp_host_address prints nothing when no address can be found", async () => {
  assertEquals(await hostAddress(IP_NO_ROUTE, "echo 127.0.0.1"), "");
});

test("every daemon verb that can print the runtime notes goes through the filter", async () => {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  const calls = source.split("\n").filter((line) =>
    /\b(run-installer|bootstrap-orchestration)\b/.test(line) &&
    !line.trim().startsWith("#")
  );
  assertEquals(calls.length >= 8, true, "expected the eight verb call sites");
  for (const line of calls) {
    assertStringIncludes(line, "tp_quiet_runtime_notes");
  }
});

test("the instance install ends with the wizard address, not a pointer to nothing", async () => {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  assertEquals(source.includes("printed above"), false);
  assertStringIncludes(source, ":8443/install");
  assertStringIncludes(source, "tp_host_address");
});

test("steps that start with a triangle in the instance install finish with a check or a visible failure", async () => {
  const source = await Deno.readTextFile(RUN_SH_PATH);
  const start = source.indexOf("tp_run_instance_install() {");
  const lines = source.slice(start, source.indexOf("\n}\n", start)).split("\n");
  const isStart = (line: string) => line.includes('tp_print_step "▸"');
  let open: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isStart(line)) {
      assertEquals(
        open,
        null,
        `step on line ${open} never finished: ${lines[open ?? 0]}`,
      );
      open = i;
      continue;
    }
    if (open === null) continue;
    if (line.includes("tp_print_ok")) {
      open = null;
    } else if (/\breturn\b/.test(line)) {
      // A way out while the step is open must say so on screen, on this
      // line or just above it.
      const nearby = lines.slice(Math.max(open, i - 8), i + 1).join("\n");
      assertStringIncludes(
        nearby,
        "tp_print_error",
        `a failure path leaves the step open: ${line.trim()}`,
      );
    }
  }
  assertEquals(open, null, "the last started step never finished");
});
