/*
 * Test stand-in for lsphp: records the process state tp-php-launch handed it
 * in /tmp/tp-php-launch-report (the owner's tmp/, if the bind mount worked),
 * one key=value per line, then exits 0.
 */
#define _GNU_SOURCE
#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <unistd.h>

extern char **environ;

static void status_lines(FILE *out) {
  char line[256];
  FILE *f = fopen("/proc/self/status", "r");
  if (!f) return;
  while (fgets(line, sizeof line, f))
    if (!strncmp(line, "NoNewPrivs:", 11) || !strncmp(line, "Cap", 3))
      fprintf(out, "status.%s", line);
  fclose(f);
}

static void fd_lines(FILE *out) {
  DIR *d = opendir("/proc/self/fd");
  struct dirent *e;
  if (!d) return;
  while ((e = readdir(d)))
    if (e->d_name[0] != '.' && atoi(e->d_name) != dirfd(d) &&
        atoi(e->d_name) != fileno(out))
      fprintf(out, "fd=%s\n", e->d_name);
  closedir(d);
}

int main(int argc, char **argv) {
  uid_t r, e, s;
  gid_t rg, eg, sg, groups[64];
  int n, v = 0;
  socklen_t l = sizeof v;
  mode_t mask = umask(0);
  struct rlimit core;
  char cwd[256];
  FILE *out;
  umask(mask);
  out = fopen("/tmp/tp-php-launch-report", "w");
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
  fprintf(out, "umask=%03o\n", mask);
  getrlimit(RLIMIT_CORE, &core);
  fprintf(out, "rlimit.core=%llu\n", (unsigned long long)core.rlim_cur);
  fprintf(out, "cwd=%s\n", getcwd(cwd, sizeof cwd) ? cwd : "?");
  fprintf(out, "setuid0=%d\n", setuid(0));
  {
    const char *rc = getenv("PHPRC");
    FILE *ini = rc ? fopen(rc, "r") : NULL;
    DIR *d = opendir("/etc/turbopanel");
    struct dirent *de;
    fprintf(out, "phprc.readable=%d\n", ini != NULL);
    if (ini) fclose(ini);
    while (d && (de = readdir(d)))
      if (de->d_name[0] != '.') fprintf(out, "etc_turbopanel=%s\n", de->d_name);
    if (d) closedir(d);
  }
  status_lines(out);
  fd_lines(out);
  fclose(out);
  return 0;
}
