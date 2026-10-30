import { assertEquals } from "@std/assert";
import {
  type AllowlistEntry,
  extractReferences,
  resolveReference,
} from "./check-guide-references.ts";

const repoRoot = "/work/daemon";
const present = new Set([
  "/work/daemon/docs/setup.md",
  "/work/daemon/src/AGENTS.md",
]);
const exists = (p: string) => present.has(p);

function status(
  kind: "link" | "code",
  target: string,
  file = "src/managed/AGENTS.md",
  allowlist: AllowlistEntry[] = [],
  has: (p: string) => boolean = exists,
) {
  return resolveReference({
    kind,
    target,
    file,
    repoRoot,
    exists: has,
    allowlist,
  }).status;
}

Deno.test("accepts a link that resolves relative to the guide", () => {
  assertEquals(status("link", "../AGENTS.md#rules"), "ok");
});

Deno.test("reports a missing file", () => {
  assertEquals(status("link", "./gone.md"), "missing");
});

Deno.test("links never resolve against the repo root, backticked paths may", () => {
  assertEquals(status("link", "docs/setup.md"), "missing");
  assertEquals(status("code", "docs/setup.md"), "ok");
});

Deno.test("skips anchors and external links", () => {
  assertEquals(status("link", "#section"), "skipped-anchor");
  assertEquals(status("link", "https://example.com/x"), "skipped-external");
  assertEquals(status("link", "mailto:a@example.com"), "skipped-external");
});

Deno.test("skips a sibling path when the checkout is absent and checks it when present", () => {
  assertEquals(
    status("code", "../turbopanel/src/AGENTS.md", "AGENTS.md"),
    "skipped-sibling",
  );
  const withSibling = (p: string) =>
    p === "/work/turbopanel" || p === "/work/turbopanel/src/AGENTS.md";
  assertEquals(
    status("code", "../turbopanel/src/AGENTS.md", "AGENTS.md", [], withSibling),
    "ok",
  );
  assertEquals(
    status("code", "../turbopanel/src/nope.md", "AGENTS.md", [], withSibling),
    "missing",
  );
});

Deno.test("lets an allowlisted pointer through", () => {
  const allowlist = [{
    file: "docs/setup.md",
    target: "./console",
    reason: "command",
  }];
  assertEquals(
    status("code", "./console", "docs/setup.md", allowlist),
    "allowlisted",
  );
  assertEquals(
    status("code", "./console", "docs/other.md", allowlist),
    "missing",
  );
});

Deno.test("extracts links and path-like backticks, ignoring code fences and prose", () => {
  const text = [
    "See [setup](./docs/setup.md) and `src/AGENTS.md`, `../ui/x.ts`, `deno task test`.",
    "```",
    "[ignored](./nope.md)",
    "```",
    "Mount `./data:/data`, `<repo>/x.md` and `../repo/...` are not paths.",
  ].join("\n");
  assertEquals(
    extractReferences(text).map((r) => `${r.line}:${r.kind}:${r.target}`),
    ["1:link:./docs/setup.md", "1:code:src/AGENTS.md", "1:code:../ui/x.ts"],
  );
});
