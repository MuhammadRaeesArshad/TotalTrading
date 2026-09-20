#!/usr/bin/env bash
# The load-bearing rules in CLAUDE.md, as checks.
#
# Prose rules get broken quietly — by a tired session, by a smaller model, by
# someone in a hurry. A rule with a check behind it fails loudly instead, in
# the same run as the tests. Every rule here is one a grep can actually decide;
# the rest (no lookahead, pessimistic costs, versioning) are pinned by the Rust
# tests, which is why they are not repeated here.
#
# Read-only. Touches no service and no data.
set -uo pipefail
cd "$(dirname "$0")/../.."

fails=0
# Markdown is excluded because the docs quote the very strings the rules ban —
# a CLAUDE.md explaining that `order_send` is forbidden must not itself fail.
SKIP=(':!*/node_modules/*' ':!*/.venv/*' ':!*/target/*' ':!*/dist/*'
      ':!*.md' ':!scripts/checks/rules.sh')

# Greps tracked files only, so a stray build artefact never fails the build.
# -E, not the default: this git grep does not treat BRE \| as alternation,
# which made every multi-alternative check pass silently.
hits() { git grep -nIE "$1" -- "${@:2}" "${SKIP[@]}" 2>/dev/null; }

check() { # check <rule> <explanation> <offending output>
  if [ -n "$3" ]; then
    printf '\033[31mFAIL\033[0m  %s\n      %s\n' "$1" "$2"
    printf '        %s\n' "$3" | head -10
    fails=$((fails + 1))
  else
    printf '\033[32mok\033[0m    %s\n' "$1"
  fi
}

check "rule 1 · detection lives only in engine-core" \
  "A second Detector implementation means a rule can mean two things." \
  "$(hits 'impl Detector for' -- services ':!services/engine/crates/engine-core/*')"

check "rule 2 · only mt5-connector imports MetaTrader5" \
  "Broker awareness outside mt5_gateway.py makes swapping brokers a rewrite." \
  "$(hits '^[[:space:]]*(import|from) MetaTrader5' -- . ':!services/mt5-connector/app/mt5_gateway.py')"

check "rule 3 · only the gateway talks to Mongo" \
  "A second writer is a second definition of the same document." \
  "$(hits '@nestjs/mongoose|mongoose' -- services apps ':!services/api-gateway/*')"

check "rule 3 · schemas/ exists only in the gateway" \
  "Document shapes are defined once." \
  "$(ls -d services/*/src/schemas 2>/dev/null | grep -v api-gateway)"

check "rule 7/9 · ai-analysis has no database" \
  "The LLM writes prose about computed figures; it stores nothing and detects nothing." \
  "$(hits 'MongooseModule|mongodb://' -- services/ai-analysis)"

# A comment naming the downstream consumer is documentation; a URL or an env
# var is a dependency. Only the second one breaks the rule.
check "rule 9 · the engine cannot reach ai-analysis" \
  "AI is an add-on. Nothing in the critical path may call it or wait on it." \
  "$(hits 'AI_ANALYSIS_URL|ai-analysis:[0-9]|//ai-analysis' -- services/engine)"

check "rule 8 · no order execution anywhere" \
  "Execution stays off until demo parity is proven. Not a default, not behind a flag." \
  "$(hits 'order_send|order_check|OrderSend' -- services)"

check "engine-core stays pure: mmap is its only I/O" \
  "No async, no HTTP, no Mongo, no Redis — that is what keeps it callable from a test." \
  "$(sed -n '/\[dependencies\]/,$p' services/engine/crates/engine-core/Cargo.toml |
     grep -n -E 'tokio|axum|reqwest|hyper|mongodb|redis|sqlx')"

check "packages/contracts is not imported until it exists" \
  "Importing a package that does not exist breaks every build at once." \
  "$([ -d packages/contracts ] || hits '@totaltrading/contracts' -- services apps)"

echo
if [ "$fails" -gt 0 ]; then
  printf '\033[31m%d rule(s) broken.\033[0m See CLAUDE.md.\n' "$fails"
  exit 1
fi
printf '\033[1mArchitecture rules hold.\033[0m\n'
