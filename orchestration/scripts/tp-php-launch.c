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
#define NAME_MAX_LEN 80

struct series {
  const char *php;
  const char *group;
};

/* Series this build can start; kept in step with the openlitespeed role. */
static const struct series SERIES[] = {
    {"8.3", "tpphp83"},
    {"8.4", "tpphp84"},
};

enum { K_VERSION, K_SITE, K_MODE, K_USER, K_UID, K_GROUP, K_GID, K_HOME,
       K_TMP, K_PHP, K_BIN, K_INI, K_CHILDREN, K_COUNT };
static const char *const KEYS[K_COUNT] = {"version", "site", "mode", "user",
    "uid", "group", "gid", "home", "tmp", "php", "bin", "ini", "children"};

struct reg {
  char v[K_COUNT][VAL_MAX];
  unsigned uid;
  unsigned gid;
  unsigned children;
  const struct series *series;
};

static int is(const char *a, const char *b) { return strcmp(a, b) == 0; }

static int lower_or_digit(char c) {
  return (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9');
}

static int site_id_ok(const char *s) {
  size_t n = strlen(s);
  if (n < 1 || n > 64 || s[0] == '-') return 0;
  for (size_t i = 0; i < n; i++)
    if (!lower_or_digit(s[i]) && s[i] != '-') return 0;
  return 1;
}

static int user_name_ok(const char *s) {
  size_t n = strlen(s);
  if (n < 1 || n > 32 || s[0] < 'a' || s[0] > 'z') return 0;
  if (strncmp(s, "tp", 2) == 0) return 0;
  for (size_t i = 0; i < n; i++)
    if (!lower_or_digit(s[i]) && s[i] != '-' && s[i] != '_') return 0;
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

static int key_index(const char *key, size_t klen) {
  for (int k = 0; k < K_COUNT; k++)
    if (strlen(KEYS[k]) == klen && memcmp(KEYS[k], key, klen) == 0) return k;
  return -1;
}

static int printable(const char *s, size_t n) {
  for (size_t i = 0; i < n; i++) {
    unsigned char c = (unsigned char)s[i];
    if (c <= 0x20 || c >= 0x7f) return 0;
  }
  return 1;
}

/* One `key=value\n` line at LINE; stores it and advances *AT. */
static const char *parse_line(const char *buf, size_t len, size_t *at,
                              unsigned *seen, struct reg *r) {
  const char *line = buf + *at;
  const char *nl = memchr(line, '\n', len - *at);
  const char *eq = memchr(line, '=', (size_t)(nl - line));
  size_t vlen;
  int k;
  if (!eq) return "registry line without =";
  k = key_index(line, (size_t)(eq - line));
  if (k < 0) return "registry key unknown";
  if (*seen & (1u << k)) return "registry key repeated";
  vlen = (size_t)(nl - eq - 1);
  if (vlen == 0 || vlen >= VAL_MAX) return "registry value length";
  if (!printable(eq + 1, vlen)) return "registry value character";
  memcpy(r->v[k], eq + 1, vlen);
  *seen |= 1u << k;
  *at = (size_t)(nl - buf) + 1;
  return NULL;
}

/* VALUE must be exactly the path built from FORMAT and ARG. */
static int derived(const char *value, const char *format, const char *arg) {
  char want[VAL_MAX * 2];
  snprintf(want, sizeof want, format, arg);
  return is(value, want);
}

/* The values, once every key is present exactly once. */
static const char *check_values(const char *site, struct reg *r) {
  const char *user = r->v[K_USER];
  if (!is(r->v[K_VERSION], "1")) return "registry version";
  if (!site_id_ok(site) || !is(r->v[K_SITE], site)) return "registry site";
  if (!is(r->v[K_MODE], "lsphp-attached")) return "mode is not lsphp-attached";
  if (!user_name_ok(user)) return "user name";
  if (!number_in(r->v[K_UID], PRINCIPAL_ID_MIN, PRINCIPAL_ID_MAX, &r->uid))
    return "uid outside the principal band";
  if (!number_in(r->v[K_GID], PRINCIPAL_ID_MIN, PRINCIPAL_ID_MAX, &r->gid))
    return "gid outside the principal band";
  if (!number_in(r->v[K_CHILDREN], 1, 64, &r->children)) return "children";
  if (!derived(r->v[K_GROUP], "%s-grp", user)) return "group is not <user>-grp";
  if (!derived(r->v[K_HOME], PRINCIPALS "/%s/home", user)) return "home";
  if (!derived(r->v[K_TMP], PRINCIPALS "/%s/tmp", user)) return "tmp";
  if (!derived(r->v[K_INI], PHP_SITE_CONF "/%s/php.ini", site)) return "ini";
  for (size_t i = 0; i < sizeof SERIES / sizeof SERIES[0]; i++)
    if (is(r->v[K_PHP], SERIES[i].php)) r->series = &SERIES[i];
  if (!r->series) return "PHP series not in this build";
  if (!derived(r->v[K_BIN], LSPHP_ROOT "/%s/current/bin/lsphp", r->series->php))
    return "bin";
  return NULL;
}

/*
 * Parse and check a registry entry for SITE. Pure: no I/O, so it is fuzzed on
 * its own (scripts/tp-php-launch/fuzz-registry.c). Returns NULL or the reason.
 */
const char *tp_parse_registry(const char *buf, size_t len, const char *site,
                              struct reg *r) {
  unsigned seen = 0;
  size_t at = 0;
  memset(r, 0, sizeof *r);
  if (len == 0 || len > REG_MAX) return "registry size";
  if (buf[len - 1] != '\n') return "registry does not end in a newline";
  while (at < len) {
    const char *why = parse_line(buf, len, &at, &seen, r);
    if (why) return why;
  }
  if (seen != (1u << K_COUNT) - 1) return "registry key missing";
  return check_values(site, r);
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

/* The fd is a TYPE owned by OWNER, and with DENY_WRITE not group/other writable. */
static void check_fd(int fd, uid_t owner, mode_t type, int deny_write,
                     const char *what) {
  struct stat st;
  if (fstat(fd, &st) != 0 || (st.st_mode & S_IFMT) != type)
    refuse(what);
  if (st.st_uid != owner || (deny_write && (st.st_mode & 022)))
    refuse(what);
}

/* A real directory, whoever owns it. */
static void check_is_dir(int fd, const char *what) {
  struct stat st;
  if (fstat(fd, &st) != 0 || !S_ISDIR(st.st_mode)) refuse(what);
}

/* /proc/self/fd/<fd>, how mount(2) is handed a directory we hold open. */
static const char *fd_path(int fd, char *buf, size_t n) {
  snprintf(buf, n, "/proc/self/fd/%d", fd);
  return buf;
}

/* Component NAME under DIR, no-follow; LINK, if it names it, is resolved once. */
static int open_component(int dir, const char *name, const char *link,
                          const char *path) {
  char target[NAME_MAX_LEN];
  ssize_t t;
  if (link && is(name, link)) {
    t = readlinkat(dir, name, target, sizeof target - 1);
    if (t <= 0) refuse("current link");
    target[t] = 0;
    name = target;
  }
  if (strchr(name, '/') || is(name, ".") || is(name, "..")) refuse(path);
  return openat(dir, name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
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
    const char *start = p + 1;
    const char *end = strchr(start, '/');
    size_t n = end ? (size_t)(end - start) : strlen(start);
    char name[NAME_MAX_LEN];
    int next;
    if (n == 0 || n >= sizeof name) refuse(path);
    memcpy(name, start, n);
    name[n] = 0;
    next = open_component(dir, name, link, path);
    close(dir);
    if (next < 0) refuse(path);
    dir = next;
    p = start + n;
    if (end && lenient && (size_t)(p - path) == strlen(lenient) &&
        strncmp(path, lenient, strlen(lenient)) == 0)
      check_is_dir(dir, path);
    else if (end)
      check_fd(dir, 0, S_IFDIR, 1, path);
  }
  return dir;
}

static size_t read_all(int fd, char *buf, size_t cap) {
  size_t len = 0;
  while (len < cap) {
    ssize_t n = read(fd, buf + len, cap - len);
    if (n <= 0) break;
    len += (size_t)n;
  }
  return len;
}

static void read_registry(const char *site, struct reg *r) {
  char buf[REG_MAX + 1];
  struct stat st;
  size_t len;
  const char *why;
  int dir = walk(REGISTRY_DIR, NULL, NULL);
  int fd;
  check_fd(dir, 0, S_IFDIR, 1, REGISTRY_DIR);
  fd = openat(dir, site, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY |
                             O_CLOEXEC);
  close(dir);
  if (fd < 0) refuse("no registry entry");
  if (fstat(fd, &st) != 0 || !S_ISREG(st.st_mode) || st.st_uid != 0 ||
      st.st_gid != 0 || (st.st_mode & 07022) || st.st_nlink != 1 ||
      st.st_size > REG_MAX)
    refuse("registry entry is not root:root, 0644-or-less, one link");
  len = read_all(fd, buf, sizeof buf);
  close(fd);
  why = tp_parse_registry(buf, len, site, r);
  if (why) refuse(why);
}

/* Account database lookups (reentrant, into BUF). */
static int user_named(const char *name, struct passwd *pw, char *buf, size_t n) {
  struct passwd *res = NULL;
  return getpwnam_r(name, pw, buf, n, &res) == 0 && res != NULL;
}

static int group_named(const char *name, struct group *gr, char *buf, size_t n) {
  struct group *res = NULL;
  return getgrnam_r(name, gr, buf, n, &res) == 0 && res != NULL;
}

/* passwd and group agree with the registry, both ways. */
static void check_accounts(const struct reg *r) {
  char buf[4096];
  struct passwd pw;
  struct passwd *pres = NULL;
  struct group gr;
  struct group *gres = NULL;
  if (!user_named(r->v[K_USER], &pw, buf, sizeof buf) || pw.pw_uid != r->uid ||
      pw.pw_gid != r->gid || !is(pw.pw_dir, r->v[K_HOME]))
    refuse("user does not match passwd");
  if (getpwuid_r(r->uid, &pw, buf, sizeof buf, &pres) != 0 || !pres ||
      !is(pw.pw_name, r->v[K_USER]))
    refuse("uid does not map back to the user");
  if (!group_named(r->v[K_GROUP], &gr, buf, sizeof buf) || gr.gr_gid != r->gid)
    refuse("group does not match");
  if (getgrgid_r(r->gid, &gr, buf, sizeof buf, &gres) != 0 || !gres ||
      !is(gr.gr_name, r->v[K_GROUP]))
    refuse("gid does not map back to the group");
}

/* The series' entitlement group, which the owner must already be in. */
static gid_t entitlement(const struct reg *r) {
  char buf[16384];
  struct group gr;
  if (!group_named(r->series->group, &gr, buf, sizeof buf) ||
      gr.gr_gid < SERVICE_ID_MIN || gr.gr_gid > SERVICE_ID_MAX)
    refuse("no entitlement group for the series");
  for (char **m = gr.gr_mem; *m; m++)
    if (is(*m, r->v[K_USER])) return gr.gr_gid;
  refuse("user is not entitled to the PHP series");
}

static int sock_opt(int opt) {
  int v = -1;
  socklen_t l = sizeof v;
  if (getsockopt(0, SOL_SOCKET, opt, &v, &l) != 0) return -1;
  return v;
}

static void check_stdin(void) {
  struct stat st;
  if (fstat(0, &st) != 0 || !S_ISSOCK(st.st_mode)) refuse("stdin not a socket");
  if (sock_opt(SO_DOMAIN) != AF_UNIX) refuse("stdin not AF_UNIX");
  if (sock_opt(SO_TYPE) != SOCK_STREAM) refuse("stdin not a stream socket");
  if (sock_opt(SO_ACCEPTCONN) != 1) refuse("stdin not listening");
}

/* Directory NAME under PARENT (no-follow), as an O_PATH fd. */
static int subdir(int parent, const char *name, const char *why) {
  int fd = openat(parent, name, O_PATH | O_NOFOLLOW | O_DIRECTORY | O_CLOEXEC);
  if (fd < 0) fail(why);
  return fd;
}

/*
 * Bind SRC on directory NAME under PARENT, then remount the new mount with
 * FLAGS; the mount point is looked up again so the remount and the identity
 * check see the new mount, not the one it covers.
 */
static void bind_on(int src, int parent, const char *name, unsigned long flags,
                    const char *why) {
  char from[40];
  char to[40];
  struct stat a;
  struct stat b;
  int at = subdir(parent, name, why);
  if (mount(fd_path(src, from, sizeof from), fd_path(at, to, sizeof to), NULL,
            MS_BIND, NULL))
    fail(why);
  close(at);
  at = subdir(parent, name, why);
  if (mount(NULL, fd_path(at, to, sizeof to), NULL, MS_BIND | MS_REMOUNT | flags,
            NULL))
    fail(why);
  if (fstat(src, &a) || fstat(at, &b) || a.st_dev != b.st_dev ||
      a.st_ino != b.st_ino)
    refuse(why);
  close(at);
  close(src);
}

/* mkdir NAME under PARENT for root:GID 0710 in the private tmpfs; returns it. */
static int private_dir(int parent, const char *name, gid_t gid) {
  if (mkdirat(parent, name, 0700) || fchownat(parent, name, 0, gid,
                                              AT_SYMLINK_NOFOLLOW) ||
      fchmodat(parent, name, 0710, 0))
    fail("config tmpfs");
  return subdir(parent, name, "config tmpfs");
}

/* The owner's tmp/, checked; an O_PATH fd. */
static int owner_tmp(const struct reg *r) {
  struct stat st;
  int fd = walk(r->v[K_TMP], NULL, NULL);
  check_fd(fd, r->uid, S_IFDIR, 0, "owner tmp");
  if (fstat(fd, &st) || (st.st_mode & S_IWOTH)) refuse("owner tmp mode");
  return fd;
}

/* The site's config directory (root:<owner>-grp, unwritable) and its php.ini. */
static int site_config(const struct reg *r, const char *conf) {
  struct stat st;
  int cfg = walk(conf, NULL, CONFIG_ROOT);
  int ini;
  if (fstat(cfg, &st) || !S_ISDIR(st.st_mode) || st.st_uid != 0 ||
      st.st_gid != r->gid || (st.st_mode & 022))
    refuse("site config directory is not root:<owner>-grp, unwritable");
  ini = openat(cfg, "php.ini", O_PATH | O_NOFOLLOW | O_CLOEXEC);
  if (ini < 0) refuse("site php.ini is not a root-owned, unwritable file");
  if (fstat(ini, &st) || !S_ISREG(st.st_mode) || st.st_uid != 0 ||
      (st.st_mode & 07022))
    refuse("site php.ini is not a root-owned, unwritable file");
  close(ini);
  return cfg;
}

/*
 * Private mount namespace, as the site's systemd units have it: the owner's
 * tmp/ on /tmp, and an empty read-only /etc/turbopanel (root:<owner>-grp
 * 0710 all the way down) showing only this site's config directory, read-only.
 * Mount points are reached by descriptor from /, never through a symlink.
 */
static void private_mounts(const struct reg *r, const char *site) {
  char conf[VAL_MAX];
  char opts[64];
  char at[40];
  int root;
  int etc;
  int cfg;
  int tmp;
  int dir;
  int next;
  /* Opened inside the new namespace: a bind source must be one of its mounts. */
  if (unshare(CLONE_NEWNS) || mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL))
    fail("mount namespace");
  tmp = owner_tmp(r);
  snprintf(conf, sizeof conf, PHP_SITE_CONF "/%s", site);
  cfg = site_config(r, conf);
  root = subdir(AT_FDCWD, "/", "mount root");
  bind_on(tmp, root, "tmp", MS_NOSUID | MS_NODEV, "bind owner tmp");

  etc = subdir(root, "etc", "config tmpfs");
  dir = subdir(etc, "turbopanel", "config tmpfs");
  snprintf(opts, sizeof opts, "mode=0710,uid=0,gid=%u,size=16k", r->gid);
  if (mount("tmpfs", fd_path(dir, at, sizeof at), "tmpfs",
            MS_NOSUID | MS_NODEV | MS_NOEXEC, opts))
    fail("config tmpfs");
  close(dir);
  dir = subdir(etc, "turbopanel", "config tmpfs");
  next = private_dir(dir, "php", r->gid);
  close(dir);
  dir = private_dir(next, "sites", r->gid);
  close(next);
  close(private_dir(dir, site, r->gid));
  bind_on(cfg, dir, site, MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC,
          "bind site config");
  close(dir);
  dir = subdir(etc, "turbopanel", "config tmpfs");
  if (mount(NULL, fd_path(dir, at, sizeof at), NULL,
            MS_REMOUNT | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, opts))
    fail("config tmpfs read-only");
  close(dir);
  close(etc);
  close(root);
}

static void drop(const struct reg *r, gid_t entitled) {
  gid_t groups[2] = {r->gid, entitled};
  gid_t g[4];
  uid_t ru;
  uid_t eu;
  uid_t su;
  gid_t rg;
  gid_t eg;
  gid_t sg;
  struct __user_cap_header_struct h = {_LINUX_CAPABILITY_VERSION_3, 0};
  struct __user_cap_data_struct d[2];
  if (setgroups(2, groups) || setresgid(r->gid, r->gid, r->gid) ||
      setresuid(r->uid, r->uid, r->uid))
    fail("drop privileges");
  if (getresuid(&ru, &eu, &su) || getresgid(&rg, &eg, &sg) ||
      getgroups(4, g) != 2)
    fail("ids after drop");
  if (ru != r->uid || eu != r->uid || su != r->uid || rg != r->gid ||
      eg != r->gid || sg != r->gid)
    refuse("ids after drop");
  if (setuid(0) != -1 || setgid(0) != -1) refuse("setuid(0) still works");
  if (syscall(SYS_capget, &h, d) != 0) fail("capget");
  if (d[0].effective || d[0].permitted || d[0].inheritable || d[1].effective ||
      d[1].permitted || d[1].inheritable)
    refuse("capabilities left after drop");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no_new_privs");
}

static void fixed_process_state(void) {
  static const struct {
    int res;
    rlim_t soft;
    rlim_t hard;
  } LIMITS[] = {
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
  struct sigaction dfl;
  for (size_t i = 0; i < sizeof LIMITS / sizeof LIMITS[0]; i++) {
    struct rlimit l = {LIMITS[i].soft, LIMITS[i].hard};
    if (setrlimit(LIMITS[i].res, &l)) fail("rlimit");
  }
  memset(&dfl, 0, sizeof dfl);
  dfl.sa_handler = SIG_DFL;
  for (int s = 1; s < NSIG; s++) sigaction(s, &dfl, NULL);
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, NULL);
  umask(027);
  if (chdir("/")) fail("chdir");
}

/* fd 0 must be open; 1 and 2 are filled so nothing else lands on them. */
static void standard_fds(void) {
  int null;
  if (fcntl(0, F_GETFD) < 0) refuse("stdin closed");
  do {
    null = open("/dev/null", O_RDWR);
  } while (null >= 0 && null < 3);
  if (null < 0) fail("/dev/null");
  if (syscall(SYS_close_range, 3, ~0U, 0) != 0)
    for (int fd = 3; fd < 65536; fd++) close(fd);
}

static void check_caller(void) {
  char buf[4096];
  struct passwd pw;
  if (!user_named(CALLER, &pw, buf, sizeof buf) || pw.pw_uid < SERVICE_ID_MIN ||
      pw.pw_uid > SERVICE_ID_MAX || getuid() != pw.pw_uid)
    refuse("caller is not " CALLER);
}

/* The registered series' lsphp: root-owned, unwritable, no set-id bits. */
static int lsphp_binary(const struct reg *r) {
  struct stat st;
  int bin = walk(r->v[K_BIN], "current", NULL);
  if (fstat(bin, &st) || !S_ISREG(st.st_mode) || st.st_uid != 0 ||
      (st.st_mode & 07022))
    refuse("lsphp binary is not root-owned, unwritable, without set-id bits");
  return bin;
}

int main(int argc, char **argv) {
  struct reg r;
  char phprc[VAL_MAX + 8];
  char children[32];
  char path_env[] = "PATH=/usr/local/bin:/usr/bin:/bin";
  char tmpdir_env[] = "TMPDIR=/tmp";
  char fork_env[] = "LSAPI_AVOID_FORK=200M";
  char lsphp_name[] = "lsphp";
  char *envp[] = {path_env, tmpdir_env, phprc, children, fork_env, NULL};
  char *lsphp_argv[] = {lsphp_name, NULL};
  gid_t entitled;
  int bin;
  int null;

  /* Nothing is opened until the first message (fd 0 may be closed). */
  openlog("tp-php-launch", LOG_PID | LOG_PERROR, LOG_AUTHPRIV);
  standard_fds();
  clearenv();

  if (geteuid() != 0) refuse("not running setuid root (no_new_privs?)");
  if (argc != 3 || !is(argv[1], "lsapi") || !site_id_ok(argv[2]))
    refuse("usage: lsapi <siteId>");
  check_caller();
  read_registry(argv[2], &r);
  check_accounts(&r);
  entitled = entitlement(&r);
  check_stdin();
  bin = lsphp_binary(&r);

  private_mounts(&r, argv[2]);
  fixed_process_state();
  drop(&r, entitled);

  snprintf(phprc, sizeof phprc, "PHPRC=%s", r.v[K_INI]);
  snprintf(children, sizeof children, "PHP_LSAPI_CHILDREN=%u", r.children);
  syslog(LOG_AUTHPRIV | LOG_INFO, "site %s: lsphp %s as %s", argv[2],
         r.series->php, r.v[K_USER]);
  closelog();
  null = open("/dev/null", O_RDWR | O_CLOEXEC);
  if (null < 0 || dup2(null, 1) < 0 || dup2(null, 2) < 0) fail("/dev/null");
  syscall(SYS_execveat, bin, "", lsphp_argv, envp, AT_EMPTY_PATH);
  fail("exec lsphp");
}
#endif
