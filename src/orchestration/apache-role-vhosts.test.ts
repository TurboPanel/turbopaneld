import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { dirname, fromFileUrl, join } from "@std/path";
import { parse } from "yaml";
import {
  APACHE_OVERRIDE_CLASSES,
  APACHE_OVERRIDE_LIST,
} from "../deploy/site/apache-overrides.ts";

const test = Deno.test.bind(Deno);

const ROLE = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "..",
  "orchestration",
  "roles",
  "apache",
);
const GOLDEN = join(
  dirname(fromFileUrl(import.meta.url)),
  "..",
  "deploy",
  "testdata",
  "config-goldens",
  "apache-vhost.conf",
);

/** An Apache vhost as the daemon rendered it before the closed override list. */
const OLD_VHOST = String.raw`# TurboPanel site phpapp
Listen 127.0.0.1:18081
<VirtualHost 127.0.0.1:18081>
  ServerName localhost
  RemoteIPHeader X-Forwarded-For
  RemoteIPInternalProxy 127.0.0.1
  <If "%{CONN_REMOTE_ADDR} == '127.0.0.1' && %{HTTP:X-Forwarded-Proto} == 'https'">
    SetEnv HTTPS on
  </If>
  ProxyFCGISetEnvIf "%{CONN_REMOTE_ADDR} == '127.0.0.1' && %{HTTP:X-Forwarded-Proto} == 'https'" SERVER_PORT 443
  ProxyFCGISetEnvIf "%{CONN_REMOTE_ADDR} == '127.0.0.1' && %{HTTP:X-Forwarded-Proto} == 'https'" REQUEST_SCHEME https
  <LocationMatch "/\.(?!well-known(?:/|$))">
    Require all denied
  </LocationMatch>
  DocumentRoot "/srv/users/u/sites/phpapp/current/public"
  <Directory "/srv/users/u/sites/phpapp/current/public">
    Options Indexes SymLinksIfOwnerMatch
    AllowOverride AuthConfig FileInfo Indexes Limit Options=Indexes,MultiViews,SymLinksIfOwnerMatch
    Require all granted
  </Directory>
  DirectoryIndex index.php index.html
  <FilesMatch \.php$>
    SetHandler "proxy:unix:/run/turbopanel/php/8.4/tp-env-phpapp.sock|fcgi://localhost/"
  </FilesMatch>
  SetEnv APP_ENV "production"
  SetEnv EMPTY ""
  SetEnv QUOTED "say \"hi\" \\ bye"
  SetEnv URL "https://x.example/a?b=c&d=%20"
</VirtualHost>
`;

type Task = Record<string, unknown> & { name: string };

const tasks = parse(
  await Deno.readTextFile(join(ROLE, "tasks", "main.yml")),
) as Task[];
const defaults = parse(
  await Deno.readTextFile(join(ROLE, "defaults", "main.yml")),
) as Record<string, unknown>;

function task(name: string): Record<string, string> {
  const found = tasks.find((entry) => entry.name === name);
  assert(found, name);
  const module = Object.keys(found).find((key) => key.startsWith("ansible."));
  assert(module);
  return found[module] as Record<string, string>;
}

/** The role's variables the replace and lineinfile tasks name. */
function render(text: string, item: string | undefined = undefined): string {
  return text
    .replaceAll(
      "{{ apache_override_classes }}",
      String(defaults.apache_override_classes),
    )
    .replaceAll(
      "{{ apache_override_list }}",
      String(defaults.apache_override_list).trim().replace(/\s+/g, " "),
    )
    .replaceAll("{{ item.1 }}", item ?? "");
}

/** What `ansible.builtin.replace` does: a multiline regex, `\1` and `\n`. */
function applyReplace(text: string, name: string): string {
  const module = task(name);
  const replacement = render(module.replace)
    .replace(/\\(\d)/g, "$$$1")
    .replaceAll("\\n", "\n");
  return text.replace(new RegExp(module.regexp, "gm"), replacement);
}

