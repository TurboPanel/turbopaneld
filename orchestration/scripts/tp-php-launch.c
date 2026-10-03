/*
 * tp-php-launch: start one site's attached lsphp as the site's owner.
 *
 * OpenLiteSpeed runs as tpols and cannot become a site owner itself. Its
 * extprocessor path for an attached-lsphp site is `tp-php-launch lsapi <siteId>`.
 * This program is installed root:tpphplaunch 4750 (tpols is the group's only
 * member). It reads the root-owned registry entry tp-host `php-site-register`
 * wrote for the site, checks everything below, becomes the owner and execs the
 * vendored lsphp of the registered series. There is no other mode, no option,
 * no environment override and no PATH lookup. Every refusal exits 1 with one
 * syslog line (LOG_AUTHPRIV).
 *
 * Checks, in order: argv; caller (real uid tpols); registry (no symlink, root
 * owned, not group/other writable, one link, strict key=value, mode
 * lsphp-attached); target user (uid/gid 15001-60000, not tp*, passwd and group
 * agree, home <principals>/<user>/home, member of the series' tpphp group);
 * stdin a listening AF_UNIX stream socket; lsphp binary root-owned all the way
 * down; private mount namespace with the owner's tmp/ (no-follow, owned by the
 * owner) bound on /tmp and an empty read-only /etc/turbopanel showing only the
 * site's config directory (as the site's systemd units have it); groups, gid,
 * uid dropped and verified; no_new_privs; fixed rlimits and environment;
 * execveat of the pinned binary with only the socket and /dev/null open.
 *
 * The paths are compiled in: a principal home root moved through tp-host.conf
 * is not supported here (the launcher refuses, the home does not match).
 *
 * Build (release): scripts/build-tp-php-launch.sh (static, musl, reproducible).
 * Needs an outside security review before release.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <grp.h>
#include <linux/capability.h>
#include <pwd.h>
#include <sched.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <syslog.h>
#include <unistd.h>

#define REGISTRY_DIR "/etc/turbopanel-php-sites"
#define PRINCIPALS "/srv/users"
#define CONFIG_ROOT "/etc/turbopanel"
#define PHP_SITE_CONF CONFIG_ROOT "/php/sites"
#define LSPHP_ROOT "/opt/turbopanel/vendor/lsphp"
#define CALLER "tpols"
#define SERVICE_ID_MIN 9900
#define SERVICE_ID_MAX 9999
#define PRINCIPAL_ID_MIN 15001
#define PRINCIPAL_ID_MAX 60000
#define REG_MAX 4096
#define VAL_MAX 160

/* Series this build can start; kept in step with the openlitespeed role. */
static const struct series { const char *php, *group; } SERIES[] = {
    {"8.3", "tpphp83"},
    {"8.4", "tpphp84"},
};

enum { K_VERSION, K_SITE, K_MODE, K_USER, K_UID, K_GROUP, K_GID, K_HOME,
       K_TMP, K_PHP, K_BIN, K_INI, K_CHILDREN, K_COUNT };
static const char *const KEYS[K_COUNT] = {"version", "site", "mode", "user",
    "uid", "group", "gid", "home", "tmp", "php", "bin", "ini", "children"};

struct reg {
  char v[K_COUNT][VAL_MAX];
  unsigned uid, gid, children;
  const struct series *series;
};

static int site_id_ok(const char *s) {
  size_t n = strlen(s);
  if (n < 1 || n > 64 || s[0] == '-') return 0;
  for (size_t i = 0; i < n; i++)
    if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= '0' && s[i] <= '9') ||
          s[i] == '-'))
      return 0;
  return 1;
}

static int user_name_ok(const char *s) {
  size_t n = strlen(s);
  if (n < 1 || n > 32 || !(s[0] >= 'a' && s[0] <= 'z')) return 0;
  if (strncmp(s, "tp", 2) == 0) return 0;
  for (size_t i = 0; i < n; i++)
    if (!((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= '0' && s[i] <= '9') ||
          s[i] == '-' || s[i] == '_'))
      return 0;
  return 1;
}

/* Decimal in [lo, hi], no sign, no leading zero. */
static int number_in(const char *s, unsigned lo, unsigned hi, unsigned *out) {
  unsigned long v = 0;
  size_t n = strlen(s);
  if (n < 1 || n > 5 || s[0] == '0') return 0;
  for (size_t i = 0; i < n; i++) {
    if (s[i] < '0' || s[i] > '9') return 0;
    v = v * 10 + (unsigned)(s[i] - '0');
  }
  if (v < lo || v > hi) return 0;
  *out = (unsigned)v;
  return 1;
}

