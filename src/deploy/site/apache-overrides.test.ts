import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import {
  APACHE_HTACCESS_MODULES,
  APACHE_OVERRIDE_CLASSES,
  APACHE_OVERRIDE_LIST,
  APACHE_REFUSED_DIRECTIVES,
  apacheOverrideListLine,
} from "./apache-overrides.ts";

const test = Deno.test.bind(Deno);

const TEMPLATE = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "..",
  "orchestration",
  "roles",
  "apache",
  "templates",
  "httpd.conf.j2",
);

test("the override list names nothing that runs programs, sets handlers by extension or changes PHP", () => {
  const names = new Set(APACHE_OVERRIDE_LIST.map((name) => name.toLowerCase()));
  for (const refused of APACHE_REFUSED_DIRECTIVES) {
    assertEquals(names.has(refused.toLowerCase()), false, refused);
  }
  for (
    const wrong of ["addhandler", "action", "passenv", "proxyfcgisetenvif"]
  ) {
    assertEquals(names.has(wrong), false, wrong);
  }
  assertEquals(
    APACHE_OVERRIDE_LIST.some((name) => /^php_/i.test(name)),
    false,
  );
  assertEquals(
    APACHE_OVERRIDE_LIST.some((name) => /InputFilter/.test(name)),
    false,
  );
  assertEquals(
    new Set(APACHE_OVERRIDE_LIST).size,
    APACHE_OVERRIDE_LIST.length,
    "no duplicates",
  );
  assertStringIncludes(apacheOverrideListLine(), "RewriteEngine RewriteCond");
});

test("the override classes carry no FileInfo, All or FollowSymLinks", () => {
  for (const word of ["FileInfo", "All", "FollowSymLinks"]) {
    assertEquals(
      APACHE_OVERRIDE_CLASSES.split(/[\s=,]+/).includes(word),
      false,
      word,
    );
  }
});

test("every module the list depends on is loaded by the Apache role, and no module that runs or rewrites content is", async () => {
  const template = await Deno.readTextFile(TEMPLATE);
  for (const name of APACHE_HTACCESS_MODULES) {
    assertStringIncludes(
      template,
      `LoadModule ${name}_module modules/mod_${name}.so`,
    );
  }
  const loaded = [...template.matchAll(/^LoadModule (\S+)_module /gm)]
    .map((match) => match[1]);
  for (
    const forbidden of [
      "cgi",
      "cgid",
      "actions",
      "include",
      "ext_filter",
      "substitute",
      "sed",
      "lua",
      "userdir",
      "info",
      "status",
      "proxy_http",
      "proxy_ajp",
      "proxy_balancer",
      "proxy_wstunnel",
      "proxy_connect",
      "proxy_ftp",
      "proxy_scgi",
      "proxy_uwsgi",
      "proxy_fdpass",
      "proxy_express",
      "negotiation",
    ]
  ) {
    assertEquals(loaded.includes(forbidden), false, forbidden);
  }
  assert(loaded.includes("proxy_fcgi"));
});

test("the Apache config hides dotfiles and editor backups from an opt-in listing", async () => {
  assertStringIncludes(
    await Deno.readTextFile(TEMPLATE),
    "IndexIgnore .??* *~ *#",
  );
});
