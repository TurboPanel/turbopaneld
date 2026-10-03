/*
 * Test helper: put a chosen kind of descriptor on fd 0, then exec a command.
 *
 *   sockwrap KIND PATH CMD [ARG...]
 *
 * KIND: listen (AF_UNIX stream, listening: what OpenLiteSpeed hands lsphp),
 * unlistened (AF_UNIX stream, bound but not listening), dgram (AF_UNIX
 * datagram), tcp (listening TCP on 127.0.0.1, PATH ignored), file (PATH opened
 * read-only), closed (fd 0 closed, PATH ignored).
 */
#define _GNU_SOURCE
#include <netinet/in.h>
#include <stdio.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <fcntl.h>
#include <unistd.h>

static int unix_socket(int type, const char *path, int do_listen) {
  struct sockaddr_un a;
  int fd = socket(AF_UNIX, type, 0);
  memset(&a, 0, sizeof a);
  a.sun_family = AF_UNIX;
  snprintf(a.sun_path, sizeof a.sun_path, "%s", path);
  unlink(path);
  if (fd < 0 || bind(fd, (struct sockaddr *)&a, sizeof a) != 0) return -1;
  if (do_listen && listen(fd, 16) != 0) return -1;
  return fd;
}

static int tcp_socket(void) {
  struct sockaddr_in a;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  memset(&a, 0, sizeof a);
  a.sin_family = AF_INET;
  a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  if (fd < 0 || bind(fd, (struct sockaddr *)&a, sizeof a) != 0) return -1;
  return listen(fd, 16) == 0 ? fd : -1;
}

int main(int argc, char **argv) {
  int fd = -1;
  if (argc < 4) {
    fprintf(stderr, "usage: sockwrap KIND PATH CMD [ARG...]\n");
    return 2;
  }
  if (strcmp(argv[1], "listen") == 0) fd = unix_socket(SOCK_STREAM, argv[2], 1);
  else if (strcmp(argv[1], "unlistened") == 0)
    fd = unix_socket(SOCK_STREAM, argv[2], 0);
  else if (strcmp(argv[1], "dgram") == 0) fd = unix_socket(SOCK_DGRAM, argv[2], 0);
  else if (strcmp(argv[1], "tcp") == 0) fd = tcp_socket();
  else if (strcmp(argv[1], "file") == 0) fd = open(argv[2], O_RDONLY);
  else if (strcmp(argv[1], "closed") == 0) {
    close(0);
    execv(argv[3], argv + 3);
    return 127;
  }
  if (fd < 0 || dup2(fd, 0) != 0) {
    perror("sockwrap");
    return 2;
  }
  if (fd != 0) close(fd);
  execv(argv[3], argv + 3);
  perror("sockwrap: exec");
  return 127;
}