static int is(const char *a, const char *b) { return strcmp(a, b) == 0; }

/*
 * Parse and check a registry entry for SITE. Pure: no I/O, so it is fuzzed on
 * its own (scripts/tp-php-launch/fuzz-registry.c). Returns NULL or the reason.
 */
const char *tp_parse_registry(const char *buf, size_t len, const char *site,
                              struct reg *r) {
  unsigned seen = 0;
  size_t at = 0;
  char want[VAL_MAX * 2];
  memset(r, 0, sizeof *r);
  if (len == 0 || len > REG_MAX) return "registry size";
  if (buf[len - 1] != '\n') return "registry does not end in a newline";
  while (at < len) {
    const char *line = buf + at, *nl = memchr(line, '\n', len - at);
    const char *eq = memchr(line, '=', (size_t)(nl - line));
    size_t klen, vlen;
    int k;
    if (!eq) return "registry line without =";
    klen = (size_t)(eq - line);
    vlen = (size_t)(nl - eq - 1);
    for (k = 0; k < K_COUNT; k++)
      if (strlen(KEYS[k]) == klen && memcmp(KEYS[k], line, klen) == 0) break;
    if (k == K_COUNT) return "registry key unknown";
    if (seen & (1u << k)) return "registry key repeated";
    if (vlen == 0 || vlen >= VAL_MAX) return "registry value length";
    for (size_t i = 0; i < vlen; i++) {
      unsigned char c = (unsigned char)eq[1 + i];
      if (c <= 0x20 || c >= 0x7f) return "registry value character";
    }
    memcpy(r->v[k], eq + 1, vlen);
    seen |= 1u << k;
    at = (size_t)(nl - buf) + 1;
  }
  if (seen != (1u << K_COUNT) - 1) return "registry key missing";
  if (!is(r->v[K_VERSION], "1")) return "registry version";
  if (!site_id_ok(site) || !is(r->v[K_SITE], site)) return "registry site";
  if (!is(r->v[K_MODE], "lsphp-attached")) return "mode is not lsphp-attached";
  if (!user_name_ok(r->v[K_USER])) return "user name";
  if (!number_in(r->v[K_UID], PRINCIPAL_ID_MIN, PRINCIPAL_ID_MAX, &r->uid))
    return "uid outside the principal band";
  if (!number_in(r->v[K_GID], PRINCIPAL_ID_MIN, PRINCIPAL_ID_MAX, &r->gid))
    return "gid outside the principal band";
  if (!number_in(r->v[K_CHILDREN], 1, 64, &r->children)) return "children";
  snprintf(want, sizeof want, "%s-grp", r->v[K_USER]);
  if (!is(r->v[K_GROUP], want)) return "group is not <user>-grp";
  snprintf(want, sizeof want, PRINCIPALS "/%s/home", r->v[K_USER]);
  if (!is(r->v[K_HOME], want)) return "home";
  snprintf(want, sizeof want, PRINCIPALS "/%s/tmp", r->v[K_USER]);
  if (!is(r->v[K_TMP], want)) return "tmp";
  snprintf(want, sizeof want, PHP_SITE_CONF "/%s/php.ini", site);
  if (!is(r->v[K_INI], want)) return "ini";
  for (size_t i = 0; i < sizeof SERIES / sizeof SERIES[0]; i++)
    if (is(r->v[K_PHP], SERIES[i].php)) r->series = &SERIES[i];
  if (!r->series) return "PHP series not in this build";
  snprintf(want, sizeof want, LSPHP_ROOT "/%s/current/bin/lsphp",
           r->series->php);
  if (!is(r->v[K_BIN], want)) return "bin";
  return NULL;
}

#ifndef TP_LAUNCH_NO_MAIN

static void refuse(const char *why) __attribute__((noreturn));
static void refuse(const char *why) {
  syslog(LOG_AUTHPRIV | LOG_WARNING, "refused: %s", why);
  _exit(1);
}

/* A system call failed: the reason and errno. */
static void fail(const char *why) __attribute__((noreturn));
static void fail(const char *why) {
  syslog(LOG_AUTHPRIV | LOG_WARNING, "refused: %s: %m", why);
  _exit(1);
}

