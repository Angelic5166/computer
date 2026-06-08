#!/usr/bin/env bash
# Benchmark common development tasks against the wsd FUSE mount.
# Compares against a tmpfs/native baseline so you can see the overhead.
#
# Usage (inside the container):
#   MOUNT=/workspace fs-bench           # bench just the mount
#   MOUNT=/workspace BASE=/tmp fs-bench # also bench /tmp for comparison
#
# Knobs (environment variables):
#   REPS=5               repetitions per scenario per target (default: 1)
#   WARMUP=1             warmup reps per scenario per target, untimed (default: 1)
#   RANDOMIZE_TARGETS=1  shuffle target order per rep to avoid cache-order
#                        bias (default: 1; set to 0 for deterministic order)
#   OUTPUT_JSON=path     also write a JSON summary to `path`
#   TRACE_FILE=path      hint: set WSD_FUSE_TRACE=summary and
#                        WSD_FUSE_TRACE_FILE on the daemon side to capture
#                        FUSE op stats; this script does not start wsd.
#
# Note: if the workspace mount is owned by another uid the script file
# may not be executable in place. Run it via `bash ./script/fs-bench.sh`
# instead of `./script/fs-bench.sh` in that case.
set -u

MOUNT="${MOUNT:-/workspace}"
BASE="${BASE:-}"            # optional baseline (e.g. /tmp) for comparison
REPS="${REPS:-1}"           # timed repetitions per scenario per target
WARMUP="${WARMUP:-1}"       # warmup (untimed) repetitions per scenario per target
RANDOMIZE_TARGETS="${RANDOMIZE_TARGETS:-1}"
OUTPUT_JSON="${OUTPUT_JSON:-}"

# results format: NAME|LABEL|MEAN_NS|MEDIAN_NS|P95_NS|MIN_NS|MAX_NS|SAMPLES
results=()

have() { command -v "$1" >/dev/null 2>&1; }

# Print ms with 1 decimal.
fmt_ms() { awk -v n="$1" 'BEGIN{printf "%.1f", n/1000000}'; }

# Measure wall time in ns using `date +%s%N` (works on linux GNU date).
now_ns() { date +%s%N; }

# Sort a whitespace-separated list of integers ascending.
sort_ints() { tr ' ' '\n' | sort -n; }

# Compute mean/median/p95/min/max from a sorted list of ints on stdin.
# Prints: mean median p95 min max
stats_from_sorted() {
  awk '
    NF == 0 { next }
    { samples[++n] = $1; sum += $1 }
    END {
      NR = n
      if (NR == 0) { print "0 0 0 0 0"; exit }
      mean = int(sum / NR)
      if (NR % 2 == 1) median = samples[(NR + 1) / 2]
      else             median = int((samples[NR / 2] + samples[NR / 2 + 1]) / 2)
      # Nearest-rank: index = ceil(0.95 * NR), 1-based.
      rank = int(0.95 * NR)
      if (rank < 0.95 * NR) rank++
      if (rank < 1) rank = 1
      if (rank > NR) rank = NR
      printf "%d %d %d %d %d\n", mean, median, samples[rank], samples[1], samples[NR]
    }
  '
}

# Shuffle the positional args (preserves them in $SHUFFLED, space-separated).
# Deterministic order when RANDOMIZE_TARGETS=0.
shuffle_targets() {
  if [[ "$RANDOMIZE_TARGETS" == "0" ]]; then
    SHUFFLED="$*"
    return
  fi
  # `shuf` is in coreutils on debian-slim; we already depend on it via the
  # benchmark container image.
  SHUFFLED=$(printf '%s\n' "$@" | shuf | tr '\n' ' ')
}

label_for() {
  if [[ "$1" == "$MOUNT" ]]; then echo "wsd"; else echo "base"; fi
}

# Run one (scenario, target) pair once, returning wall-clock ns on stdout
# or "FAIL" on failure. Caller is responsible for setup/teardown messaging.
run_once() {
  local base_dir="$1" cmd="$2"
  local dir="$base_dir/.bench.$$.$RANDOM"
  rm -rf "$dir" 2>/dev/null
  mkdir -p "$dir"
  local t0 t1
  t0=$(now_ns)
  if ! (cd "$dir" && eval "$cmd") >/dev/null 2>&1; then
    rm -rf "$dir" 2>/dev/null
    echo "FAIL"
    return
  fi
  t1=$(now_ns)
  rm -rf "$dir" 2>/dev/null
  echo $(( t1 - t0 ))
}

