import { join } from "@std/path";
import { parse } from "yaml";
import { DAEMON_ROOT } from "./paths.ts";

const CHECKOUT_ORCHESTRATION_DIR = join(DAEMON_ROOT, "orchestration");

/**
 * Jest/Mocha-shaped alias for {@link Deno.test}.
 *
 * Sonar typescript:S2187 only recognizes `test()` / `it()` / `describe()` and
 * reports Deno suites as empty; keep this alias so analysis sees real tests.
 */
const test = Deno.test.bind(Deno);

type AccountEntry = {
  account: string;
  id: number;
  primaryGroup: string;
  defaultsFile: string;
  userVar: string;
  groupVar: string;
  uidVar: string;
  gidVar: string;
};

/** Canonical production service-account allocation (source of truth for this suite). */
const ACCOUNTS: AccountEntry[] = [
  {
    account: "tp",
    id: 9999,
    primaryGroup: "tp",
    defaultsFile: "roles/turbopanel-user/defaults/main.yml",
    userVar: "turbopanel_user",
    groupVar: "turbopanel_group",
    uidVar: "turbopanel_uid",
    gidVar: "turbopanel_gid",
  },
  {
    account: "tpctrl",
    id: 9998,
    primaryGroup: "tpctrl",
    defaultsFile: "roles/instance-user/defaults/main.yml",
    userVar: "instance_user",
    groupVar: "instance_primary_group",
    uidVar: "instance_uid",
    gidVar: "instance_primary_gid",
  },
  {
    account: "tpcaddy",
    id: 9993,
    primaryGroup: "tpcaddy",
    defaultsFile: "roles/instance-user/defaults/main.yml",
    userVar: "caddy_user",
    groupVar: "caddy_primary_group",
    uidVar: "caddy_uid",
    gidVar: "caddy_primary_gid",
  },
  {
    account: "tpcache",
    id: 9997,
    primaryGroup: "tpcache",
    defaultsFile: "roles/redis/defaults/main.yml",
    userVar: "redis_user",
    groupVar: "redis_primary_group",
    uidVar: "redis_uid",
    gidVar: "redis_primary_gid",
  },
  {
    account: "tpdata",
    id: 9996,
    primaryGroup: "tpdata",
    defaultsFile: "roles/postgres/defaults/main.yml",
    userVar: "postgres_system_user",
    groupVar: "postgres_primary_group",
    uidVar: "postgres_container_uid",
    gidVar: "postgres_container_gid",
  },
  {
    account: "tpqueue",
    id: 9995,
    primaryGroup: "tpqueue",
    defaultsFile: "roles/rabbitmq/defaults/main.yml",
    userVar: "rabbitmq_system_user",
    groupVar: "rabbitmq_primary_group",
    uidVar: "rabbitmq_container_uid",
    gidVar: "rabbitmq_container_gid",
  },
  {
    account: "tpmetrics",
    id: 9994,
    primaryGroup: "tpmetrics",
    defaultsFile: "roles/clickhouse/defaults/main.yml",
    userVar: "clickhouse_system_user",
    groupVar: "clickhouse_primary_group",
    uidVar: "clickhouse_container_uid",
    gidVar: "clickhouse_container_gid",
  },
];

const WEB_SERVICE_ACCOUNTS = [
  { key: "nginx", account: "tpnginx", id: 9992 },
  { key: "apache", account: "tpapache", id: 9991 },
  { key: "openlitespeed", account: "tpols", id: 9990 },
  { key: "litespeed", account: "tplsws", id: 9989 },
] as const;

type WebServiceMapEntry = {
  user: string;
  uid: number;
  group: string;
  gid: number;
};

function parseWebServiceUserMap(
  yaml: string,
): Record<string, WebServiceMapEntry> {
  const doc = parse(yaml) as {
    web_service_user_map?: Record<string, WebServiceMapEntry>;
  };
  const map = doc.web_service_user_map;
  if (!map || typeof map !== "object") {
    throw new TypeError(
      "web_service_user_map missing from web-service-user defaults",
    );
  }
  return map;
}

async function readRole(relPath: string): Promise<string> {
  return await Deno.readTextFile(join(CHECKOUT_ORCHESTRATION_DIR, relPath));
}

function assertMatch(value: string, pattern: RegExp, label: string): void {
  if (!pattern.test(value)) {
    throw new Error(`${label}: expected ${pattern}, got:\n${value}`);
  }
}

function elseBranchString(yaml: string, varName: string): string {
  const match = new RegExp(
    String.raw`^\s*${varName}:.*\belse\s+['"]([^'"]+)['"]`,
    "m",
  ).exec(yaml);
  if (!match) {
    throw new TypeError(
      `could not parse ${varName} else branch string from YAML`,
    );
  }
  return match[1];
}