/* A directory, a regular file or a socket we opened: owner and mode checks. */
static void check_fd(int fd, uid_t owner, mode_t type, int deny_write,
                     const char *what) {
  struct stat st;
  if (fstat(fd, &st) != 0 || (st.st_mode & S_IFMT) != type)
    refuse(what);
  if (st.st_uid != owner || (deny_write && (st.st_mode & 022)))
    refuse(what);
}

/*
 * Open an absolute path one component at a time with O_NOFOLLOW. Every
 * directory on the way is root-owned and not group/other writable, except
 * LENIENT (tp's own config root), which only has to be a real directory; LINK,
 * if set, is the one component allowed to be a symlink (lsphp's `current`),
 * and its target must be a single plain name. Returns an O_PATH fd on the last
 * component; the caller checks it.
 */
static int walk(const char *path, const char *link, const char *lenient) {
  const char *p = path;
  int dir = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
  if (dir < 0 || *p != '/' || strlen(path) >= VAL_MAX) refuse("path walk");
  check_fd(dir, 0, S_IFDIR, 1, path);
  while (*p == '/') {
    const char *start = p + 1, *end = strchr(start, '/');
    size_t n = end ? (size_t)(end - start) : strlen(start);
    char name[80], target[80], prefix[VAL_MAX];
    ssize_t t;
    int next;
    if (n == 0 || n >= sizeof name) refuse(path);
    memcpy(name, start, n);
    name[n] = 0;
    if (link && is(name, link)) {
      if ((t = readlinkat(dir, name, target, sizeof target - 1)) <= 0)
        refuse("current link");
      target[t] = 0;
      memcpy(name, target, (size_t)t + 1);
    }
    if (strchr(name, '/') || is(name, ".") || is(name, "..")) refuse(path);
    next = openat(dir, name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
    close(dir);
    if (next < 0) refuse(path);
    dir = next;
    p = start + n;
    memcpy(prefix, path, (size_t)(p - path));
    prefix[p - path] = 0;
    if (end && lenient && is(prefix, lenient)) {
      struct stat st;
      if (fstat(dir, &st) || !S_ISDIR(st.st_mode)) refuse(path);
    } else if (end) {
      check_fd(dir, 0, S_IFDIR, 1, path);
    }
  }
  return dir;
}

static void read_registry(const char *site, struct reg *r) {
  char buf[REG_MAX + 1];
  struct stat st;
  ssize_t n;
  size_t len = 0;
  const char *why;
  int dir = walk(REGISTRY_DIR, NULL, NULL), fd;
  check_fd(dir, 0, S_IFDIR, 1, REGISTRY_DIR);
  fd = openat(dir, site, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY |
                             O_CLOEXEC);
  close(dir);
  if (fd < 0) refuse("no registry entry");
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != 0 ||
      st.st_gid != 0 || (st.st_mode & 07022) || st.st_nlink != 1 ||
      st.st_size > REG_MAX)
    refuse("registry entry is not root:root, 0644-or-less, one link");
  while (len < sizeof buf && (n = read(fd, buf + len, sizeof buf - len)) > 0)
    len += (size_t)n;
  close(fd);
  if ((why = tp_parse_registry(buf, len, site, r))) refuse(why);
}

/* passwd and group agree with the registry, both ways. */
static gid_t check_identity(const struct reg *r) {
  struct passwd *pw = getpwnam(r->v[K_USER]);
  struct group *gr;
  if (!pw || pw->pw_uid != r->uid || pw->pw_gid != r->gid ||
      !is(pw->pw_dir, r->v[K_HOME]))
    refuse("user does not match passwd");
  if (!(pw = getpwuid(r->uid)) || !is(pw->pw_name, r->v[K_USER]))
    refuse("uid does not map back to the user");
  if (!(gr = getgrnam(r->v[K_GROUP])) || gr->gr_gid != r->gid)
    refuse("group does not match");
  if (!(gr = getgrgid(r->gid)) || !is(gr->gr_name, r->v[K_GROUP]))
    refuse("gid does not map back to the group");
  if (!(gr = getgrnam(r->series->group)) || gr->gr_gid < SERVICE_ID_MIN ||
      gr->gr_gid > SERVICE_ID_MAX)
    refuse("no entitlement group for the series");
  for (char **m = gr->gr_mem; *m; m++)
    if (is(*m, r->v[K_USER])) return gr->gr_gid;
  refuse("user is not entitled to the PHP series");
}

