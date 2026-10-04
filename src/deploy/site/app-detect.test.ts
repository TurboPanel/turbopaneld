import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  type AppProbe,
  createFsAppProbe,
  detectApp,
  MAX_WP_VERSION_FILE_BYTES,
  parseWordPressVersion,
  type ProbeRunFn,
} from "./app-detect.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

const VERSION_PHP = `<?php
$wp_version = '6.5.2';
$wp_db_version = 57155;
`;

type Tree = Record<string, string>;

/** Writes `path → contents` under a fresh temp docroot; `/`-ending keys are dirs. */
async function makeTree(tree: Tree): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "tp-appdetect-" });
  for (const [path, contents] of Object.entries(tree)) {
    const full = join(root, path);
    if (path.endsWith("/")) {
      await Deno.mkdir(full, { recursive: true });
      continue;
    }
    await Deno.mkdir(join(full, ".."), { recursive: true });
    await Deno.writeTextFile(full, contents);
  }
  return root;
}

const noPrivilegedRun: ProbeRunFn = () => {
  throw new Error("privileged runner must not be used for a readable tree");
};

async function detectIn(root: string) {
  try {
    return await detectApp(createFsAppProbe(root, noPrivilegedRun));
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

const REAL_WORDPRESS: Tree = {
  "index.php": "<?php require './wp-blog-header.php';",
  "wp-config.php": "<?php define('DB_PASSWORD', 'hunter2');",
  "wp-settings.php": "<?php",
  "wp-includes/version.php": VERSION_PHP,
  "wp-content/index.php": "<?php // Silence is golden.",
  "wp-admin/index.php": "<?php",
};

test({
  name: "detectApp recognises a real WordPress tree and its version",
  async fn() {
    const app = await detectIn(await makeTree(REAL_WORDPRESS));
    assertEquals(app, { kind: "wordpress", version: "6.5.2" });
  },
});

test({
  name:
    "detectApp recognises a fresh download (sample config, no wp-config.php)",
  async fn() {
    const { "wp-config.php": _config, ...rest } = REAL_WORDPRESS;
    const app = await detectIn(
      await makeTree({ ...rest, "wp-config-sample.php": "<?php" }),
    );
    assertEquals(app, { kind: "wordpress", version: "6.5.2" });
  },
});

test({
  name:
    "detectApp reports WordPress without a version when version.php is absent",
  async fn() {
    const { "wp-includes/version.php": _version, ...rest } = REAL_WORDPRESS;
    const app = await detectIn(
      await makeTree({ ...rest, "wp-includes/load.php": "<?php" }),
    );
    assertEquals(app, { kind: "wordpress" });
  },
});

test({
  name: "detectApp ignores a plain PHP site",
  async fn() {
    const app = await detectIn(
      await makeTree({ "index.php": "<?php echo 1;", "lib/util.php": "<?php" }),
    );
    assertEquals(app, undefined);
  },
});

test({
  name: "detectApp ignores a static site",
  async fn() {
    const app = await detectIn(
      await makeTree({ "index.html": "<h1>hi</h1>", "css/site.css": "a{}" }),
    );
    assertEquals(app, undefined);
  },
});

test({
  name:
    "detectApp ignores a decoy wp-content directory in a non-WordPress site",
  async fn() {
    const app = await detectIn(
      await makeTree({
        "index.php": "<?php",
        "wp-content/uploads/a.png": "x",
        "wp-includes/version.php": VERSION_PHP,
      }),
    );
    assertEquals(app, undefined);
  },
});

test({
  name: "detectApp needs core directories, not just a wp-config.php file",
  async fn() {
    const app = await detectIn(
      await makeTree({ "wp-config.php": "<?php", "index.php": "<?php" }),
    );
    assertEquals(app, undefined);
  },
});

test({
  name: "detectApp never follows a symlinked core directory out of the docroot",
  async fn() {
    const outside = await makeTree({ "version.php": VERSION_PHP });
    const root = await makeTree({
      "wp-config.php": "<?php",
      "wp-settings.php": "<?php",
    });
    await Deno.symlink(outside, join(root, "wp-includes"));
    await Deno.symlink(outside, join(root, "wp-content"));
    try {
      assertEquals(await detectIn(root), undefined);
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  },
});

test({
  name: "a symlinked version.php is not read, so no version leaks from outside",
  async fn() {
    const outside = await makeTree({ "secret.php": VERSION_PHP });
    const tree: Tree = { ...REAL_WORDPRESS };
    delete tree["wp-includes/version.php"];
    const root = await makeTree({
      ...tree,
      "wp-includes/load.php": "<?php",
    });
    await Deno.symlink(
      join(outside, "secret.php"),
      join(root, "wp-includes", "version.php"),
    );
    try {
      assertEquals(await detectIn(root), { kind: "wordpress" });
    } finally {
      await Deno.remove(outside, { recursive: true });
    }
  },
});

test({
  name: "a symlinked docroot is resolved once and its tree is detected",
  async fn() {
    const release = await makeTree(REAL_WORDPRESS);
    const link = join(await Deno.makeTempDir(), "current");
    await Deno.symlink(release, link);
    try {
      const app = await detectApp(createFsAppProbe(link, noPrivilegedRun));
      assertEquals(app, { kind: "wordpress", version: "6.5.2" });
    } finally {
      await Deno.remove(release, { recursive: true });
      await Deno.remove(link);
    }
  },
});

test({
  name: "wp-config.php is listed but never opened",
  async fn() {
    const opened: string[] = [];
    const probe: AppProbe = {
      listDir: (rel) =>
        Promise.resolve(
          {
            "": ["wp-config.php", "wp-settings.php"],
            "wp-includes": ["version.php"],
            "wp-content": [],
          }[rel] ?? null,
        ),
      readText: (rel) => {
        opened.push(rel);
        return Promise.resolve(VERSION_PHP);
      },
    };
    assertEquals(await detectApp(probe), {
      kind: "wordpress",
      version: "6.5.2",
    });
    assertEquals(opened, ["wp-includes/version.php"]);
  },
});

test({
  name: "parseWordPressVersion accepts release shapes and rejects junk",
  fn() {
    assertEquals(parseWordPressVersion("$wp_version = '6.5';"), "6.5");
    assertEquals(
      parseWordPressVersion('<?php $wp_version = "6.5.2";'),
      undefined,
    );
    assertEquals(
      parseWordPressVersion("$wp_version = '6.6-beta2';"),
      "6.6-beta2",
    );
    assertEquals(parseWordPressVersion("$wp_version = '<script>';"), undefined);
    assertEquals(parseWordPressVersion("nothing here"), undefined);
  },
});

test({
  name: "the version.php read is capped",
  async fn() {
    const padding = " ".repeat(MAX_WP_VERSION_FILE_BYTES + 10);
    const root = await makeTree({
      ...REAL_WORDPRESS,
      "wp-includes/version.php": `${padding}$wp_version = '6.5.2';`,
    });
    // The assignment sits past the cap, so it is never seen.
    assertEquals(await detectIn(root), { kind: "wordpress" });
  },
});

test({
  name:
    "an unlistable tree falls back to the privileged ls and reports no version",
  async fn() {
    const calls: string[][] = [];
    const run: ProbeRunFn = (_command, args) => {
      calls.push(args);
      const dir = args.at(-1) ?? "";
      const listings: Record<string, string> = {
        "/srv/users/alice/sites/svc/webroot":
          "wp-config.php\nwp-settings.php\nwp-includes\nwp-content",
        "/srv/users/alice/sites/svc/webroot/wp-includes": "version.php",
        "/srv/users/alice/sites/svc/webroot/wp-content": "index.php",
      };
      const stdout = listings[dir];
      return Promise.resolve({
        success: stdout !== undefined,
        stdout: stdout ?? "",
        stderr: "",
      });
    };
    const app = await detectApp(
      createFsAppProbe("/srv/users/alice/sites/svc/webroot", run),
    );
    assertEquals(app, { kind: "wordpress" });
    assertEquals(calls.length, 3);
    assertEquals(
      calls.every((args) => args.includes("ls") && args.includes("-A")),
      true,
    );
  },
});

test({
  name: "a symlink that exists is refused without a privileged fallback",
  async fn() {
    const outside = await Deno.makeTempDir();
    const root = await makeTree({
      "wp-config.php": "<?php",
      "wp-settings.php": "<?php",
    });
    await Deno.symlink(outside, join(root, "wp-includes"));
    try {
      const probe = createFsAppProbe(root, noPrivilegedRun);
      assertEquals(await probe.listDir("wp-includes"), null);
      assertEquals(await probe.readText("wp-includes/version.php", 100), null);
    } finally {
      await Deno.remove(root, { recursive: true });
      await Deno.remove(outside, { recursive: true });
    }
  },
});
