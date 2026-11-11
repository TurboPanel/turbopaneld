import { assertEquals, assertStringIncludes } from "@std/assert";
import { checkHtaccess, htaccessWarnings } from "./htaccess-check.ts";

const test = Deno.test.bind(Deno);

const WORDPRESS = `# BEGIN WordPress
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
RewriteBase /
RewriteRule ^index\\.php$ - [L]
RewriteCond %{REQUEST_FILENAME} !-f
RewriteCond %{REQUEST_FILENAME} !-d
RewriteRule . /index.php [L]
</IfModule>
# END WordPress
`;

const LARAVEL = `<IfModule mod_negotiation.c>
    Options -MultiViews -Indexes
</IfModule>

<IfModule mod_rewrite.c>
    RewriteEngine On
    RewriteCond %{HTTP:Authorization} .
    RewriteRule .* - [E=HTTP_AUTHORIZATION:%{HTTP:Authorization}]
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteCond %{REQUEST_URI} (.+)/$
    RewriteRule ^ %1 [L,R=301]
    RewriteCond %{REQUEST_FILENAME} !-d
    RewriteCond %{REQUEST_FILENAME} !-f
    RewriteRule ^ index.php [L]
</IfModule>
`;

const DRUPAL_FILES = `# Turn off all options we don't need.
Options -Indexes -ExecCGI -Includes -MultiViews
SetHandler Drupal_Security_Do_Not_Remove_See_SA_2006_006
<Files *>
  SetHandler Drupal_Security_Do_Not_Remove_See_SA_2013_003
</Files>
<IfModule mod_php.c>
  php_flag engine off
</IfModule>
`;

test("ordinary .htaccess files raise no finding", () => {
  for (const text of [WORDPRESS, LARAVEL, DRUPAL_FILES]) {
    assertEquals(checkHtaccess(text), []);
  }
  assertEquals(
    checkHtaccess(
      [
        "Order deny,allow",
        "Deny from all",
        "ExpiresActive On",
        'ExpiresByType image/png "access plus 1 month"',
        "AddOutputFilterByType DEFLATE text/html text/plain",
        "AuthType Basic",
        'AuthName "Private"',
        "AuthUserFile /srv/users/a/.htpasswd",
        "Require valid-user",
        "Options +Indexes",
        "Header set X-Frame-Options SAMEORIGIN",
        "",
      ].join("\n"),
    ),
    [],
  );
});

test("refused and unknown directives are found with their line numbers", () => {
  const text = [
    "# a comment",
    "AddHandler application/x-httpd-php .txt",
    "",
    "Options +FollowSymLinks",
    "ProxyFCGISetEnvIf true PHP_VALUE x",
    "PassEnv HOME",
    "php_value memory_limit 1G",
    "NoSuchThing on",
    "Options All",
  ].join("\n");
  assertEquals(checkHtaccess(text), [
    { line: 2, directive: "AddHandler", reason: "not allowed" },
    { line: 4, directive: "Options", reason: "not allowed" },
    { line: 5, directive: "ProxyFCGISetEnvIf", reason: "not allowed" },
    { line: 6, directive: "PassEnv", reason: "not allowed" },
    { line: 7, directive: "php_value", reason: "not allowed" },
    { line: 8, directive: "NoSuchThing", reason: "unknown" },
    { line: 9, directive: "Options", reason: "not allowed" },
  ]);
});

test("a block for a module that is not loaded is skipped, as Apache does", () => {
  assertEquals(
    checkHtaccess("<IfModule mod_php.c>\nphp_value x 1\n</IfModule>\n"),
    [],
  );
  assertEquals(
    checkHtaccess(
      "<IfModule mod_php_module>\n<IfModule mod_rewrite.c>\nphp_flag a on\n</IfModule>\n</IfModule>\n",
    ),
    [],
  );
  // A negated block for a missing module does run.
  assertEquals(
    checkHtaccess("<IfModule !mod_php.c>\nAddHandler x .y\n</IfModule>\n"),
    [{ line: 2, directive: "AddHandler", reason: "not allowed" }],
  );
  // A block for a loaded module runs.
  assertEquals(
    checkHtaccess("<IfModule mod_rewrite.c>\nAddHandler x .y\n</IfModule>\n"),
    [{ line: 2, directive: "AddHandler", reason: "not allowed" }],
  );
});

test("continuation lines join under the first line's number, and containers are looked into", () => {
  assertEquals(
    checkHtaccess("Header set X-A \\\n  b\nAddHandler a \\\n  .b\n"),
    [{ line: 3, directive: "AddHandler", reason: "not allowed" }],
  );
  assertEquals(
    checkHtaccess(
      "<Files secret.txt>\nAddHandler a .b\nRequire all denied\n</Files>\n",
    ),
    [{ line: 2, directive: "AddHandler", reason: "not allowed" }],
  );
});

test("warnings read in plain words, are capped at ten, and never name a row", () => {
  const findings = Array.from({ length: 12 }, (_, i) => ({
    line: i + 1,
    directive: i === 0 ? "Bogus" : "AddHandler",
    reason: i === 0 ? ("unknown" as const) : ("not allowed" as const),
  }));
  const warnings = htaccessWarnings("web", findings);
  assertEquals(warnings.length, 11);
  assertEquals(
    warnings[0],
    "Site web: .htaccess line 1: Bogus is not a directive this server knows, so Apache answers 500 for that folder.",
  );
  assertEquals(
    warnings[1],
    "Site web: .htaccess line 2: AddHandler is not allowed on this server, so Apache answers 500 for that folder.",
  );
  assertStringIncludes(warnings[10], "and 2 more");
});

test("a long or odd token is never echoed into a warning", () => {
  const long = "A".repeat(5000);
  assertEquals(checkHtaccess(`${long} on\n`), [
    { line: 1, directive: "(unreadable)", reason: "unknown" },
  ]);
  assertEquals(checkHtaccess("Bad$(id) on\n"), [
    { line: 1, directive: "(unreadable)", reason: "unknown" },
  ]);
  const [warning] = htaccessWarnings("web", checkHtaccess(`${long} on\n`));
  assertEquals(warning.length < 200, true);
});

test("IfDefine, IfFile, IfDirective and IfSection are looked into, not reported", () => {
  for (
    const tag of [
      "IfDefine FOO",
      "IfFile /x",
      "IfDirective Bar",
      "IfSection Baz",
    ]
  ) {
    const name = tag.split(" ")[0];
    assertEquals(
      checkHtaccess(`<${tag}>\nHeader set X-A b\n</${name}>\n`),
      [],
      tag,
    );
    assertEquals(
      checkHtaccess(`<${tag}>\nAddHandler a .b\n</${name}>\n`),
      [{ line: 2, directive: "AddHandler", reason: "not allowed" }],
      tag,
    );
  }
});