static void check_stdin(void) {
  struct stat st;
  int v;
  socklen_t l = sizeof v;
  if (fstat(0, &st) != 0 || !S_ISSOCK(st.st_mode)) refuse("stdin not a socket");
  if (getsockopt(0, SOL_SOCKET, SO_DOMAIN, &v, &l) || v != AF_UNIX)
    refuse("stdin not AF_UNIX");
  l = sizeof v;
  if (getsockopt(0, SOL_SOCKET, SO_TYPE, &v, &l) || v != SOCK_STREAM)
    refuse("stdin not a stream socket");
  l = sizeof v;
  if (getsockopt(0, SOL_SOCKET, SO_ACCEPTCONN, &v, &l) || v != 1)
    refuse("stdin not listening");
}

static void bind_fd(int fd, const char *at, unsigned long flags, const char *why) {
  char src[40];
  struct stat a, b;
  snprintf(src, sizeof src, "/proc/self/fd/%d", fd);
  if (mount(src, at, NULL, MS_BIND, NULL) ||
      mount(NULL, at, NULL, MS_BIND | MS_REMOUNT | flags, NULL))
    fail(why);
  if (fstat(fd, &a) || stat(at, &b) || a.st_dev != b.st_dev ||
      a.st_ino != b.st_ino)
    refuse(why);
  close(fd);
}

/*
 * Private mount namespace, as the site's systemd units have it: the owner's
 * tmp/ (owned by them) on /tmp, and an empty read-only /etc/turbopanel showing
 * only this site's config directory (root:<owner>-grp), read-only.
 */
static void private_mounts(const struct reg *r, const char *site) {
  char conf[VAL_MAX];
  struct stat st;
  int tmp, cfg, ini;
  /* Opened inside the new namespace: a bind source must be one of its mounts. */
  if (unshare(CLONE_NEWNS) || mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL))
    fail("mount namespace");
  tmp = walk(r->v[K_TMP], NULL, NULL);
  check_fd(tmp, r->uid, S_IFDIR, 0, "owner tmp");
  if (fstat(tmp, &st) || (st.st_mode & S_IWOTH)) refuse("owner tmp mode");
  snprintf(conf, sizeof conf, PHP_SITE_CONF "/%s", site);
  cfg = walk(conf, NULL, CONFIG_ROOT);
  if (fstat(cfg, &st) || !S_ISDIR(st.st_mode) || st.st_uid != 0 ||
      st.st_gid != r->gid || (st.st_mode & 022))
    refuse("site config directory is not root:<owner>-grp, unwritable");
  ini = openat(cfg, "php.ini", O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (ini < 0 || fstat(ini, &st) || !S_ISREG(st.st_mode) || st.st_uid != 0 ||
      (st.st_mode & 07022))
    refuse("site php.ini is not a root-owned, unwritable file");
  close(ini);
  bind_fd(tmp, "/tmp", MS_NOSUID | MS_NODEV, "bind owner tmp");
  if (mount("tmpfs", CONFIG_ROOT, "tmpfs", MS_NOSUID | MS_NODEV | MS_NOEXEC,
            "mode=0755,size=16k") ||
      mkdir(CONFIG_ROOT "/php", 0755) || mkdir(PHP_SITE_CONF, 0755) ||
      mkdir(conf, 0755))
    fail("config tmpfs");
  bind_fd(cfg, conf, MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC,
       "bind site config");
  if (mount(NULL, CONFIG_ROOT, NULL,
            MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL))
    fail("config tmpfs read-only");
}

static void drop(const struct reg *r, gid_t entitled) {
  gid_t groups[2] = {r->gid, entitled}, g[4];
  uid_t ru, eu, su;
  gid_t rg, eg, sg;
  struct __user_cap_header_struct h = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct d[2];
  if (setgroups(2, groups) || setresgid(r->gid, r->gid, r->gid) ||
      setresuid(r->uid, r->uid, r->uid))
    fail("drop privileges");
  if (getresuid(&ru, &eu, &su) || ru != r->uid || eu != r->uid ||
      su != r->uid || getresgid(&rg, &eg, &sg) || rg != r->gid ||
      eg != r->gid || sg != r->gid || getgroups(4, g) != 2)
    refuse("ids after drop");
  if (setuid(0) != -1 || setgid(0) != -1) refuse("setuid(0) still works");
  if (syscall(SYS_capget, &h, d) || d[0].effective || d[0].permitted ||
      d[0].inheritable || d[1].effective || d[1].permitted || d[1].inheritable)
    refuse("capabilities left after drop");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no_new_privs");
}

