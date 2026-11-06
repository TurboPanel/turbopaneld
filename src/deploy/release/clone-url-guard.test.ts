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
      "ssh://git@gitserver.internal/o/r.git",
      "https://gitserver/o/r.git",
      "https://2130706433/o/r.git",
    ]
  ) {
    assertThrows(() => assertCloneUrlAllowed(url), CloneUrlRefusedError);
  }
});

test("hosts with a local network ending are refused", () => {
  for (
    const url of [
      "https://git.lan/o/r.git",
      "https://GIT.LAN./o/r.git",
      "https://git.example.corp/o/r.git",
      "https://code.intranet/o/r.git",
      "https://git.private/o/r.git",
      "https://nas.home/o/r.git",
      "ssh://git@git.lan:2222/o/r.git",
      "git@git.corp:o/r.git",
    ]
  ) {
    assertThrows(
      () => assertCloneUrlAllowed(url),
      CloneUrlRefusedError,
      "repositories must be on a public git host",
      url,
    );
  }
  // Only the last label counts: these end in a public suffix.
  for (
    const url of [
      "https://git.lan.example.com/o/r.git",
      "https://git.home.example.org/o/r.git",
      "https://git.example.homes/o/r.git",
      "git@corp.example.com:o/r.git",
    ]
  ) {
    assertCloneUrlAllowed(url);
  }
});

test("IPv6 addresses that deliver to a private IPv4 address are refused", () => {
  for (
    const url of [
      "https://[2002:7f00:1::1]/o/r.git",
      "https://[2002:c0a8:101::1]/o/r.git",
      "https://[::127.0.0.1]/o/r.git",
      "https://[::10.0.0.5]/o/r.git",
      "https://[2001:0:a00:5::1]/o/r.git",
      "https://[64:ff9b:1::808:808]/o/r.git",
    ]
  ) {
    assertThrows(
      () => assertCloneUrlAllowed(url),
      CloneUrlRefusedError,
      "public git host",
      url,
    );
  }
  assertCloneUrlAllowed("https://[2002:808:808::1]/o/r.git");
});

test("a user, host or port that git and the URL parser read differently is refused", () => {
  for (
    const url of [
      "ssh://git@github.com#@127.0.0.1/a",
      "ssh://git@github.com?@127.0.0.1/a",
      "ssh://git@github.com#x@127.0.0.1",
      "ssh://git@github.com?x=@10.0.0.1/a",
      "ssh://git@github.com:22#@127.0.0.1/a",
      "ssh://git@github.com;@127.0.0.1/a",
      "https://github.com#@127.0.0.1/a",
      "https://github.com?@127.0.0.1/a",
      "ssh://git@evil%40127.0.0.1/a",
      "ssh://%31%32%37.0.0.1/a",
      "ssh://git@%6c%6f%63%61%6c%68%6f%73%74/a",
      "ssh://git@%31%30.0.0.1/a",
      "ssh://git%40x@example.com/a",
      "ssh://git@example.com:22%30/a",
    ]
  ) {
    assertThrows(() => assertCloneUrlAllowed(url), CloneUrlRefusedError);
  }
  assertCloneUrlAllowed("ssh://git@example.com/o/my%20repo.git");
});