# Run a scenario across all targets with warmup + REPS timed reps. Records
# one entry per (scenario, target) in `results` containing aggregate stats.
run_scenario() {
  local name="$1" cmd="$2"

  # Per-target sample lists, one ns per rep.
  declare -A samples
  declare -A failed
  for t in "${TARGETS[@]}"; do
    samples[$t]=""
    failed[$t]=0
  done

  # Warmup: untimed, randomized order, don't touch samples.
  local w
  for ((w=0; w<WARMUP; w++)); do
    shuffle_targets "${TARGETS[@]}"
    for t in $SHUFFLED; do
      local r
      r=$(run_once "$t" "$cmd")
      if [[ "$r" == "FAIL" ]]; then failed[$t]=1; fi
    done
  done

  # Timed reps, also randomized.
  local i
  for ((i=0; i<REPS; i++)); do
    shuffle_targets "${TARGETS[@]}"
    for t in $SHUFFLED; do
      if [[ "${failed[$t]}" == "1" ]]; then continue; fi
      local r
      r=$(run_once "$t" "$cmd")
      if [[ "$r" == "FAIL" ]]; then
        failed[$t]=1
        continue
      fi
      samples[$t]="${samples[$t]} $r"
    done
  done

  for t in "${TARGETS[@]}"; do
    local label
    label=$(label_for "$t")
    if [[ "${failed[$t]}" == "1" ]]; then
      printf "  \033[31mFAIL\033[0m  %-30s on %s\n" "$name" "$label"
      continue
    fi
    local s
    s=$(echo "${samples[$t]}" | sort_ints | stats_from_sorted)
    # s = "mean median p95 min max"
    local mean median p95 mn mx
    read -r mean median p95 mn mx <<<"$s"
    local count
    count=$(echo "${samples[$t]}" | wc -w)
    printf "  \033[32mOK\033[0m    %-30s %s  mean=%s med=%s p95=%s ms (n=%d)\n" \
      "$name" "$label" "$(fmt_ms $mean)" "$(fmt_ms $median)" "$(fmt_ms $p95)" "$count"
    results+=("$name|$label|$mean|$median|$p95|$mn|$mx|$count")
  done
}

section() { printf "\n\033[1m=== %s ===\033[0m\n" "$1"; }

if [[ ! -d "$MOUNT" ]]; then
  echo "mount point $MOUNT does not exist" >&2
  exit 1
fi

declare -a TARGETS=("$MOUNT")
[[ -n "$BASE" && -d "$BASE" ]] && TARGETS+=("$BASE")

printf "config: REPS=%s WARMUP=%s RANDOMIZE_TARGETS=%s targets=%s\n" \
  "$REPS" "$WARMUP" "$RANDOMIZE_TARGETS" "${TARGETS[*]}"

section "tiny file churn (1000 files)"
run_scenario "create 1000 files" '
  for i in $(seq 1 1000); do echo $i > f$i; done
'
run_scenario "stat 1000 files" '
  for i in $(seq 1 1000); do echo $i > f$i; done
  for i in $(seq 1 1000); do stat f$i; done
'
run_scenario "rm 1000 files" '
  for i in $(seq 1 1000); do echo $i > f$i; done
  rm f*
'

section "directory traversal"
run_scenario "mkdir tree (10x10x10)" '
  for a in $(seq 1 10); do
    for b in $(seq 1 10); do
      mkdir -p $a/$b
      for c in $(seq 1 10); do touch $a/$b/$c; done
    done
  done
'
run_scenario "find tree" '
  for a in $(seq 1 10); do
    for b in $(seq 1 10); do
      mkdir -p $a/$b
      for c in $(seq 1 10); do touch $a/$b/$c; done
    done
  done
  find . -type f | wc -l
'

section "large file I/O"
run_scenario "write 64 MiB" '
  dd if=/dev/zero of=big bs=1M count=64 status=none
'
run_scenario "copy 64 MiB" '
  dd if=/dev/zero of=big bs=1M count=64 status=none
  cp big big2
'
run_scenario "read 64 MiB" '
  dd if=/dev/zero of=big bs=1M count=64 status=none
  cat big > /dev/null
'