static void fixed_process_state(void) {
  static const struct { int res; rlim_t soft, hard; } LIMITS[] = {
      {RLIMIT_CORE, 0, 0},
      {RLIMIT_NOFILE, 8192, 8192},
      {RLIMIT_STACK, 8 << 20, RLIM_INFINITY},
      {RLIMIT_FSIZE, RLIM_INFINITY, RLIM_INFINITY},
      {RLIMIT_AS, RLIM_INFINITY, RLIM_INFINITY},
      {RLIMIT_DATA, RLIM_INFINITY, RLIM_INFINITY},
      {RLIMIT_CPU, RLIM_INFINITY, RLIM_INFINITY},
      {RLIMIT_MEMLOCK, 8 << 20, 8 << 20},
  };
  sigset_t none;
  for (size_t i = 0; i < sizeof LIMITS / sizeof LIMITS[0]; i++) {
    struct rlimit l = {LIMITS[i].soft, LIMITS[i].hard};
    if (setrlimit(LIMITS[i].res, &l)) fail("rlimit");
  }
  for (int s = 1; s < NSIG; s++) signal(s, SIG_DFL);
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);
  umask(022);
  if (chdir("/")) fail("chdir");
  prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0);
}

int main(int argc, char **argv) {
  struct reg r;
  struct passwd *caller;
  struct stat st;
  char phprc[VAL_MAX + 8], children[32];
  char *envp[] = {"PATH=/usr/local/bin:/usr/bin:/bin", "TMPDIR=/tmp", phprc,
                  children, "LSAPI_AVOID_FORK=200M", NULL};
  char *lsphp_argv[] = {"lsphp", NULL};
  gid_t entitled;
  int bin, null;

  /* Nothing is opened until the first message (fd 0 may be closed). */
  openlog("tp-php-launch", LOG_PID | LOG_PERROR, LOG_AUTHPRIV);
  /* fd 0 is the socket; 1 and 2 must exist so nothing else lands on them. */
  if (fcntl(0, F_GETFD) < 0) refuse("stdin closed");
  do {
    null = open("/dev/null", O_RDWR);
  } while (null >= 0 && null < 3);
  if (null < 0) fail("/dev/null");
  if (syscall(SYS_close_range, 3, ~0U, 0) != 0)
    for (int fd = 3; fd < 65536; fd++) close(fd);
  clearenv();

  if (geteuid() != 0) refuse("not running setuid root (no_new_privs?)");
  if (argc != 3 || !is(argv[1], "lsapi") || !site_id_ok(argv[2]))
    refuse("usage: lsapi <siteId>");
  caller = getpwnam(CALLER);
  if (!caller || caller->pw_uid < SERVICE_ID_MIN ||
      caller->pw_uid > SERVICE_ID_MAX || getuid() != caller->pw_uid)
    refuse("caller is not " CALLER);
  read_registry(argv[2], &r);
  entitled = check_identity(&r);
  check_stdin();

  bin = walk(r.v[K_BIN], "current", NULL);
  if (fstat(bin, &st) || !S_ISREG(st.st_mode) || st.st_uid != 0 ||
      (st.st_mode & 07022))
    refuse("lsphp binary is not root-owned, unwritable, without set-id bits");

  private_mounts(&r, argv[2]);
  fixed_process_state();
  drop(&r, entitled);

  snprintf(phprc, sizeof phprc, "PHPRC=%s", r.v[K_INI]);
  snprintf(children, sizeof children, "PHP_LSAPI_CHILDREN=%u", r.children);
  syslog(LOG_AUTHPRIV | LOG_INFO, "site %s: lsphp %s as %s", argv[2],
         r.series->php, r.v[K_USER]);
  closelog();
  if ((null = open("/dev/null", O_RDWR | O_CLOEXEC)) < 0 ||
      dup2(null, 1) < 0 || dup2(null, 2) < 0)
    fail("/dev/null");
  syscall(SYS_execveat, bin, "", lsphp_argv, envp, AT_EMPTY_PATH);
  fail("exec lsphp");
}
#endif
