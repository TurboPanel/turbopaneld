/*
 * Fuzz harness for tp-php-launch's registry parser (tp_parse_registry).
 *
 * libFuzzer (Linux, clang):
 *   clang -g -O1 -fsanitize=fuzzer,address,undefined \
 *     -o fuzz-registry scripts/tp-php-launch/fuzz-registry.c
 *   ./fuzz-registry -runs=2000000 scripts/tp-php-launch/corpus
 *
 * Without libFuzzer (any cc; add -fsanitize=address,undefined where offered):
 *   cc -DTP_FUZZ_STANDALONE -g -O1 -fsanitize=address,undefined \
 *     -o fuzz-registry scripts/tp-php-launch/fuzz-registry.c
 *   ./fuzz-registry ITERATIONS SEED-FILE...
 *   (mutates the seed files with a fixed-seed generator).
 *
 * Besides memory safety, every accepted entry must satisfy the launcher's
 * invariants; a violation aborts.
 */
#define TP_LAUNCH_NO_MAIN
#include "../../orchestration/scripts/tp-php-launch.c"

#include <stdint.h>
#include <stdio.h>

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size);

static void must(int ok) {
  if (!ok) abort();
}

int LLVMFuzzerTestOneInput(const uint8_t *data, size_t size) {
  struct reg r;
  char want[VAL_MAX * 2];
  if (tp_parse_registry((const char *)data, size, "shop-1", &r)) return 0;
  must(r.uid >= PRINCIPAL_ID_MIN && r.uid <= PRINCIPAL_ID_MAX);
  must(r.gid >= PRINCIPAL_ID_MIN && r.gid <= PRINCIPAL_ID_MAX);
  must(r.children >= 1 && r.children <= 64);
  must(r.series != NULL);
  must(is(r.v[K_MODE], "lsphp-attached") && is(r.v[K_SITE], "shop-1"));
  must(user_name_ok(r.v[K_USER]));
  snprintf(want, sizeof want, PRINCIPALS "/%s/tmp", r.v[K_USER]);
  must(is(r.v[K_TMP], want));
  for (int k = 0; k < K_COUNT; k++) must(strlen(r.v[k]) > 0);
  return 0;
}

#ifdef TP_FUZZ_STANDALONE
static uint64_t state = 0x9e3779b97f4a7c15ULL;
static uint64_t next(void) {
  state ^= state << 13;
  state ^= state >> 7;
  state ^= state << 17;
  return state;
}

int main(int argc, char **argv) {
  static uint8_t seeds[64][REG_MAX + 64], buf[REG_MAX * 2];
  static size_t lens[64];
  int nseeds = 0;
  long iterations = argc > 1 ? atol(argv[1]) : 100000;
  for (int i = 2; i < argc && nseeds < 64; i++) {
    FILE *f = fopen(argv[i], "rb");
    if (!f) continue;
    lens[nseeds] = fread(seeds[nseeds], 1, sizeof seeds[0], f);
    fclose(f);
    LLVMFuzzerTestOneInput(seeds[nseeds], lens[nseeds]);
    nseeds++;
  }
  if (nseeds == 0) {
    fprintf(stderr, "fuzz-registry: no seed files\n");
    return 2;
  }
  for (long it = 0; it < iterations; it++) {
    size_t s = (size_t)(next() % (uint64_t)nseeds), len = lens[s];
    memcpy(buf, seeds[s], len);
    for (int m = (int)(next() % 8); m >= 0; m--) {
      size_t at = len ? (size_t)(next() % len) : 0;
      switch (next() % 6) {
        case 0: if (len) buf[at] = (uint8_t)next(); break;
        case 1: if (len) buf[at] ^= (uint8_t)(1u << (next() % 8)); break;
        case 2: if (len) { memmove(buf + at, buf + at + 1, len - at - 1); len--; } break;
        case 3:
          if (len < sizeof buf - 1) {
            memmove(buf + at + 1, buf + at, len - at);
            buf[at] = "=\n\r0-a/9\0"[next() % 9];
            len++;
          }
          break;
        case 4: { /* duplicate a span */
          size_t n = (size_t)(next() % 64);
          if (at + n <= len && len + n < sizeof buf) {
            memmove(buf + at + n, buf + at, len - at);
            len += n;
          }
          break;
        }
        default: len = len ? (size_t)(next() % (len + 1)) : 0; break;
      }
    }
    LLVMFuzzerTestOneInput(buf, len);
  }
  printf("fuzz-registry: %ld iterations, no crash or invariant violation\n",
         iterations);
  return 0;
}
#endif
