/**
 * Every place the daemon asks root for something, with what it really sends.
 *
 * The daemon reaches root only through `sudo -n …` argvs built at the call
 * sites that pass them through {@link hostSudoArgs}. On a managed host those
 * argvs land in `tp-host` (orchestration/scripts/tp-host), which accepts a
 * fixed set of shapes, or — for the few commands tp-host does not implement —
 * straight in sudo, where `/etc/sudoers.d/tp` must allow them. Each side had
 * its own tests; the seam between them did not, and a daemon argv one element
 * off from what tp-host expected (the ACME certificate `find`) or a group
 * name tp-host does not know silently broke a feature on every host.
 *
 * `tp-host-callsites.test.ts` scans the source for every hostSudoArgs
 * call and fails when one is missing here (so a new call site cannot land
 * without a sample), then runs each `tpHost` sample through the real tp-host
 * in its test mode and matches each `sudo` sample against the rendered
 * sudoers file.
 *
 * Keys are `<file>|<argument text>` with comments and whitespace removed and
 * trailing commas dropped — the test's scanner produces them. Samples are the
 * argv after `-n`, with `{P}` standing for tp-host's test prefix (the host's
 * `/`). Values are what production passes: real unit names, real layout
 * paths under `/etc/turbopanel`, `/var/lib/turbopanel`, `/srv/users`, … .
 */

import { cronTimerContent, cronTimerPath } from "../deploy/cron/unit.ts";
import { caddyUnit } from "../deploy/ingress.ts";
import { nativeAppUnitContent } from "../deploy/native/unit.ts";
import { resolveLayout } from "../paths/layout.ts";

/** A path tp-host's test harness must create before the sample runs. */
export type CallSiteSetup = {
  /** Directories to create (with parents). */
  dirs?: string[];
  /** Files to create, `path → contents`. */
  files?: Record<string, string>;
  /** Symlinks to create, `[target, path]`. */
  links?: Array<[string, string]>;
  /** `/etc/group` lines to add. */
  groups?: string[];
};

export type TpHostSample = {
  argv: string[];
  stdin?: string;
  setup?: CallSiteSetup;
};

export type SudoSample = {
  /** `sudo -u <runas>`; root when omitted. */
  runas?: string;
  /** The command and its arguments, absolute paths as on a managed host. */
  argv: string[];
};

export type CallSite =
  & { key: string; knownBug?: string }
  & (
    | { via: "tp-host"; samples: TpHostSample[] }
    | { via: "sudo"; samples: SudoSample[] }
  );

const P = "{P}";
const UNITS = `${P}/etc/systemd/system`;
const CONF = `${P}/etc/turbopanel`;
const STATE = `${P}/var/lib/turbopanel`;
const HOME = `${P}/srv/users/alice`;
const SITE = `${HOME}/sites/svc1`;
const RELEASE = `${SITE}/releases/20260927-120000`;
const STAGED = `${P}/tmp/staged`;
const SSH_KEYS = `${P}/etc/ssh/turbopanel/authorized_keys`;
const DROP_IN = `${P}/etc/ssh/sshd_config.d/60-turbopanel.conf`;
const ACME_CERTS = `${STATE}/instance-acme/caddy/certificates`;
const ACME_CERT =
  `${ACME_CERTS}/acme-v02.api.letsencrypt.org-directory/panel.example.com/panel.example.com.crt`;
const CADDY_BIN = `${P}/opt/turbopanel/vendor/caddy/2.11.4/caddy`;
const NGINX_CONF = `${CONF}/nginx/sites/svc1.conf`;

/** What the harness writes to {@link STAGED}. */
export const STAGED_CONTENT = "staged content\n";

/**
 * Unit text as the daemon renders it for a production layout, with the
 * managed roots moved under `{P}` (tp-host checks some exec paths exactly).
 */
const LAYOUT = resolveLayout({}, {
  skipDiscovery: true,
  forceMode: "production",
});
const underPrefix = (text: string) =>
  ["/opt/turbopanel", "/etc/turbopanel", "/var/lib/turbopanel", "/srv/users"]
    .reduce((out, root) => out.replaceAll(root, `${P}${root}`), text);
const CRON = {
  layout: LAYOUT,
  environmentId: "env1",
  composeServiceName: "web",
  username: "alice",
  workingDirectory: "/srv/users/alice/sites/svc1/current",
  job: { name: "backup", schedule: "*-*-* 03:00:00", command: ["/bin/true"] },
};
const CRON_TIMER = cronTimerPath(
  { ...CRON, jobName: CRON.job.name },
  UNITS,
);
const unitSetup = (text: string): CallSiteSetup => ({
  files: { [STAGED]: underPrefix(text) },
});

