import { assertEquals } from "jsr:@std/assert";
import {
  logComponent,
  relabelComponent,
  sanitizeStatusLine,
  shouldDropPresenterLogLine,
  shouldDropStatusLine,
  summarizeRecap,
} from "./presentation.ts";
import {
  setActiveInstallPresenter,
} from "./install-presenter-context.ts";
import { InstallPresenter } from "./install-presenter.ts";

const FORBIDDEN_TOKENS = ["ansible", "ansible-galaxy", "redis", "rabbitmq", "uv"];

function assertNoForbiddenTokens(text: string, label: string): void {
  const lower = text.toLowerCase();
  for (const token of FORBIDDEN_TOKENS) {
    if (lower.includes(token)) {
      throw new Error(`${label}: forbidden token "${token}" survived in "${text}"`);
    }
  }
}

Deno.test("logComponent preserves vendor names when presenter is inactive", () => {
  setActiveInstallPresenter(null);
  assertEquals(logComponent("ansible"), "ansible");
  assertEquals(logComponent("ansible-galaxy"), "ansible-galaxy");
  assertEquals(logComponent("uv"), "uv");
  assertEquals(logComponent("python"), "python");
});

Deno.test("logComponent relabels vendor names when presenter is active", () => {
  const presenter = new InstallPresenter(false);
  setActiveInstallPresenter(presenter);
  try {
    assertEquals(logComponent("ansible"), "orchestration");
    assertEquals(logComponent("ansible-galaxy"), "orchestration");
    assertEquals(logComponent("uv"), "runtime");
    assertEquals(logComponent("python"), "runtime");
  } finally {
    presenter.dispose();
    setActiveInstallPresenter(null);
  }
});

Deno.test("shouldDropPresenterLogLine drops bootstrap orchestration internals", () => {
  const dropped = [
    "creating venv at /opt/turbopanel/vendor/ansible/venv",
    "installing packages from orchestration/requirements.txt",
    "downloading uv 0.11.19 from https://example.com/uv.tar.gz",
    "ensuring Python 3.12.7 is installed",
    "installing galaxy roles from orchestration/galaxy.yml",
    "installing galaxy collections from orchestration/galaxy.yml",
    "ansible already installed, skipping setup",
    "galaxy content up to date, skipping install",
    "uv 0.11.19 already installed",
    "uv 0.11.0 found, replacing with pinned 0.11.19",
    "uv archive checksum verified",
    "uv 0.11.19 installed at /opt/turbopanel/vendor/uv/current/bin/uv",
    "Python 3.12.7 ready at /opt/turbopanel/vendor/python/3.12",
    "ansible installed",
    "galaxy roles ready",
    "galaxy collections ready",
    "bootstrap inputs unchanged, skipping localhost smoke-test",
  ];

  for (const line of dropped) {
    assertEquals(shouldDropPresenterLogLine(line), true, line);
  }
});

Deno.test("relabelComponent maps vendor components to neutral labels", () => {
  assertEquals(relabelComponent("ansible"), "orchestration");
  assertEquals(relabelComponent("ansible-galaxy"), "orchestration");
  assertEquals(relabelComponent("ansible-core"), "orchestration");
  assertEquals(relabelComponent("galaxy"), "orchestration");
  assertEquals(relabelComponent("uv"), "runtime");
  assertEquals(relabelComponent("python"), "runtime");
  assertEquals(relabelComponent("orchestration"), "orchestration");
  assertEquals(relabelComponent("installer"), "installer");
  assertEquals(relabelComponent("daemon"), "daemon");
});

Deno.test("relabelComponent output contains no forbidden tokens", () => {
  const inputs = [
    "ansible",
    "ansible-galaxy",
    "ansible-core",
    "galaxy",
    "uv",
    "python",
  ];
  for (const component of inputs) {
    assertNoForbiddenTokens(relabelComponent(component), `relabelComponent(${component})`);
  }
});

