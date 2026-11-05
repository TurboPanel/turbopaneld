import { assertThrows } from "@std/assert";
import {
  assertCloneUrlAllowed,
  CloneUrlRefusedError,
} from "./clone-url-guard.ts";

const test = Deno.test.bind(Deno);

test("https, ssh and scp-like addresses to a public host are read", () => {
  for (
    const url of [
      "https://example.com/o/r",
      "https://example.com:8443/o/r.git",
      "ssh://git@example.com/o/r.git",
      "ssh://git@example.com:2222/o/r.git",
      "git@github.com:o/r.git",
      "https://[2001:db8::1]/o/r.git",
      "https://203.0.113.9/o/r.git",
    ]
  ) {
    assertCloneUrlAllowed(url);
  }
});

test("other transports, local paths and option-like values are refused", () => {
  for (
    const url of [
      "",
      "file:///etc",
      "git://example.com/o/r.git",
      "http://example.com/o/r.git",
      "ext::sh -c touch% /tmp/x",
      "ext::true",
      "/srv/repo",
      "./repo",
      "example.com:o/r.git",
      "-oProxyCommand=x@example.com:o/r",
      "git@-oProxyCommand=x:o/r",
      "https:///o/r",
      "https://user:secret@example.com/o/r.git",
      "https://token@example.com/o/r.git",
      "ssh://git:secret@example.com/o/r.git",
      "https://exa mple.com/o/r",
      "https://example.com\\@127.0.0.1/o/r.git",
    ]
  ) {
    assertThrows(() => assertCloneUrlAllowed(url), CloneUrlRefusedError);
  }
});

test("internal hosts are refused", () => {
  for (
    const url of [
      "https://127.0.0.1/x",
      "https://localhost/o/r.git",
      "https://[::1]/o/r.git",
      "https://169.254.169.254/latest",
      "https://10.0.0.5/o/r.git",
      "https://192.168.1.2/o/r.git",
      "https://[fd00::1]/o/r.git",
      "https://[fe80::1]/o/r.git",
      "git@10.1.2.3:o/r.git",
      "ssh://git@gitea.internal/o/r.git",
      "https://gitea/o/r.git",
      "https://2130706433/o/r.git",
    ]
  ) {
    assertThrows(() => assertCloneUrlAllowed(url), CloneUrlRefusedError);
  }
});