/** What `ansible.builtin.lineinfile` does with `regexp`, `line`, `insertafter`. */
function applyStrip(text: string): string {
  const module = task(
    "Strip PHP settings and the site key at the top of those vhosts",
  );
  let out = text;
  for (const name of defaults.apache_vhost_strip_names as string[]) {
    const line = render(module.line, name).replace(/^'|'$/g, "");
    const regexp = new RegExp(render(module.regexp, name), "m");
    if (regexp.test(out)) {
      out = out.replace(regexp, line);
    } else {
      out = out.replace(
        new RegExp(`(${module.insertafter.replace(/^\^|\$$/g, "")}\\n)`),
        `$1${line}\n`,
      );
    }
  }
  return out;
}

/** The role's three vhost edits, in task order. */
function tighten(text: string): string {
  return applyStrip(
    applyReplace(
      applyReplace(
        text,
        "Drop Indexes from the default Options of those vhosts",
      ),
      "Give those vhosts the closed override list instead of FileInfo",
    ),
  );
}

const STILL_OPEN = new RegExp(
  task("Find vhosts that still carry FileInfo or All").contains,
  "m",
);

test("the role's copies of the override lists equal the daemon's constants", () => {
  assertEquals(defaults.apache_override_classes, APACHE_OVERRIDE_CLASSES);
  assertEquals(
    String(defaults.apache_override_list).trim().split(/\s+/),
    [...APACHE_OVERRIDE_LIST],
  );
  assertEquals(defaults.apache_vhost_strip_names, [
    "PHP_VALUE",
    "PHP_ADMIN_VALUE",
    "PHPRC",
    "PHP_INI_SCAN_DIR",
    "TP_SITE_KEY",
  ]);
});

test("a vhost rendered before the closed list is brought to it, once", () => {
  const tightened = tighten(OLD_VHOST);
  assertEquals(tightened.includes("FileInfo"), false);
  assertStringIncludes(tightened, "    Options SymLinksIfOwnerMatch\n");
  assertEquals(tightened.includes("Options Indexes"), false);
  assertStringIncludes(
    tightened,
    `    AllowOverride ${APACHE_OVERRIDE_CLASSES}\n    AllowOverrideList ${
      APACHE_OVERRIDE_LIST.join(" ")
    }\n`,
  );
  for (
    const name of [
      "PHP_VALUE",
      "PHP_ADMIN_VALUE",
      "PHPRC",
      "PHP_INI_SCAN_DIR",
      "TP_SITE_KEY",
    ]
  ) {
    assertEquals(
      tightened.split(`ProxyFCGISetEnvIf "true" !${name}\n`).length - 1,
      1,
      name,
    );
  }
  // The strip lines sit at vhost level, ahead of the folder block, and the
  // rest of the vhost is as it was.
  assertEquals(
    tightened.indexOf("!PHP_VALUE") < tightened.indexOf("<Directory"),
    true,
  );
  assertStringIncludes(tightened, 'SetHandler "proxy:unix:');
  assertEquals(STILL_OPEN.test(tightened), false);
  // A second pass changes nothing.
  assertEquals(tighten(tightened), tightened);
});

test("the oldest shape (All with FollowSymLinks) is tightened too", () => {
  const oldest = OLD_VHOST
    .replace(
      "Options Indexes SymLinksIfOwnerMatch",
      "Options Indexes FollowSymLinks",
    )
    .replace(/AllowOverride AuthConfig FileInfo[^\n]*/, "AllowOverride All");
  assertEquals(STILL_OPEN.test(oldest), true);
  const tightened = tighten(oldest);
  assertEquals(STILL_OPEN.test(tightened), false);
  assertEquals(tightened.includes("FollowSymLinks"), false);
  assertStringIncludes(tightened, `AllowOverride ${APACHE_OVERRIDE_CLASSES}`);
  assertEquals(tighten(tightened), tightened);
});

test("a vhost the daemon renders now is left exactly as it is, and the open-override check does not flag it", async () => {
  const current = await Deno.readTextFile(GOLDEN);
  assertEquals(tighten(current), current);
  assertEquals(STILL_OPEN.test(current), false);
});

test("a vhost in a shape the role does not rewrite is caught instead of left open", () => {
  const odd = OLD_VHOST.replace(
    /AllowOverride AuthConfig FileInfo[^\n]*/,
    "AllowOverride FileInfo Limit",
  );
  assertEquals(STILL_OPEN.test(tighten(odd)), true);
});
