#!/usr/bin/env bash
# Every check this repo has, in one command:
#
#   bash scripts/verify.sh
#
# Rust runs in Docker because the native MSVC toolchain on this machine cannot
# load rustc (0xC0E90002). Nothing here touches the running stack or your data.
set -uo pipefail
cd "$(dirname "$0")/.."
fail=0
step() { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }
check() { if [ "$1" -ne 0 ]; then echo "FAILED: $2"; fail=1; fi; }

step "engine (Rust)"
if docker info >/dev/null 2>&1; then
  docker run --rm -v "//$(pwd | sed 's|^/||; s|^\([a-zA-Z]\):|\1|')/services/engine://app" \
    -w //app rust:1.83-slim cargo test --workspace 2>&1 | grep -E "^test result|^error" 
  check "${PIPESTATUS[0]}" "cargo test"
else
  echo "SKIPPED: Docker is not running."
fi

step "api-gateway"
(cd services/api-gateway && npx tsc --noEmit && npx jest 2>&1 | grep -E "Tests:|FAIL")
check $? "api-gateway"

step "ai-analysis"
(cd services/ai-analysis && npx tsc --noEmit && npx jest 2>&1 | grep -E "Tests:|FAIL")
check $? "ai-analysis"

step "web"
(cd apps/web && npx tsc --noEmit && npm run build >/dev/null && echo "build ok")
check $? "web build"
node apps/web/checks/stats.check.ts
check $? "web stats self-check"

if [ "$fail" -eq 0 ]; then printf '\n\033[1mAll checks passed.\033[0m\n'; else printf '\n\033[1mSomething failed — see above.\033[0m\n'; fi
exit "$fail"
