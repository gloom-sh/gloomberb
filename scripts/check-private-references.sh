#!/usr/bin/env bash
set -euo pipefail

# Fails when a tracked text file holds a private reference: GLO- followed by a
# number. They belong in neither code, comments, test names, scripts nor
# workflows; say what the change does instead. Scans every tracked file, not
# only a diff, so one that slips in is found on the next run. The PR text
# workflow runs it on pull requests and on pushes to main.
#
# Run it locally: ./scripts/check-private-references.sh

cd "$(git rev-parse --show-toplevel)"

pattern='GLO-[0-9]+'
hits=$(git grep -n -I -o -E "$pattern" || true)

if [ -z "$hits" ]; then
  echo "No private references found."
  exit 0
fi

count=0
while IFS=: read -r file line match; do
  count=$((count + 1))
  echo "::error file=$file,line=$line::Remove \"$match\" from this line and keep the rest of the sentence."
done <<<"$hits"

echo "Found $count private reference(s) in tracked files. Remove each one listed above." >&2
exit 1