function elseBranchInt(yaml: string, varName: string): number {
  const match = new RegExp(
    String.raw`^\s*${varName}:.*\belse\s+["']?(\d+)["']?`,
    "m",
  ).exec(yaml);
  if (!match) {
    throw new TypeError(
      `could not parse ${varName} else branch int from YAML`,
    );
  }
  return Number(match[1]);
}

test("role default production branches match canonical tp* allocation", async () => {
  for (const entry of ACCOUNTS) {
    const yaml = await readRole(entry.defaultsFile);

    const user = elseBranchString(yaml, entry.userVar);
    const group = elseBranchString(yaml, entry.groupVar);
    const uid = elseBranchInt(yaml, entry.uidVar);
    const gid = elseBranchInt(yaml, entry.gidVar);

    if (user !== entry.account) {
      throw new Error(
        `${entry.defaultsFile}: ${entry.userVar} else branch is ${user}, expected ${entry.account}`,
      );
    }
    if (group !== entry.primaryGroup) {
      throw new Error(
        `${entry.defaultsFile}: ${entry.groupVar} else branch is ${group}, expected ${entry.primaryGroup}`,
      );
    }
    if (uid !== entry.id) {
      throw new Error(
        `${entry.defaultsFile}: ${entry.uidVar} else branch is ${uid}, expected ${entry.id}`,
      );
    }
    if (gid !== entry.id) {
      throw new Error(
        `${entry.defaultsFile}: ${entry.gidVar} else branch is ${gid}, expected ${entry.id}`,
      );
    }
  }

  // turbopanel-user gates ids on turbopanel_dev_uid but the else literal is still 9999.
  // instance-user also carries turbopanel_user/turbopanel_group → tp/9999.
  const instanceUserDefaults = await readRole(
    "roles/instance-user/defaults/main.yml",
  );
  if (elseBranchString(instanceUserDefaults, "turbopanel_user") !== "tp") {
    throw new Error(
      "instance-user defaults: turbopanel_user else branch must be tp",
    );
  }
  if (elseBranchString(instanceUserDefaults, "turbopanel_group") !== "tp") {
    throw new Error(
      "instance-user defaults: turbopanel_group else branch must be tp",
    );
  }
});