/** tp-host's `-n <verb> …` samples for one call-site key. */
function tpHost(key: string, ...samples: TpHostSample[]): CallSite {
  return { key, via: "tp-host", samples };
}

/** Samples that bypass tp-host and must match a sudoers rule. */
function sudo(key: string, ...samples: SudoSample[]): CallSite {
  return { key, via: "sudo", samples };
}

const file = (path: string, contents = "x\n"): CallSiteSetup => ({
  files: { [path]: contents },
});
const dir = (...paths: string[]): CallSiteSetup => ({ dirs: paths });

const SITES: CallSite[] = [
  // --- commands -------------------------------------------------------------
  tpHost(
    'src/commands/fabric.ts|["-n",cmd,...args]',
    { argv: ["ip", "link", "set", "dev", "tp0", "up"] },
    { argv: ["ip", "-o", "-4", "addr", "show", "dev", "tp0"] },
    { argv: ["wg", "show", "tp0", "dump"] },
  ),
  tpHost('src/commands/reboot.ts|["-n","systemctl","reboot"]', {
    argv: ["systemctl", "reboot"],
  }),
  tpHost('src/commands/stop-environment.ts|["-n","rm","-rf","--",path]', {
    argv: ["rm", "-rf", "--", SITE],
    setup: dir(SITE),
  }),

  // --- cron -----------------------------------------------------------------
  tpHost(
    'src/deploy/cron/apply.ts|["-n","systemctl",...args]',
    { argv: ["systemctl", "daemon-reload"] },
    {
      argv: [
        "systemctl",
        "enable",
        "--now",
        "turbopanel-cron-svc1-backup.timer",
      ],
    },
    {
      argv: [
        "systemctl",
        "disable",
        "--now",
        "turbopanel-cron-svc1-backup.timer",
      ],
    },
  ),
  tpHost('src/deploy/cron/apply.ts|["-n","cmp","-s","--",staged,path]', {
    argv: [
      "cmp",
      "-s",
      "--",
      STAGED,
      `${UNITS}/turbopanel-cron-svc1-backup.service`,
    ],
    setup: file(`${UNITS}/turbopanel-cron-svc1-backup.service`, STAGED_CONTENT),
  }),
  tpHost(
    'src/deploy/cron/apply.ts|["-n","install","-m","0644","-o","root","-g","root",staged,path]',
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        CRON_TIMER,
      ],
      setup: unitSetup(cronTimerContent(CRON)),
    },
  ),
  tpHost('src/deploy/cron/apply.ts|["-n","ls","-1","--",unitDir]', {
    argv: ["ls", "-1", "--", UNITS],
  }),
  tpHost(
    'src/deploy/cron/apply.ts|["-n","rm","-f","--",join(unitDir,`${unit}${suffix}`)]',
    { argv: ["rm", "-f", "--", `${UNITS}/turbopanel-cron-svc1-backup.timer`] },
  ),

  // --- hosting Caddy --------------------------------------------------------
  tpHost(
    'src/deploy/ensure-hosting-caddy.ts|["-n","chown","root:turbopanel",binPath]',
    { argv: ["chown", "root:turbopanel", CADDY_BIN], setup: file(CADDY_BIN) },
  ),

  // --- principals -----------------------------------------------------------
  tpHost('src/deploy/ensure-principal.ts|["-n","setfacl","-m","o::x",path]', {
    argv: ["setfacl", "-m", "o::x", `${P}/srv/users`],
  }),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","install","-d","-m",mode,"-o",user,"-g",group,path]',
    {
      argv: [
        "install",
        "-d",
        "-m",
        "0750",
        "-o",
        "alice",
        "-g",
        "alice-grp",
        `${HOME}/sites`,
      ],
    },
  ),
  tpHost(
    "src/deploy/ensure-principal.ts|args",
    {
      argv: [
        "groupadd",
        "-K",
        "GID_MIN=15001",
        "-K",
        "GID_MAX=60000",
        "bob-grp",
      ],
    },
    { argv: ["groupadd", "-g", "15002", "bob-grp"] },
    {
      argv: [
        "useradd",
        "-K",
        "UID_MIN=15001",
        "-K",
        "UID_MAX=60000",
        "-g",
        "bob-grp",
        "-d",
        `${P}/srv/users/bob`,
        "-M",
        "-s",
        "/bin/bash",
        "bob",
      ],
      // The groupadd sample above runs first.
      setup: { groups: ["bob-grp:x:15002:"] },
    },
  ),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","usermod","-s",shell,principal.username]',
    { argv: ["usermod", "-s", "/usr/sbin/nologin", "alice"] },
  ),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","getent","shadow","--",username]',
    {
      argv: ["getent", "shadow", "--", "alice"],
    },
  ),
  tpHost('src/deploy/ensure-principal.ts|["-n","chpasswd","-e"]', {
    argv: ["chpasswd", "-e"],
    // A crypt(3) SHA-512 shape, assembled so no hash literal sits in source.
    stdin: `alice:${["", "6", "salt", "hash"].join("$")}\n`,
  }),
  tpHost('src/deploy/ensure-principal.ts|["-n","usermod","-p","!",username]', {
    argv: ["usermod", "-p", "!", "alice"],
  }),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","usermod","-aG",groupName,user]',
    {
      argv: ["usermod", "-aG", "tpsftp", "alice"],
    },
  ),
  tpHost(
    'src/deploy/ensure-principal.ts|["-n","gpasswd","-d",user,groupName]',
    {
      argv: ["gpasswd", "-d", "alice", "tpsftp"],
    },
  ),
  tpHost('src/deploy/ensure-principal.ts|["-n","chown",owner,path]', {
    argv: ["chown", "alice:alice-grp", `${HOME}/sites`],
    setup: dir(`${HOME}/sites`),
  }),

  // --- hosting ingress ------------------------------------------------------
  tpHost(
    'src/deploy/ingress.ts|["-n","install","-m","0640",unitSource,join("/etc/systemd/system",CADDY_SERVICE)]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        STAGED,
        `${UNITS}/turbopanel-hosting-caddy.service`,
      ],
      setup: unitSetup(caddyUnit(LAYOUT)),
    },
  ),
  tpHost('src/deploy/ingress.ts|["-n","systemctl","daemon-reload"]', {
    argv: ["systemctl", "daemon-reload"],
  }),
  tpHost(
    'src/deploy/ingress.ts|["-n","systemctl","enable","--now",CADDY_SERVICE]',
    {
      argv: [
        "systemctl",
        "enable",
        "--now",
        "turbopanel-hosting-caddy.service",
      ],
    },
  ),
  tpHost('src/deploy/ingress.ts|["-n","systemctl","reload",CADDY_SERVICE]', {
    argv: ["systemctl", "reload", "turbopanel-hosting-caddy.service"],
  }),

  // --- control-plane Let's Encrypt ------------------------------------------
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","reload",CONTROL_PLANE_CADDY_SERVICE]',
    { argv: ["systemctl", "reload", "turbopanel-caddy.service"] },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","ss","-H","-ltnp","sport=:80"]',
    {
      argv: ["ss", "-H", "-ltnp", "sport = :80"],
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","reload",HOSTING_CADDY_SERVICE]',
    { argv: ["systemctl", "reload", "turbopanel-hosting-caddy.service"] },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","enable","--now",HOSTING_CADDY_SERVICE]',
    {
      argv: [
        "systemctl",
        "enable",
        "--now",
        "turbopanel-hosting-caddy.service",
      ],
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","disable","--now",HOSTING_CADDY_SERVICE]',
    {
      argv: [
        "systemctl",
        "disable",
        "--now",
        "turbopanel-hosting-caddy.service",
      ],
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","start",INSTANCE_ACME_SERVICE]',
    { argv: ["systemctl", "start", "turbopanel-instance-acme.service"] },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","systemctl","stop",INSTANCE_ACME_SERVICE]',
    { argv: ["systemctl", "stop", "turbopanel-instance-acme.service"] },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","install","-m",modeText(mode),"-o","root","-g",INSTANCE_ACME_CERT_GROUP,"--",staged,dest]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "tp",
        "--",
        STAGED,
        `${CONF}/tls/instance-acme/panel.example.com.crt`,
      ],
      // The daemon creates the directory first (as itself).
      setup: dir(`${CONF}/tls/instance-acme`),
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","chown",`:${INSTANCE_ACME_CERT_GROUP}`,dest]',
    {
      argv: ["chown", ":tp", `${CONF}/tls/instance-acme/panel.example.com.key`],
      setup: file(`${CONF}/tls/instance-acme/panel.example.com.key`),
    },
  ),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","chmod",modeText(mode),dest]',
    {
      argv: [
        "chmod",
        "0600",
        `${CONF}/tls/instance-acme/panel.example.com.key`,
      ],
      setup: file(`${CONF}/tls/instance-acme/panel.example.com.key`),
    },
  ),
  tpHost('src/deploy/instance-acme-http01.ts|["-n","cat","--",path]', {
    argv: ["cat", "--", ACME_CERT],
    setup: file(ACME_CERT),
  }),
  tpHost("src/deploy/instance-acme-http01.ts|[...args]", {
    // issuedCertificateFindArgs: where Caddy stored the issued pair.
    argv: [
      "find",
      ACME_CERTS,
      "-mindepth",
      "3",
      "-maxdepth",
      "3",
      "-type",
      "f",
      "-name",
      "panel.example.com.crt",
    ],
    setup: file(ACME_CERT),
  }),
  tpHost('src/deploy/instance-acme-http01.ts|["-n","tee",path]', {
    argv: ["tee", `${CONF}/instance-acme/Caddyfile`],
    stdin: "{\n}\n",
    setup: dir(`${CONF}/instance-acme`),
  }),
  tpHost(
    'src/deploy/instance-acme-http01.ts|["-n","chown",`root:${INSTANCE_ACME_CERT_GROUP}`,path]',
    {
      argv: ["chown", "root:tp", `${CONF}/instance-acme/Caddyfile`],
      setup: file(`${CONF}/instance-acme/Caddyfile`),
    },
  ),
  tpHost('src/deploy/instance-acme-http01.ts|["-n","chmod","0640",path]', {
    argv: ["chmod", "0640", `${CONF}/instance-acme/Caddyfile`],
    setup: file(`${CONF}/instance-acme/Caddyfile`),
  }),

  // --- native apps ----------------------------------------------------------
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","cmp","-s","--",stagedPath,installedPath]',
    {
      argv: [
        "cmp",
        "-s",
        "--",
        STAGED,
        `${UNITS}/turbopanel-app-svc1.service`,
      ],
      setup: file(`${UNITS}/turbopanel-app-svc1.service`, STAGED_CONTENT),
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","install","-m","0644","-o","root","-g","root",params.stagedPath,params.installedPath]',
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        `${UNITS}/turbopanel-app-svc1.service`,
      ],
      setup: unitSetup(
        nativeAppUnitContent({
          layout: LAYOUT,
          app: {
            composeServiceName: "api",
            serviceId: "svc1",
            listenPort: 4100,
            framework: "node",
          },
          username: "alice",
          environmentId: "env1",
        }),
      ),
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","systemctl",...args]',
    { argv: ["systemctl", "restart", "turbopanel-app-svc1.service"] },
    {
      argv: [
        "systemctl",
        "is-active",
        "--quiet",
        "turbopanel-app-svc1.service",
      ],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","journalctl",`--unit=${unit}`,"-n",String(NATIVE_APP_JOURNAL_TAIL),"--no-pager","--output=short-iso"]',
    {
      argv: [
        "journalctl",
        "--unit=turbopanel-app-svc1.service",
        "-n",
        "80",
        "--no-pager",
        "--output=short-iso",
      ],
    },
  ),
  tpHost(
    'src/deploy/native/apply-native-apps.ts|["-n","rm","-f","--",nativeAppUnitPath(serviceId,deps?.systemdUnitDir)]',
    { argv: ["rm", "-f", "--", `${UNITS}/turbopanel-app-svc1.service`] },
  ),

  // --- release promotion ----------------------------------------------------
  tpHost('src/deploy/release/promote.ts|["-n","mkdir","-p","--",to]', {
    argv: ["mkdir", "-p", "--", RELEASE],
  }),
  tpHost('src/deploy/release/promote.ts|["-n","cp","-a","--",`${from}/.`,to]', {
    argv: ["cp", "-a", "--", `${STATE}/builds/svc1/.`, RELEASE],
    setup: {
      files: { [`${STATE}/builds/svc1/index.html`]: "<h1>hi</h1>\n" },
      dirs: [RELEASE],
    },
  }),
  tpHost(
    'src/deploy/release/promote.ts|["-n","rm","-rf","--",join(to,".git")]',
    {
      argv: ["rm", "-rf", "--", `${RELEASE}/.git`],
      setup: dir(`${RELEASE}/.git`),
    },
  ),
  tpHost('src/deploy/release/promote.ts|["-n","mkdir","-p","--",destDir]', {
    argv: ["mkdir", "-p", "--", `${RELEASE}/config`],
  }),
  tpHost(
    'src/deploy/release/promote.ts|["-n","install","-m","0640","-o","root","-g","root","--",staged,dest]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "root",
        "--",
        STAGED,
        `${RELEASE}/config/app.env`,
      ],
      setup: dir(`${RELEASE}/config`),
    },
  ),
  tpHost('src/deploy/release/promote.ts|["-n","test","-e",currentLink]', {
    argv: ["test", "-e", `${SITE}/current`],
    setup: {
      dirs: [RELEASE],
      links: [["releases/20260927-120000", `${SITE}/current`]],
    },
  }),
  tpHost('src/deploy/release/promote.ts|["-n","test","-L",currentLink]', {
    argv: ["test", "-L", `${SITE}/current`],
    setup: {
      dirs: [RELEASE],
      links: [["releases/20260927-120000", `${SITE}/current`]],
    },
  }),
  tpHost('src/deploy/release/promote.ts|["-n","readlink","--",currentLink]', {
    argv: ["readlink", "--", `${SITE}/current`],
    setup: {
      dirs: [RELEASE],
      links: [["releases/20260927-120000", `${SITE}/current`]],
    },
  }),
  tpHost('src/deploy/release/promote.ts|["-n","rm","-f","--",tmpLink]', {
    argv: ["rm", "-f", "--", `${SITE}/current.tmp`],
    setup: dir(SITE),
  }),
  tpHost('src/deploy/release/promote.ts|["-n","ln","-s","--",target,tmpLink]', {
    argv: ["ln", "-s", "--", "releases/20260927-120000", `${SITE}/current.tmp`],
    setup: dir(RELEASE),
  }),
  tpHost(
    'src/deploy/release/promote.ts|["-n","mv","-Tf","--",tmpLink,currentLink]',
    {
      argv: ["mv", "-Tf", "--", `${SITE}/current.tmp`, `${SITE}/current`],
      setup: {
        dirs: [RELEASE],
        links: [["releases/20260927-120000", `${SITE}/current.tmp`]],
      },
    },
  ),
  tpHost('src/deploy/release/promote.ts|["-n","test","-e",path]', {
    argv: ["test", "-e", `${SITE}/shared`],
    setup: dir(`${SITE}/shared`),
  }),
  tpHost('src/deploy/release/promote.ts|["-n","rm","-rf","--",linkPath]', {
    argv: ["rm", "-rf", "--", `${RELEASE}/storage`],
    setup: dir(`${RELEASE}/storage`),
  }),
  tpHost(
    'src/deploy/release/promote.ts|["-n","ln","-s","--",RELEASE_SHARED_LINK_TARGET,linkPath]',
    {
      argv: ["ln", "-s", "--", "../../shared", `${RELEASE}/shared`],
      setup: dir(RELEASE, `${SITE}/shared`),
    },
  ),
  tpHost(
    'src/deploy/release/release-layout.ts|["-n","chown","-R",owner,releaseDir]',
    {
      argv: ["chown", "-R", "alice:alice-grp", RELEASE],
      setup: dir(RELEASE),
    },
  ),
  tpHost(
    'src/deploy/release/release-layout.ts|["-n","chmod",mode,releaseDir]',
    {
      argv: ["chmod", "0750", RELEASE],
      setup: dir(RELEASE),
    },
  ),
  tpHost(
    'src/deploy/release/release-layout.ts|["-n","rm","-rf","--",releaseDir]',
    {
      argv: ["rm", "-rf", "--", RELEASE],
      setup: dir(RELEASE),
    },
  ),
  tpHost('src/deploy/release/retention.ts|["-n","ls","-1t","--",releasesDir]', {
    argv: ["ls", "-1t", "--", `${SITE}/releases`],
    setup: dir(RELEASE),
  }),
  tpHost('src/deploy/release/retention.ts|["-n","rm","-rf","--",path]', {
    argv: ["rm", "-rf", "--", RELEASE],
    setup: dir(RELEASE),
  }),

  // --- sites ----------------------------------------------------------------
  tpHost(
    'src/deploy/site.ts|["-n","install","-d","-m","0750","-o","root","-g",group,metaDir]',
    {
      argv: [
        "install",
        "-d",
        "-m",
        "0750",
        "-o",
        "root",
        "-g",
        "alice-grp",
        `${SITE}/meta`,
      ],
    },
  ),
  tpHost(
    'src/deploy/site.ts|["-n","install","-m","0640","-o","root","-g",group,staged,target]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "alice-grp",
        STAGED,
        `${SITE}/meta/robots.txt`,
      ],
      setup: dir(`${SITE}/meta`),
    },
  ),
  tpHost(
    'src/deploy/site.ts|["-n","install","-d","-m","0750","-o","root","-g","tpols",path]',
    {
      argv: [
        "install",
        "-d",
        "-m",
        "0750",
        "-o",
        "root",
        "-g",
        "tpols",
        `${CONF}/openlitespeed/vhosts/svc1`,
      ],
    },
  ),
  tpHost('src/deploy/site.ts|["-n","rm","-f",path]', {
    argv: ["rm", "-f", `${CONF}/php/8.4/pool.d/svc1.conf`],
  }),
  tpHost('src/deploy/site.ts|["-n","chown","-R",`${user}:${group}`,base]', {
    argv: ["chown", "-R", "alice:alice-grp", `${SITE}/webroot`],
    setup: dir(`${SITE}/webroot`),
  }),
  tpHost('src/deploy/site.ts|["-n","chmod","-R","u=rwX,g=rX,o=",base]', {
    argv: ["chmod", "-R", "u=rwX,g=rX,o=", `${SITE}/webroot`],
    setup: dir(`${SITE}/webroot`),
  }),
  tpHost(
    'src/deploy/site.ts|["-n","find",base,"-type","d","-exec","chmod","g+s","{}","+"]',
    {
      argv: [
        "find",
        `${SITE}/webroot`,
        "-type",
        "d",
        "-exec",
        "chmod",
        "g+s",
        "{}",
        "+",
      ],
      setup: dir(`${SITE}/webroot`),
    },
  ),
  tpHost('src/deploy/site.ts|["-n","ls","-A","--",documentRoot]', {
    argv: ["ls", "-A", "--", `${SITE}/webroot`],
    setup: dir(`${SITE}/webroot`),
  }),
  tpHost(
    'src/deploy/site.ts|["-n","install","-m","0640","-o",userasstring,"-g",groupasstring,staged,join(documentRoot,"index.html")]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "alice",
        "-g",
        "alice-grp",
        STAGED,
        `${SITE}/webroot/index.html`,
      ],
      setup: dir(`${SITE}/webroot`),
    },
  ),
  tpHost('src/deploy/site.ts|["-n","systemctl","disable","--now",unit]', {
    argv: ["systemctl", "disable", "--now", "turbopanel-php-fpm@8.4.service"],
  }),
  tpHost('src/deploy/site.ts|["-n","rm","-rf",vhostDir]', {
    argv: ["rm", "-rf", `${CONF}/openlitespeed/vhosts/svc1`],
    setup: dir(`${CONF}/openlitespeed/vhosts/svc1`),
  }),

  // --- web engine configs ---------------------------------------------------
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","cmp","-s","--",stagedPath,configPath]',
    {
      argv: ["cmp", "-s", "--", `${NGINX_CONF}.tmp`, NGINX_CONF],
      setup: {
        files: { [`${NGINX_CONF}.tmp`]: "a\n", [NGINX_CONF]: "a\n" },
      },
    },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","install","-m","0640","-o","root","-g",group,tmp,configPath]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "tpnginx",
        `${NGINX_CONF}.tmp`,
        NGINX_CONF,
      ],
      setup: file(`${NGINX_CONF}.tmp`),
    },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","install","-m","0640","-o","root","-g",group,tmp,candidatePath]',
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "root",
        "-g",
        "tpnginx",
        `${NGINX_CONF}.tmp`,
        `${NGINX_CONF}.candidate`,
      ],
      setup: file(`${NGINX_CONF}.tmp`),
    },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","cp","-p","--",configPath,previousPath]',
    {
      argv: ["cp", "-p", "--", NGINX_CONF, `${NGINX_CONF}.previous`],
      setup: file(NGINX_CONF),
    },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","mv","-f","--",staged.candidatePath,staged.path]',
    {
      argv: ["mv", "-f", "--", `${NGINX_CONF}.candidate`, NGINX_CONF],
      setup: file(`${NGINX_CONF}.candidate`),
    },
  ),
  tpHost('src/deploy/site/engine-driver.ts|["-n","rm","-f","--",path]', {
    argv: ["rm", "-f", "--", `${NGINX_CONF}.candidate`],
  }),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","mv","-f","--",staged.previousPath,staged.path]',
    {
      argv: ["mv", "-f", "--", `${NGINX_CONF}.previous`, NGINX_CONF],
      setup: file(`${NGINX_CONF}.previous`),
    },
  ),
  tpHost('src/deploy/site/engine-driver.ts|["-n","rm","-f","--",staged.path]', {
    argv: ["rm", "-f", "--", NGINX_CONF],
  }),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","systemctl",action,unit]',
    { argv: ["systemctl", "reload", "turbopanel-nginx"] },
    { argv: ["systemctl", "restart", "turbopanel-php-fpm@8.4"] },
  ),
  tpHost(
    'src/deploy/site/engine-driver.ts|["-n","systemctl","enable","--now",unit]',
    {
      argv: ["systemctl", "enable", "--now", "turbopanel-nginx"],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n","-u","tpnginx","--",nginxBinaryPath(layout),"-t","-c",nginxMainConfigPath(layout)]',
    {
      runas: "tpnginx",
      argv: [
        "/opt/turbopanel/vendor/nginx/1.28.0/sbin/nginx",
        "-t",
        "-c",
        "/etc/turbopanel/nginx/nginx.conf",
      ],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n",apacheBinaryPath(layout),"-t","-f",apacheMainConfigPath(layout)]',
    {
      argv: [
        "/opt/turbopanel/vendor/apache/current/bin/httpd",
        "-t",
        "-f",
        "/etc/turbopanel/apache/httpd.conf",
      ],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n","-u","tpols","--",openlitespeedBinaryPath(layout),"-t","-c",openlitespeedMainConfigPath(layout)]',
    {
      runas: "tpols",
      argv: [
        "/opt/turbopanel/vendor/openlitespeed/1.8.3/bin/openlitespeed",
        "-t",
        "-c",
        "/etc/turbopanel/openlitespeed/httpd_config.conf",
      ],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n","-u","tpcaddysite","--","env",`XDG_DATA_HOME=${siteCaddyDataDir(layout)}`,siteCaddyBinaryPath(layout),"validate","--adapter","caddyfile","--config",siteCaddyMainConfigPath(layout)]',
    {
      runas: "tpcaddysite",
      argv: [
        "/usr/bin/env",
        "XDG_DATA_HOME=/var/lib/turbopanel/site-caddy",
        "/opt/turbopanel/vendor/caddy/2.11.4/caddy",
        "validate",
        "--adapter",
        "caddyfile",
        "--config",
        "/etc/turbopanel/site-caddy/Caddyfile",
      ],
    },
  ),
  sudo(
    'src/deploy/site/engine-driver.ts|["-n",phpFpmBinaryPath(series),"--fpm-config",phpFpmMainConfigPath(layout,series),"--test"]',
    {
      argv: [
        "/usr/sbin/php-fpm8.4",
        "--fpm-config",
        "/etc/turbopanel/php/8.4/php-fpm.conf",
        "--test",
      ],
    },
  ),

  // --- SSH ------------------------------------------------------------------
  tpHost('src/deploy/ssh/apply.ts|["-n","cat","--",path]', {
    argv: ["cat", "--", `${SSH_KEYS}/alice`],
    setup: file(`${SSH_KEYS}/alice`, "ssh-ed25519 AAAA alice\n"),
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","cmp","-s","--",staged,path]', {
    argv: ["cmp", "-s", "--", STAGED, `${SSH_KEYS}/alice`],
    setup: file(`${SSH_KEYS}/alice`, STAGED_CONTENT),
  }),
  tpHost(
    'src/deploy/ssh/apply.ts|["-n","install","-m",mode,"-o","root","-g","root",staged,path]',
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        `${SSH_KEYS}/alice`,
      ],
    },
    {
      argv: [
        "install",
        "-m",
        "0644",
        "-o",
        "root",
        "-g",
        "root",
        STAGED,
        DROP_IN,
      ],
    },
  ),
  tpHost('src/deploy/ssh/apply.ts|["-n","ls","-1","--",dir]', {
    argv: ["ls", "-1", "--", SSH_KEYS],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","rm","-f","--",`${dir}/${name}`]', {
    argv: ["rm", "-f", "--", `${SSH_KEYS}/bob`],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","sshd","-t"]', {
    argv: ["sshd", "-t"],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","systemctl","reload",unit]', {
    argv: ["systemctl", "reload", "ssh.service"],
  }),
  tpHost(
    'src/deploy/ssh/apply.ts|["-n","install","-d","-m","0750","-o","root","-g","root",dir]',
    {
      argv: [
        "install",
        "-d",
        "-m",
        "0750",
        "-o",
        "root",
        "-g",
        "root",
        SSH_KEYS,
      ],
    },
  ),
  tpHost('src/deploy/ssh/apply.ts|["-n","cp","-p","--",dropInPath,backup]', {
    argv: ["cp", "-p", "--", DROP_IN, `${DROP_IN}.tpprev`],
    setup: file(DROP_IN),
  }),
  tpHost(
    'src/deploy/ssh/apply.ts|["-n","install","-d","-m","0755","-o","root","-g","root",dirname(dropInPath)]',
    {
      argv: [
        "install",
        "-d",
        "-m",
        "0755",
        "-o",
        "root",
        "-g",
        "root",
        `${P}/etc/ssh/sshd_config.d`,
      ],
    },
  ),
  tpHost('src/deploy/ssh/apply.ts|["-n","rm","-f","--",backup]', {
    argv: ["rm", "-f", "--", `${DROP_IN}.tpprev`],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","rm","-f","--",dropInPath]', {
    argv: ["rm", "-f", "--", DROP_IN],
  }),
  tpHost('src/deploy/ssh/apply.ts|["-n","mv","-f","--",backup,dropInPath]', {
    argv: ["mv", "-f", "--", `${DROP_IN}.tpprev`, DROP_IN],
    setup: file(`${DROP_IN}.tpprev`),
  }),

  // --- firewall -------------------------------------------------------------
  tpHost(
    'src/firewall/run.ts|["-n",cmd,...finalArgs]',
    { argv: ["iptables", "-w", "5", "-S", "INPUT"] },
    { argv: ["ip6tables", "-w", "5", "-S", "INPUT"] },
    { argv: ["iptables-save", "-w", "5", "-t", "filter"] },
    {
      argv: ["iptables-restore", "-w", "5", "--noflush"],
      stdin: "*filter\nCOMMIT\n",
    },
  ),
  tpHost('src/managed/firewall.ts|["-n","iptables",...args]', {
    argv: [
      "iptables",
      "-w",
      "5",
      "-C",
      "INPUT",
      "-p",
      "tcp",
      "--dport",
      "5432",
      "-j",
      "ACCEPT",
    ],
  }),

  // --- control-plane settings and the co-located daemon --------------------
  tpHost(
    'src/instance/public-urls-env.ts|["-n",...args]',
    {
      argv: ["install", "-d", "-m", "0750", `${CONF}/instance`],
    },
    {
      argv: [
        "install",
        "-m",
        "0640",
        "-o",
        "0",
        "-g",
        "9999",
        STAGED,
        `${CONF}/instance/runtime.env`,
      ],
      // The `install -d` sample above runs first.
      setup: dir(`${CONF}/instance`),
    },
    {
      argv: ["chown", "0:9999", `${CONF}/instance/runtime.env`],
      setup: file(`${CONF}/instance/runtime.env`),
    },
  ),
  tpHost(
    "src/instance/restart-daemon-service.ts|args",
    { argv: ["systemctl", "enable", "turbopaneld.service"] },
    { argv: ["systemctl", "restart", "turbopaneld.service"] },
  ),
  tpHost(
    "src/instance/run-reconcile.ts|args",
    { argv: ["systemctl", "restart", "turbopanel-instance.service"] },
    { argv: ["systemctl", "restart", "turbopanel-caddy.service"] },
    { argv: ["systemctl", "reload", "turbopanel-caddy.service"] },
  ),
  sudo(
    'src/instance/run-reconcile.ts|["-n","--",ORCHESTRATE_HELPER,"migrate"]',
    {
      argv: [
        "/opt/turbopanel/share/orchestration/scripts/tp-orchestrate",
        "migrate",
      ],
    },
  ),

  // --- metrics ------------------------------------------------------------
  sudo(
    'src/metrics/collector/sensors/drivetemp.ts|["-n","modprobe","drivetemp"]',
    {
      argv: ["modprobe", "drivetemp"],
    },
  ),
];

/**
 * Call sites the host refuses today, each with why. Their tests are skipped
 * (and named KNOWN BUG) until the fix lands; the fix removes the entry.
 */
const KNOWN_BUGS: Record<string, string> = {
  'src/deploy/release/promote.ts|["-n","mv","-Tf","--",tmpLink,currentLink]':
    "tp-host mv renames the source onto itself",
  'src/deploy/site/engine-driver.ts|["-n","mv","-f","--",staged.candidatePath,staged.path]':
    "tp-host mv renames the source onto itself",
  'src/deploy/site/engine-driver.ts|["-n","mv","-f","--",staged.previousPath,staged.path]':
    "tp-host mv renames the source onto itself",
  'src/deploy/ssh/apply.ts|["-n","mv","-f","--",backup,dropInPath]':
    "tp-host mv renames the source onto itself",
  'src/deploy/ssh/apply.ts|["-n","install","-d","-m","0755","-o","root","-g","root",dirname(dropInPath)]':
    "tp-host refuses to re-own the sshd_config.d root",
  'src/deploy/ensure-hosting-caddy.ts|["-n","chown","root:turbopanel",binPath]':
    "no host has a `turbopanel` group",
  "src/deploy/instance-acme-http01.ts|[...args]":
    "tp-host find refuses -mindepth/-maxdepth",
  'src/metrics/collector/sensors/drivetemp.ts|["-n","modprobe","drivetemp"]':
    "no sudoers rule or tp-host verb for modprobe",
};

export const CALL_SITES: readonly CallSite[] = SITES.map((site) =>
  KNOWN_BUGS[site.key] === undefined
    ? site
    : { ...site, knownBug: KNOWN_BUGS[site.key] }
);

/** Known-bug keys that match no call site (a fix renamed or removed it). */
export const STALE_KNOWN_BUGS: readonly string[] = Object.keys(KNOWN_BUGS)
  .filter((key) => !SITES.some((site) => site.key === key));
