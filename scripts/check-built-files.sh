#!/usr/bin/env bash
# Checks that a folder holds exactly the files the release build uploaded:
# every file named in BUILT_SHA256, with the same contents, and no other.
# BUILT_SHA256 holds the `sha256sum` lines load-registry-plugins.yml records
# before any registry plugin runs in the same workflow run; the jobs that
# publish run this on what they downloaded.
#
#   BUILT_SHA256="$(cat built.sha256)" bash scripts/check-built-files.sh dist
set -euo pipefail

dir="${1:?usage: check-built-files.sh <folder>}"
if [ -z "${BUILT_SHA256:-}" ]; then
  echo "The build recorded no checksums." >&2
  exit 1
fi

manifest="$(mktemp)"
trap 'rm -f "$manifest"' EXIT
printf '%s\n' "$BUILT_SHA256" > "$manifest"

cd "$dir"
sha256sum --check --strict --quiet "$manifest"

built="$(sed -E 's/^[0-9a-f]{64}  //' "$manifest" | LC_ALL=C sort)"
present="$(find . -type f | sed 's|^\./||' | LC_ALL=C sort)"
if [ "$built" != "$present" ]; then
  echo "Files the build did not upload:" >&2
  LC_ALL=C comm -13 <(printf '%s\n' "$built") <(printf '%s\n' "$present") >&2
  exit 1
fi
echo "$(printf '%s\n' "$built" | wc -l | tr -d ' ') files are the ones built."
