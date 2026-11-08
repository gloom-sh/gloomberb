#!/usr/bin/env bash
set -euo pipefail

# Publishes review screenshots and evidence images for a pull request without
# a branch or a commit to the tree. The files go into a commit pushed to
# refs/pr-assets/<slug>: a commit with no parent the first time, and one on top
# of the last for every later run with the same slug, so earlier links keep
# working. A clone fetches branches and tags only, so these never weigh on one,
# and GitHub serves them by commit sha. Prints a markdown image link per file,
# ready for the pull request description.
#
#   ./scripts/pr-assets.sh <slug> <file>...
#
# The slug names what the pictures show (chart-crosshair, positions-import), in
# lowercase letters, digits, dots, dashes and underscores; one that looks like
# a tracker id is refused, as is a file name that does. The working tree, the
# index and every branch stay as they are. PR_ASSETS_REMOTE picks the remote
# (origin by default); PR_ASSETS_REPO (owner/repo) names the GitHub repository
# the links point at when the remote's URL is not GitHub's.

usage() {
  echo "Usage: $0 <slug> <file>..." >&2
  exit 2
}

fail() {
  echo "pr-assets: $*" >&2
  exit 1
}

# A tracker id is letters, a dash or an underscore, then digits, as a word of
# its own: abc-123, abc_12. Dates and versions pass (chart-2026-11-08, v0.17).
looks_like_tracker_id() {
  printf '%s\n' "$1" \
    | sed -E 's/[0-9]{4}-[0-9]{2}(-[0-9]{2})?//g' \
    | grep -qiE '(^|[^a-z0-9])[a-z]{2,6}[-_][0-9]+([^a-z0-9]|$)'
}

# Percent-encodes every byte but unreserved URL characters.
url_encode() {
  local LC_ALL=C text="$1" out="" char code i
  for ((i = 0; i < ${#text}; i++)); do
    char="${text:i:1}"
    case "$char" in
      [A-Za-z0-9._~-]) out+="$char" ;;
      *)
        # Some shells read a byte over 127 as negative.
        code=$(printf '%d' "'$char")
        out+=$(printf '%%%02X' $((code & 255)))
        ;;
    esac
  done
  printf '%s' "$out"
}

[ $# -ge 2 ] || usage
slug="$1"
shift

[[ "$slug" =~ ^[a-z0-9]+([._-][a-z0-9]+)*$ ]] \
  || fail "the slug \"$slug\" must be lowercase letters and digits, joined by single dots, dashes or underscores."
looks_like_tracker_id "$slug" \
  && fail "the slug \"$slug\" looks like a tracker id (letters, a dash, a number). Name it after what the pictures show."

names=()
for file in "$@"; do
  [ -f "$file" ] || fail "$file is not a file."
  name="${file##*/}"
  [[ "$name" =~ \.([Pp][Nn][Gg]|[Jj][Pp][Ee]?[Gg]|[Gg][Ii][Ff]|[Ww][Ee][Bb][Pp])$ ]] \
    || fail "$name is not a PNG, JPEG, GIF or WebP image."
  looks_like_tracker_id "${name%.*}" && fail "the file name $name looks like a tracker id (letters, a dash, a number). Rename it after what it shows."
  for seen in "${names[@]+"${names[@]}"}"; do
    [ "$seen" != "$name" ] || fail "two files are named $name."
  done
  names+=("$name")
done

remote="${PR_ASSETS_REMOTE:-origin}"
ref="refs/pr-assets/$slug"
case "$ref" in
  refs/pr-assets/*) ;;
  *) fail "refusing to push to $ref." ;;
esac

repo="${PR_ASSETS_REPO:-}"
if [ -z "$repo" ]; then
  url=$(git remote get-url "$remote") || fail "no remote named $remote."
  if [[ "$url" =~ github\.com[:/]([^/]+)/([^/]+)$ ]]; then
    repo="${BASH_REMATCH[1]}/${BASH_REMATCH[2]%.git}"
  else
    fail "$remote ($url) is not on GitHub; set PR_ASSETS_REPO=owner/repo for the links."
  fi
fi

# The slug's last commit, when an earlier run made one.
parent=$(git ls-remote --refs "$remote" "$ref" | awk -v ref="$ref" '$2 == ref { print $1 }')

index=$(mktemp "${TMPDIR:-/tmp}/pr-assets-index.XXXXXX")
trap 'rm -f "$index"' EXIT
rm -f "$index"
export GIT_INDEX_FILE="$index"

if [ -n "$parent" ]; then
  git fetch --quiet --no-tags --no-write-fetch-head "$remote" "$ref"
  git cat-file -e "$parent^{commit}" 2>/dev/null || fail "could not fetch $ref from $remote."
  git read-tree "$parent"
else
  git read-tree --empty
fi

i=0
for file in "$@"; do
  blob=$(git hash-object -w -- "$file")
  git update-index --add --cacheinfo "100644,$blob,${names[$i]}"
  i=$((i + 1))
done
tree=$(git write-tree)

if [ -n "$parent" ] && [ "$tree" = "$(git rev-parse "$parent^{tree}")" ]; then
  # Every file is already there as it is: the last commit serves them.
  commit="$parent"
else
  message="Pictures for $slug: ${names[*]}"
  if [ -n "$parent" ]; then
    commit=$(git commit-tree "$tree" -p "$parent" -m "$message")
  else
    commit=$(git commit-tree "$tree" -m "$message")
  fi
  # No force: if another run moved the ref since it was read, this push is
  # refused rather than dropping that run's pictures.
  git push --quiet "$remote" "$commit:$ref"
fi

for name in "${names[@]}"; do
  printf '![%s](https://raw.githubusercontent.com/%s/%s/%s)\n' "${name%.*}" "$repo" "$commit" "$(url_encode "$name")"
done