test("web-service-user map pins optional web server identities", async () => {
  const yaml = await readRole("roles/web-service-user/defaults/main.yml");
  const map = parseWebServiceUserMap(yaml);

  const expectedKeys = WEB_SERVICE_ACCOUNTS.map((entry) => entry.key).sort((
    a,
    b,
  ) => a.localeCompare(b));
  const actualKeys = Object.keys(map).sort((a, b) => a.localeCompare(b));
  if (actualKeys.join(",") !== expectedKeys.join(",")) {
    throw new Error(
      `web_service_user_map keys: expected [${expectedKeys.join(", ")}], got [${
        actualKeys.join(", ")
      }]`,
    );
  }

  assertMatch(
    yaml,
    /^\s*turbopanel_group:\s*tp(?:\s+#.*)?\s*$/m,
    "web-service-user turbopanel_group default",
  );

  for (const { key, account, id } of WEB_SERVICE_ACCOUNTS) {
    const block = map[key];
    if (block.user !== account) {
      throw new Error(
        `web-service-user ${key}: user is ${block.user}, expected ${account}`,
      );
    }
    if (block.uid !== id) {
      throw new Error(
        `web-service-user ${key}: uid is ${block.uid}, expected ${id}`,
      );
    }
    if (block.group !== account) {
      throw new Error(
        `web-service-user ${key}: group is ${block.group}, expected ${account}`,
      );
    }
    if (block.gid !== id) {
      throw new Error(
        `web-service-user ${key}: gid is ${block.gid}, expected ${id}`,
      );
    }
  }
});

test("converge and web-service account ids are globally unique", async () => {
  const webServiceDefaults = await readRole(
    "roles/web-service-user/defaults/main.yml",
  );
  const webServiceMap = parseWebServiceUserMap(webServiceDefaults);

  const convergeIds = ACCOUNTS.map((entry) => entry.id);
  const webIds = Object.values(webServiceMap).map((entry) => entry.uid);
  const ids = [...convergeIds, ...webIds];

  const seen = new Set<number>();
  const collisions: number[] = [];
  for (const id of ids) {
    if (seen.has(id)) {
      collisions.push(id);
    }
    seen.add(id);
  }

  if (seen.size !== ids.length) {
    throw new Error(
      `duplicate service-account ids: ${collisions.join(", ")}`,
    );
  }
});

test("systemd units and docker wrappers bind the expected identity variables", async () => {
  const daemonUnit = await readRole(
    "roles/daemon-launch/templates/turbopaneld.service.j2",
  );
  assertMatch(
    daemonUnit,
    /User=\{\{\s*turbopanel_user\s*\}\}/,
    "turbopaneld.service User",
  );
  assertMatch(
    daemonUnit,
    /Group=\{\{\s*turbopanel_group\s*\}\}/,
    "turbopaneld.service Group",
  );

  const instanceUnit = await readRole(
    "roles/instance-launch/templates/turbopanel-instance.service.j2",
  );
  assertMatch(
    instanceUnit,
    /User=\{\{\s*instance_user\s*\}\}/,
    "turbopanel-instance.service User",
  );
  assertMatch(
    instanceUnit,
    /Group=\{\{\s*turbopanel_group\s*\}\}/,
    "turbopanel-instance.service Group",
  );

  const caddyUnit = await readRole(
    "roles/instance-launch/templates/turbopanel-caddy.service.j2",
  );
  assertMatch(
    caddyUnit,
    /User=\{\{\s*caddy_user\s*\}\}/,
    "turbopanel-caddy.service User",
  );
  assertMatch(
    caddyUnit,
    /Group=\{\{\s*turbopanel_group\s*\}\}/,
    "turbopanel-caddy.service Group",
  );

  const redisUnit = await readRole(
    "roles/redis/templates/turbopanel-redis.service.j2",
  );
  assertMatch(
    redisUnit,
    /User=\{\{\s*redis_user\s*\}\}/,
    "turbopanel-redis.service User",
  );
  assertMatch(
    redisUnit,
    /Group=\{\{\s*redis_primary_group\s*\}\}/,
    "turbopanel-redis.service Group",
  );

  // Type=oneshot docker wrappers — identity via docker run --user, not User= in the unit.
  const dockerRoles = [
    {
      role: "postgres",
      uidVar: "postgres_container_uid",
      gidVar: "postgres_container_gid",
    },
    {
      role: "rabbitmq",
      uidVar: "rabbitmq_container_uid",
      gidVar: "rabbitmq_container_gid",
    },
    {
      role: "clickhouse",
      uidVar: "clickhouse_container_uid",
      gidVar: "clickhouse_container_gid",
    },
  ] as const;

  for (const { role, uidVar, gidVar } of dockerRoles) {
    const tasks = await readRole(`roles/${role}/tasks/main.yml`);
    const userPattern = new RegExp(
      String
        .raw`"--user"\s*\n\s*-\s*"\{\{\s*${uidVar}\s*\}\}:\{\{\s*${gidVar}\s*\}\}"`,
    );
    assertMatch(
      tasks,
      userPattern,
      `${role} docker run --user`,
    );
  }
});

test("orchestration roles do not import identity-cutover tasks", async () => {
  const rolesDir = join(CHECKOUT_ORCHESTRATION_DIR, "roles");
  for await (const entry of Deno.readDir(rolesDir)) {
    if (!entry.isDirectory) continue;
    const mainPath = join(rolesDir, entry.name, "tasks", "main.yml");
    let body: string;
    try {
      body = await Deno.readTextFile(mainPath);
    } catch {
      continue;
    }
    if (body.includes("identity-cutover.yml")) {
      throw new TypeError(
        `${entry.name}/tasks/main.yml must not import identity-cutover.yml`,
      );
    }
  }
});

test("orchestration roles forbid retired turbopanel* service identity fallbacks", async () => {
  const retiredPatterns = [
    {
      label: "turbopaneli service identity fallback",
      re: /\belse\s+['"]turbopaneli['"]|\bdefault\(\s*['"]turbopaneli['"]\s*\)/,
    },
    {
      label: "turbopanelc service identity fallback",
      re: /\belse\s+['"]turbopanelc['"]|\bdefault\(\s*['"]turbopanelc['"]\s*\)/,
    },
    {
      label: "turbopanel service identity fallback",
      re: /\belse\s+['"]turbopanel['"]|\bdefault\(\s*['"]turbopanel['"]\s*\)/,
    },
  ];

  const rolesDir = join(CHECKOUT_ORCHESTRATION_DIR, "roles");
  for await (const entry of Deno.readDir(rolesDir)) {
    if (!entry.isDirectory) continue;
    const tasksDir = join(rolesDir, entry.name, "tasks");
    for await (const taskEntry of Deno.readDir(tasksDir)) {
      if (!taskEntry.isFile || !taskEntry.name.endsWith(".yml")) continue;
      const rel = `roles/${entry.name}/tasks/${taskEntry.name}`;
      const body = await Deno.readTextFile(join(tasksDir, taskEntry.name));
      for (const { label, re } of retiredPatterns) {
        if (re.test(body)) {
          throw new TypeError(`${rel} uses retired ${label}`);
        }
      }
    }
  }
});