if have git; then
  section "git"
  run_scenario "git init + commit 100 files" '
    git init -q
    for i in $(seq 1 100); do echo $i > f$i; done
    git add -A
    git -c user.email=a@b -c user.name=a commit -qm init
  '
  # Tiny repo clone; pick something small and stable.
  # Use --depth 1 to keep it light.
  run_scenario "git clone (shallow, ~1MB)" '
    git clone --depth 1 -q https://github.com/git-fixtures/empty.git r 2>/dev/null \
      || git clone --depth 1 -q https://github.com/octocat/Hello-World.git r
  '
else
  echo "  SKIP  git scenarios (git not installed)"
fi

if have npm; then
  section "npm"
  run_scenario "npm init + tiny install" '
    cat > package.json <<JSON
{"name":"b","version":"0.0.0","dependencies":{"is-number":"7.0.0"}}
JSON
    npm install --no-audit --no-fund --silent --prefer-offline 2>&1
  '
else
  echo "  SKIP  npm scenarios (npm not installed)"
fi

if have go; then
  section "go"
  run_scenario "go mod init + build hello" '
    go mod init bench >/dev/null
    cat > main.go <<GO
package main
import "fmt"
func main(){ fmt.Println("hi") }
GO
    go build -o hello .
  '
else
  echo "  SKIP  go scenarios (go not installed)"
fi

section "summary"
if (( ${#TARGETS[@]} > 1 )); then
  printf "  %-30s %12s %12s %12s %12s %10s\n" \
    "scenario" "wsd mean" "wsd p95" "base mean" "base p95" "ratio"
  declare -A wsd_mean wsd_p95 base_mean base_p95
  for r in "${results[@]}"; do
    IFS='|' read -r name label mean median p95 mn mx count <<<"$r"
    if [[ "$label" == "wsd" ]]; then
      wsd_mean[$name]=$mean; wsd_p95[$name]=$p95
    else
      base_mean[$name]=$mean; base_p95[$name]=$p95
    fi
  done
  for name in "${!wsd_mean[@]}"; do
    wm="${wsd_mean[$name]}"; wp="${wsd_p95[$name]}"
    bm="${base_mean[$name]:-0}"; bp="${base_p95[$name]:-0}"
    if [[ "$bm" != "0" ]]; then
      ratio=$(awk -v w="$wm" -v b="$bm" 'BEGIN{printf "%.2fx", w/b}')
    else
      ratio="-"
    fi
    printf "  %-30s %12s %12s %12s %12s %10s\n" "$name" \
      "$(fmt_ms $wm) ms" "$(fmt_ms $wp) ms" \
      "$(fmt_ms $bm) ms" "$(fmt_ms $bp) ms" "$ratio"
  done | sort
else
  printf "  %-30s %12s %12s\n" "scenario" "mean (ms)" "p95 (ms)"
  for r in "${results[@]}"; do
    IFS='|' read -r name label mean median p95 mn mx count <<<"$r"
    printf "  %-30s %12s %12s\n" "$name" "$(fmt_ms $mean)" "$(fmt_ms $p95)"
  done
fi

# JSON output. One object per (scenario, target) pair, plus run config.
# Times are in nanoseconds; consumers can divide as they prefer.
if [[ -n "$OUTPUT_JSON" ]]; then
  {
    printf '{\n'
    printf '  "config": {"reps": %s, "warmup": %s, "randomizeTargets": %s, "mount": "%s", "base": "%s"},\n' \
      "$REPS" "$WARMUP" "$RANDOMIZE_TARGETS" "$MOUNT" "$BASE"
    printf '  "results": [\n'
    local_first=1
    for r in "${results[@]}"; do
      IFS='|' read -r name label mean median p95 mn mx count <<<"$r"
      if [[ "$local_first" == "1" ]]; then local_first=0; else printf ',\n'; fi
      # JSON-escape the scenario name (only quotes/backslashes are realistic here).
      esc_name=${name//\\/\\\\}
      esc_name=${esc_name//\"/\\\"}
      printf '    {"scenario": "%s", "target": "%s", "meanNs": %s, "medianNs": %s, "p95Ns": %s, "minNs": %s, "maxNs": %s, "samples": %s}' \
        "$esc_name" "$label" "$mean" "$median" "$p95" "$mn" "$mx" "$count"
    done
    printf '\n  ]\n}\n'
  } > "$OUTPUT_JSON"
  echo "wrote JSON summary to $OUTPUT_JSON"
fi
