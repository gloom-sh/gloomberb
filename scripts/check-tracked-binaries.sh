#!/usr/bin/env bash
set -euo pipefail

# Fails when a tracked file is a picture or a video outside the folders that
# hold the app's and the docs' own images, or when any tracked file is over
# 1 MiB. Every clone downloads every version of every file ever merged, so a
# review screenshot committed once weighs on every clone after it: attach
# those to the pull request description instead. Scans every tracked file, not
# only a diff. The PR text workflow runs it on pull requests and on pushes to
# main.
#
# Run it locally: ./scripts/check-tracked-binaries.sh

cd "$(git rev-parse --show-toplevel)"

max_bytes=$((1024 * 1024))

# Each staged path with its size, read from the index so a file staged for the
# next commit counts too. Submodules (mode 160000) have no blob to size.
hits=$(git ls-files --stage \
  | awk -F '\t' '$1 !~ /^160000/ { split($1, entry, " "); print entry[2] " " $2 }' \
  | git cat-file --batch-check='%(objectsize) %(rest)' \
  | awk -v max="$max_bytes" '
      {
        size = $1
        path = substr($0, length($1) + 2)
        if (size > max) {
          printf "%s\tThis file is %.1f MiB; keep tracked files under 1 MiB.\n", path, size / 1048576
        } else if (tolower(path) ~ /\.(png|jpe?g|gif|webp|avif|bmp|tiff?|heic|mp4|mov|webm|mkv)$/ && path !~ /^(assets|docs\/assets|src\/assets|icon\.iconset|plugin-icons)\//) {
          printf "%s\tA picture or video outside assets/, docs/assets/, src/assets/, icon.iconset/ and plugin-icons/; attach screenshots to the pull request instead.\n", path
        }
      }')

if [ -z "$hits" ]; then
  echo "No oversized files or stray pictures found."
  exit 0
fi

count=0
while IFS=$'\t' read -r file message; do
  count=$((count + 1))
  echo "::error file=$file::$message"
done <<<"$hits"

echo "Found $count oversized file(s) or stray picture(s). Remove each one listed above." >&2
exit 1
