#!/usr/bin/env bash
# Reminds a session to update docs/STATE.md when it has changed code and not
# the handoff. Advisory only: it prints, it never blocks and never edits.
#
# STATE.md is what the next session reads to know where things stand. It goes
# stale silently, and a stale handoff is worse than none — so the reminder is
# mechanical rather than something a session has to remember.
set -uo pipefail
cd "$CLAUDE_PROJECT_DIR" 2>/dev/null || exit 0

# Code touched since STATE.md was last committed, staged or not.
since=$(git log -1 --format=%H -- docs/STATE.md 2>/dev/null) || exit 0
[ -n "$since" ] || exit 0

changed=$(git diff --name-only "$since" HEAD -- services apps infra 2>/dev/null | head -20)
dirty=$(git status --porcelain -- services apps infra 2>/dev/null | head -20)

if [ -n "$changed" ] || [ -n "$dirty" ]; then
  n=$(printf '%s\n%s' "$changed" "$dirty" | grep -c .)
  echo "docs/STATE.md has not been updated since $n code file(s) changed."
  echo "If this session changed what is built, what is open, or how to run it, update it before stopping."
fi
