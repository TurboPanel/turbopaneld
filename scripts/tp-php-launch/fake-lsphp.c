/*
 * Test stand-in for lsphp: records the process state tp-php-launch handed it
 * in /tmp/tp-php-launch-report (the owner's tmp/, if the bind mount worked),
 * one key=value per line, then exits 0. SITE_INI (-DSITE_INI="...") is the
 * php.ini the launcher should have made readable.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef SITE_INI
#define SITE_INI "/etc/turbopanel/php/sites/shop-1/php.ini"
#endif

extern char **environ;

/* NoNewPrivs, Umask and the capability sets, as numbers. */
static void status_fields(FILE *out) {
  static const char *const FIELDS[] = {"NoNewPrivs", "Umask", "CapPrm",
                                       "CapEff", "CapAmb"};
  char line[256];
  FILE *f = fopen("/proc/self/status", "r");
  if (!f) return;
  while (fgets(line, sizeof line, f)) {
    for (size_t i = 0; i < sizeof FIELDS / sizeof FIELDS[0]; i++) {
      size_t n = strlen(FIELDS[i]);
      unsigned long long v = 0;
      if (strncmp(line, FIELDS[i], n) != 0 || line[n] != ':') continue;
      if (i == 1) {
        v = strtoull(line + n + 1, NULL, 8);
        fprintf(out, "status.%s=%03llo\n", FIELDS[i], v);
      } else {
        v = strtoull(line + n + 1, NULL, 16);
        fprintf(out, "status.%s=%llx\n", FIELDS[i], v);
      }
    }
  }
  fclose(f);
}

static void fd_lines(FILE *out) {
  DIR *d = opendir("/proc/self/fd");
  struct dirent *e;
  if (!d) return;
  e = readdir(d);
  while (e) {
    int fd = atoi(e->d_name);
    if (e->d_name[0] != '.' && fd != dirfd(d) && fd != fileno(out))
      fprintf(out, "fd=%d\n", fd);
    e = readdir(d);
  }
  closedir(d);
}

static void config_view(FILE *out) {
  struct stat st;
  int ini = open(SITE_INI, O_RDONLY);
  fprintf(out, "ini.readable=%d\n", ini >= 0);
  if (ini >= 0) close(ini);
  fprintf(out, "etc_turbopanel.secrets=%d\n",
          stat("/etc/turbopanel/secrets", &st) == 0);
  fprintf(out, "etc_turbopanel.writable=%d\n",
          access("/etc/turbopanel/php", W_OK) == 0);
}

int main(int argc, char **argv) {
  uid_t r;
  uid_t e;
  uid_t s;
  gid_t rg;
  gid_t eg;
  gid_t sg;
  gid_t groups[64];
  int n;
  int v = 0;
  socklen_t l = sizeof v;
  struct rlimit core;
  char cwd[256];
  FILE *out;
  int root = open("/", O_RDONLY | O_DIRECTORY);
  int fd = openat(root, "tmp/tp-php-launch-report",
                  O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0600);
  close(root);
  if (fd < 0) return 3;
  out = fdopen(fd, "w");
  if (!out) return 3;
  getresuid(&r, &e, &s);
  getresgid(&rg, &eg, &sg);
  fprintf(out, "argc=%d\nargv0=%s\n", argc, argv[0]);
  fprintf(out, "uid=%u,%u,%u\ngid=%u,%u,%u\n", r, e, s, rg, eg, sg);
  n = getgroups(64, groups);
  for (int i = 0; i < n; i++) fprintf(out, "group=%u\n", groups[i]);
  for (char **p = environ; *p; p++) fprintf(out, "env=%s\n", *p);
  getsockopt(0, SOL_SOCKET, SO_ACCEPTCONN, &v, &l);
  fprintf(out, "stdin.listening=%d\n", v);
  getrlimit(RLIMIT_CORE, &core);
  fprintf(out, "rlimit.core=%llu\n", (unsigned long long)core.rlim_cur);
  fprintf(out, "cwd=%s\n", getcwd(cwd, sizeof cwd) ? cwd : "?");
  fprintf(out, "setuid0=%d\n", setuid(0));
  config_view(out);
  status_fields(out);
  fd_lines(out);
  fclose(out);
  return 0;
}
