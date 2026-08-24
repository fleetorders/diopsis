#!/usr/bin/env sh
# etymd: content screen — the published ARTIFACT, not the repository.
#
# Wire it into the irreversible moment:
#   package.json → "prepublishOnly": "./scripts/artifact-check.sh"
#
# The artifact gate is the one check that sees what actually SHIPS — bypass with
# .etymd-screen-allow entries (with provenance) if you must exempt a string.
set -eu

GATE="${CONTENT_GATE:-$(command -v etymd || true)}"
[ -x "$GATE" ] || { echo "› artifact-check: no checker installed — skipping."; exit 0; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT INT TERM

# Pack exactly what would ship, then screen the unpacked bytes.
if [ -f package.json ]; then
  npm pack --pack-destination "$WORK" >/dev/null 2>&1 || {
    echo "› artifact-check: npm pack failed — cannot verify what would ship" >&2; exit 1; }
  tar -xzf "$WORK"/*.tgz -C "$WORK" 2>/dev/null || true
fi

if ! "$GATE" screen --dir "$WORK"; then
  "$GATE" screen --help >/dev/null 2>&1 ||
    echo "etymd: this checker does not understand 'screen' (needs etymd 0.11+) — upgrade it, or set CONTENT_GATE to a checker that does." >&2
  exit 1
fi
exit 0
# etymd:generated pack-v12 2cff669174dd425e
