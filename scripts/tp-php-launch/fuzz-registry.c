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
#define MAX_SEEDS 64
#define BUF_CAP (REG_MAX * 2)

static uint64_t state = 0x9e3779b97f4a7c15ULL;
static uint64_t next(void) {
  state ^= state << 13;
  state ^= state >> 7;
  state ^= state << 17;
  return state;
}

static size_t pick(size_t n) { return n ? (size_t)(next() % n) : 0; }

static size_t delete_byte(uint8_t *buf, size_t len, size_t at) {
  if (!len) return len;
  memmove(buf + at, buf + at + 1, len - at - 1);
  return len - 1;
}

static size_t insert_byte(uint8_t *buf, size_t len, size_t at) {
  static const char INTERESTING[] = "=\n\r0-a/9";
  if (len + 1 >= BUF_CAP) return len;
  memmove(buf + at + 1, buf + at, len - at);
  buf[at] = (uint8_t)INTERESTING[pick(sizeof INTERESTING)];
  return len + 1;
}

/* Duplicate the span that starts at AT. */
static size_t duplicate_span(uint8_t *buf, size_t len, size_t at) {
  size_t n = pick(64);
  if (at + n > len || len + n >= BUF_CAP) return len;
  memmove(buf + at + n, buf + at, len - at);
  return len + n;
}

/* One random edit; returns the new length. */
static size_t mutate(uint8_t *buf, size_t len) {
  size_t at = pick(len);
  switch (next() % 6) {
    case 0:
      if (len) buf[at] = (uint8_t)next();
      return len;
    case 1:
      if (len) buf[at] ^= (uint8_t)(1u << pick(8));
      return len;
    case 2:
      return delete_byte(buf, len, at);
    case 3:
      return insert_byte(buf, len, at);
    case 4:
      return duplicate_span(buf, len, at);
    default:
      return pick(len + 1);
  }
}

static int load_seeds(int argc, char **argv, uint8_t seeds[][REG_MAX + 64],
                      size_t *lens) {
  int n = 0;
  for (int i = 2; i < argc; i++) {
    FILE *f;
    if (n == MAX_SEEDS) break;
    f = fopen(argv[i], "rb");
    if (!f) continue;
    lens[n] = fread(seeds[n], 1, REG_MAX + 64, f);
    fclose(f);
    LLVMFuzzerTestOneInput(seeds[n], lens[n]);
    n++;
  }
  return n;
}

int main(int argc, char **argv) {
  static uint8_t seeds[MAX_SEEDS][REG_MAX + 64];
  static uint8_t buf[BUF_CAP];
  static size_t lens[MAX_SEEDS];
  long iterations = argc > 1 ? atol(argv[1]) : 100000;
  int nseeds = load_seeds(argc, argv, seeds, lens);
  if (nseeds == 0) {
    fprintf(stderr, "fuzz-registry: no seed files\n");
    return 2;
  }
  for (long it = 0; it < iterations; it++) {
    size_t s = pick((size_t)nseeds);
    size_t len = lens[s];
    size_t rounds = pick(8) + 1;
    memcpy(buf, seeds[s], len);
    for (size_t m = 0; m < rounds; m++) len = mutate(buf, len);
    LLVMFuzzerTestOneInput(buf, len);
  }
  printf("fuzz-registry: %ld iterations, no crash or invariant violation\n",
         iterations);
  return 0;
}
#endif