Deno.test("sanitizeStatusLine scrubs vendor tokens case-insensitively", () => {
  const samples: Array<[string, string]> = [
    ["Connecting to Redis cache", "Connecting to cache cache"],
    ["RabbitMQ broker ready", "queue broker ready"],
    ["rabbit mq listener started", "queue listener started"],
    ["Running ansible-galaxy collection install", "Running orchestration collection install"],
    ["ansible playbook complete", "orchestration playbook complete"],
    ["uv resolved dependencies", "runtime resolved dependencies"],
    ["Using CPython 3.12", "Using runtime 3.12"],
    ["Python environment ready", "runtime environment ready"],
    ["galaxy roles installed", "orchestration roles installed"],
  ];

  for (const [input, expected] of samples) {
    assertEquals(sanitizeStatusLine(input), expected, input);
    assertNoForbiddenTokens(sanitizeStatusLine(input), `sanitizeStatusLine(${input})`);
  }
});

Deno.test("sanitizeStatusLine preserves path-like segments on whole-word boundaries", () => {
  const line = "installed to /opt/turbopanel/vendor/redis/current";
  const sanitized = sanitizeStatusLine(line);
  assertEquals(sanitized.includes("/opt/turbopanel/vendor/redis/current"), true);
});

Deno.test("shouldDropStatusLine drops package, venv, and galaxy noise", () => {
  const bareTempDownloadPath = ["Downloading community.docker to ", "/", "tmp", "/ansible-galaxy-abc123"].join("");
  const bareTempPathEcho = ["/", "tmp", "/", "ansible-galaxy-roles-xyz"].join("");
  const dropped = [
    " + ansible-core==2.17.0",
    "Resolved 42 packages in 1.2s",
    "Prepared 15 packages in 500ms",
    "Installed 33 packages in 2.1s",
    "Using CPython 3.12.7 interpreter at: /usr/bin/python3",
    "Creating virtual environment at: /opt/turbopanel/vendor/python/3.12",
    "Activate with: source .venv/bin/activate",
    "Using Python 3.12.7 environment at: /opt/turbopanel/vendor/python/3.12",
    bareTempDownloadPath,
    "Process install dependency map",
    "Starting galaxy collection install process",
    bareTempPathEcho,
    "/opt/turbopanel/vendor/ansible/galaxy-collections",
    "",
    "   ",
  ];

  for (const line of dropped) {
    assertEquals(shouldDropStatusLine(line), true, line);
  }
});

Deno.test("shouldDropPresenterLogLine drops raw lines that survive sanitization", () => {
  const rawLines = [
    "Using CPython 3.12.7 interpreter at: /usr/bin/python3",
    "uv 0.11.19 already installed",
    "installing galaxy roles from orchestration/galaxy.yml",
  ];

  for (const line of rawLines) {
    assertEquals(shouldDropPresenterLogLine(line), true, `raw: ${line}`);
    const sanitized = sanitizeStatusLine(line);
    assertEquals(
      shouldDropPresenterLogLine(sanitized),
      true,
      `sanitized: ${sanitized}`,
    );
  }
});

Deno.test("shouldDropPresenterLogLine drops sanitized bootstrap orchestration internals", () => {
  const dropped = [
    "Using runtime 3.12.7 interpreter at: /usr/bin/python3",
    "runtime 0.11.19 already installed",
    "installing orchestration roles from orchestration/galaxy.yml",
    "orchestration already installed, skipping setup",
    "orchestration content up to date, skipping install",
  ];

  for (const line of dropped) {
    assertEquals(shouldDropPresenterLogLine(line), true, line);
  }
});

Deno.test("shouldDropStatusLine keeps meaningful installer status", () => {
  const kept = [
    "orchestration applied (33 steps, 15 changes)",
    "runtime ready",
    "Installing platform services",
    "cache service started",
    "queue broker started",
  ];

  for (const line of kept) {
    assertEquals(shouldDropStatusLine(line), false, line);
  }
});

Deno.test("summarizeRecap produces neutral success and failure one-liners", () => {
  assertEquals(
    summarizeRecap("ok=33 changed=15 failed=0 unreachable=0"),
    "orchestration applied (33 steps, 15 changes)",
  );
  assertEquals(
    summarizeRecap("ok=10 changed=2 failed=1 unreachable=0"),
    "orchestration failed (1 failure, 10 steps, 2 changes)",
  );
  assertEquals(
    summarizeRecap("ok=5 changed=0 failed=2 unreachable=1"),
    "orchestration failed (3 failures, 5 steps, 0 changes)",
  );
});
