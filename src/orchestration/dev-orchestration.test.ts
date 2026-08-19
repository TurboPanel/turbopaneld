import { assertEquals, assertRejects } from "@std/assert";
import { join } from "@std/path";
import {
  DEV_CONVERGE_MANIFEST_FILE,
  devOrchestrationAnsibleEnv,
  devOrchestrationReady,
  readDevConvergeManifest,
  requireDevOrchestrationLayout,
  resolveDevConvergeRoleDir,
  resolveDevOrchestrationDir,
  resolveDevOrchestrationLayout,
} from "./dev-orchestration.ts";
import { GALAXY_ROLES_DIR } from "./paths.ts";
import { withTempLayout } from "../testing/temp-layout.ts";

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

async function seedDevOrchestrationTree(root: string): Promise<void> {
  await Deno.mkdir(join(root, "roles", "dev-only"), { recursive: true });
  await Deno.writeTextFile(
    join(root, "roles", "dev-only", "tasks.yml"),
    "- name: stub dev task\n  debug:\n    msg: hello\n",
  );
  await Deno.writeTextFile(
    join(root, DEV_CONVERGE_MANIFEST_FILE),
    JSON.stringify({
      playbook: "playbook.yml",
      roles: ["shared-role"],
      devRoles: ["dev-only"],
    }),
  );
  await Deno.writeTextFile(
    join(root, "playbook.yml"),
    "---\n- hosts: localhost\n  gather_facts: false\n",
  );
  await Deno.writeTextFile(join(root, "ansible.cfg"), "[defaults]\n");
}

function withDevOrchestrationEnv(
  fixtureRoot: string,
  extra: Record<string, string> = {},
): () => void {
  const previous = new Map<string, string | undefined>();
  const envBag: Record<string, string> = {
    TURBOPANEL_DEV_ORCHESTRATION_DIR: fixtureRoot,
    ...extra,
  };
  for (const [key, value] of Object.entries(envBag)) {
    previous.set(key, Deno.env.get(key));
    Deno.env.set(key, value);
  }
  return () => {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        Deno.env.delete(key);
      } else {
        Deno.env.set(key, value);
      }
    }
  };
}

test("resolveDevOrchestrationDir honors TURBOPANEL_DEV_ORCHESTRATION_DIR override", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await Deno.mkdir(devRoot);
    const restore = withDevOrchestrationEnv(devRoot);
    try {
      assertEquals(resolveDevOrchestrationDir(), devRoot);
      assertEquals(
        resolveDevOrchestrationDir({
          TURBOPANEL_DEV_ORCHESTRATION_DIR: devRoot,
        }),
        devRoot,
      );
    } finally {
      restore();
    }
  });
});

test("resolveDevOrchestrationDir strips trailing slashes from override", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await Deno.mkdir(devRoot);
    const restore = withDevOrchestrationEnv(`${devRoot}/`);
    try {
      assertEquals(resolveDevOrchestrationDir(), devRoot);
    } finally {
      restore();
    }
  });
});

test("readDevConvergeManifest parses a valid manifest", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await seedDevOrchestrationTree(devRoot);
    const manifest = await readDevConvergeManifest(devRoot);
    assertEquals(manifest.playbook, "playbook.yml");
    assertEquals(manifest.roles, ["shared-role"]);
    assertEquals(manifest.devRoles, ["dev-only"]);
  });
});

test("readDevConvergeManifest rejects invalid manifest shape", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await Deno.mkdir(devRoot, { recursive: true });
    await Deno.writeTextFile(
      join(devRoot, DEV_CONVERGE_MANIFEST_FILE),
      JSON.stringify({ playbook: "only-playbook.yml" }),
    );
    await assertRejects(
      () => readDevConvergeManifest(devRoot),
      TypeError,
      "Invalid dev converge manifest",
    );
  });
});

test("resolveDevOrchestrationLayout wires playbook and role paths", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await seedDevOrchestrationTree(devRoot);
    const restore = withDevOrchestrationEnv(devRoot);
    try {
      const layout = await resolveDevOrchestrationLayout();
      assertEquals(layout.root, devRoot);
      assertEquals(layout.playbookPath, join(devRoot, "playbook.yml"));
      assertEquals(layout.ansibleCfgPath, join(devRoot, "ansible.cfg"));
      assertEquals(layout.devRolesDir, join(devRoot, "roles"));
      assertEquals(layout.daemonRolesDir, GALAXY_ROLES_DIR);
    } finally {
      restore();
    }
  });
});

test("resolveDevConvergeRoleDir prefers dev overlay for devRoles", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await seedDevOrchestrationTree(devRoot);
    const layout = await resolveDevOrchestrationLayout({
      TURBOPANEL_DEV_ORCHESTRATION_DIR: devRoot,
    });
    assertEquals(
      resolveDevConvergeRoleDir(layout, "dev-only"),
      join(devRoot, "roles", "dev-only"),
    );
    assertEquals(
      resolveDevConvergeRoleDir(layout, "shared-role"),
      join(GALAXY_ROLES_DIR, "shared-role"),
    );
  });
});

test("devOrchestrationAnsibleEnv overlays dev roles ahead of daemon roles", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await seedDevOrchestrationTree(devRoot);
    const layout = await resolveDevOrchestrationLayout({
      TURBOPANEL_DEV_ORCHESTRATION_DIR: devRoot,
    });
    const env = devOrchestrationAnsibleEnv(layout);
    assertEquals(env.ANSIBLE_CONFIG, layout.ansibleCfgPath);
    assertEquals(
      env.ANSIBLE_ROLES_PATH?.startsWith(`${layout.devRolesDir}:`),
      true,
    );
    assertEquals(env.ANSIBLE_EXECUTABLE, "/bin/bash");
  });
});

test("devOrchestrationReady is false until playbook exists", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await Deno.mkdir(devRoot, { recursive: true });
    await Deno.writeTextFile(join(devRoot, "ansible.cfg"), "[defaults]\n");
    await Deno.writeTextFile(
      join(devRoot, DEV_CONVERGE_MANIFEST_FILE),
      JSON.stringify({
        playbook: "missing.yml",
        roles: [],
        devRoles: [],
      }),
    );
    const restore = withDevOrchestrationEnv(devRoot);
    try {
      assertEquals(await devOrchestrationReady(), false);
    } finally {
      restore();
    }
  });
});

test("devOrchestrationReady is true when manifest, cfg, and playbook exist", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await seedDevOrchestrationTree(devRoot);
    const restore = withDevOrchestrationEnv(devRoot);
    try {
      assertEquals(await devOrchestrationReady(), true);
    } finally {
      restore();
    }
  });
});

test("requireDevOrchestrationLayout throws when playbook is missing", async () => {
  await withTempLayout(async (fixture) => {
    const devRoot = join(fixture.dirs.configDir, "dev-orch");
    await Deno.mkdir(devRoot, { recursive: true });
    await Deno.writeTextFile(join(devRoot, "ansible.cfg"), "[defaults]\n");
    await Deno.writeTextFile(
      join(devRoot, DEV_CONVERGE_MANIFEST_FILE),
      JSON.stringify({
        playbook: "missing.yml",
        roles: [],
        devRoles: [],
      }),
    );
    const restore = withDevOrchestrationEnv(devRoot);
    try {
      await assertRejects(
        () => requireDevOrchestrationLayout(),
        Error,
        "Dev orchestration playbook missing",
      );
    } finally {
      restore();
    }
  });
});
