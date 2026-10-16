/**
 * Per-login grant mode on the daemon.
 *
 * - A login with no `grantMode` (or `preset`, or `recipe` which acts like
 *   `preset` until recipes exist) must produce exactly the SQL trunk produced
 *   before the field existed. The hashes below were captured from trunk code
 *   that had no grant-mode branch.
 * - A `self` login keeps its account, password and (Postgres) CONNECT, and the
 *   statements that reset or revoke grants are never generated.
 */
import { assertEquals } from "@std/assert";
import type { ManagedApplyCredential } from "../../contracts/commands-contracts.ts";
import { mariadbManagedEngineRuntime } from "./mariadb.ts";
import { mysqlManagedEngineRuntime } from "./mysql.ts";
import { postgresManagedEngineRuntime } from "./postgres.ts";
import type {
  ManagedEngineContext,
  ManagedEngineExec,
  ManagedEngineRuntime,
} from "./types.ts";

const test = Deno.test.bind(Deno);

/**
 * Captured from trunk before the grant-mode branches existed; the MySQL and
 * MariaDB hashes were recaptured when read/write became data-only (the
 * level SQL changed on purpose; the Postgres hash is unchanged).
 */
const GOLDEN: Record<string, string> = {
  __MARIADB__:
    "84b71e2043d6b7565c0da3fb885e3206a1dc585a63617f980ca9d1329b9c5431",
  __MYSQL__: "2795b61057d05b529380cf108471f36d3b61aa1ad737e1778efa44ae75b72a7c",
  __POSTGRES__:
    "d5357cfaad5de77daffd3a65b5e665c2a7db6913f943fee11963f0b6ab1db4cf",
};

const engines: Array<[string, ManagedEngineRuntime, string]> = [
  ["mariadb", mariadbManagedEngineRuntime, "__MARIADB__"],
  ["mysql", mysqlManagedEngineRuntime, "__MYSQL__"],
  ["postgres", postgresManagedEngineRuntime, "__POSTGRES__"],
];

async function sqlFor(
  engine: ManagedEngineRuntime,
  credentials: ManagedApplyCredential[],
): Promise<string[]> {
  const inputs: string[] = [];
  const exec: ManagedEngineExec = (_argv, input) => {
    inputs.push(input ?? "");
    return Promise.resolve({ success: true, stdout: "", stderr: "" });
  };
  const ctx: ManagedEngineContext = {
    containerId: "c1",
    composeServiceName: "svc",
    rootUsername: "root",
    defaultDatabase: "appdb",
    exec,
  };
  await engine.applyCredentials(ctx, credentials);
  return inputs;
}

function credentials(
  mode?: ManagedApplyCredential["grantMode"],
): ManagedApplyCredential[] {
  const withMode = mode === undefined ? {} : { grantMode: mode };
  return [
    {
      principalId: "p-root",
      username: "rootlogin",
      role: "root",
      databases: ["appdb"],
      password: "p1",
    },
    {
      principalId: "p-rw",
      username: "rw_user",
      role: "user",
      databases: ["appdb", "other"],
      privileges: ["read-write"],
      password: "p2",
    },
    {
      principalId: "p-ro",
      username: "ro_user",
      role: "user",
      databases: ["appdb"],
      privileges: ["read-only"],
      password: "p3",
    },
    {
      principalId: "p-hand",
      username: "hand_user",
      role: "user",
      databases: ["appdb"],
      privileges: ["read-write"],
      password: "p4",
      ...withMode,
    },
  ];
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

for (const [name, engine, goldenKey] of engines) {
  test(`${name}: no grantMode, preset and recipe give the SQL trunk gave`, async () => {
    const baseline = await sqlFor(engine, credentials());
    const hash = await sha256(JSON.stringify(baseline));
    if (Deno.env.get("CAPTURE_GRANT_MODE_GOLDEN")) {
      console.log(`GOLDEN ${goldenKey} ${hash}`);
    }
    assertEquals(hash, GOLDEN[goldenKey]);
    for (const mode of ["preset", "recipe"] as const) {
      assertEquals(await sqlFor(engine, credentials(mode)), baseline);
    }
  });
}

test("postgres self login: connect kept; no revoke, grant reset, object ACL or default privileges for it", async () => {
  const sql = (await sqlFor(
    postgresManagedEngineRuntime,
    credentials("self").filter((c) =>
      c.role !== "user" || c.username === "hand_user"
    ),
  )).join("\n");
  const own = sql.split("\n").filter((line) => line.includes(`"hand_user"`));
  assertEquals(
    own.includes(`GRANT CONNECT ON DATABASE "appdb" TO "hand_user";`),
    true,
  );
  assertEquals(sql.includes("NOSUPERUSER"), true);
  // revokeUnlistedDatabasesSql, the grantDatabaseSql pair, exactObjectAclSql
  // and the default privileges all name the login; only CONNECT may remain.
  assertEquals(
    own.filter((l) =>
      l.includes("CONNECT") === false && /REVOKE|GRANT|ALTER DEFAULT/.test(l)
    ),
    [],
  );
  assertEquals(sql.includes("pg_catalog.aclexplode(datacl) a"), true); // public revoke stays
  assertEquals(sql.includes("CREATE SCHEMA"), false);
  assertEquals(sql.includes("default_transaction_read_only"), false);
  assertEquals(sql.includes("ALTER DEFAULT PRIVILEGES"), false);
});

test("postgres: a self login beside preset logins leaves the preset logins' SQL in place", async () => {
  const mixed =
    (await sqlFor(postgresManagedEngineRuntime, credentials("self")))
      .join("\n");
  assertEquals(
    mixed.includes(`REVOKE ALL ON DATABASE "appdb" FROM "rw_user"`),
    true,
  );
  assertEquals(
    mixed.includes(`ALTER DEFAULT PRIVILEGES FOR ROLE "rw_user"`),
    true,
  );
  assertEquals(mixed.includes(`TO "hand_user"`), true);
  assertEquals(mixed.includes(`FROM "hand_user"`), false);
  assertEquals(mixed.includes(`FOR ROLE "hand_user"`), false);
  assertEquals(
    mixed.replace(`GRANT CONNECT ON DATABASE "appdb" TO "hand_user";`, "")
      .includes(`"hand_user"`.concat("") + ";"),
    false,
  );
});

for (const [name, engine] of engines.filter(([n]) => n !== "postgres")) {
  test(`${name} self login: account and password kept, no grants written`, async () => {
    const sql = (await sqlFor(engine, credentials("self"))).join("\n");
    assertEquals(sql.includes("hand_user"), true);
    assertEquals(/GRANT [^\n]* ON `appdb`\.\* TO `hand_user`/.test(sql), false);
    assertEquals(/GRANT [^\n]*TO `hand_user`/.test(sql), false);
    // Still granted for the preset login in the same payload.
    assertEquals(/GRANT [^\n]* ON `appdb`\.\* TO `rw_user`/.test(sql), true);
  });
}
