#!/usr/bin/env bash
set -euo pipefail

REPO="gloom-sh/gloomberb"

usage() {
  cat <<'EOF'
Usage: ./scripts/release.sh <version>

Arguments:
  version    Version to release, in X.Y.Z format

Steps:
1. Find the latest published GitHub release
2. Run ./scripts/bump-version.sh <version> to bump, commit, tag, and push
3. Create a draft GitHub release with clean notes from commit/PR titles
4. Edit the draft release before publishing:
   - Add 3-5 user-facing highlights for substantial releases
   - Group large releases by area instead of keeping one long flat list
   - Remove release-only maintenance noise unless it matters to users
   - Keep PR references as compact #123 links
   - Never publish generated "by @user in https://..." notes
EOF
}

build_release_notes() {
  local notes_file="$1"
  local previous_tag="$2"
  local current_tag="$3"
  local range="$current_tag"
  local changes_file

  if [[ -n "$previous_tag" ]]; then
    range="$previous_tag..$current_tag"
  fi

  changes_file="$(mktemp "${TMPDIR:-/tmp}/gloomberb-release-changes-$current_tag.XXXXXX")"
  git log --reverse --format='%s' "$range" \
    | sed -E "s/[[:space:]]+\\(#([0-9]+)\\)$/ #\\1/" \
    | awk '
        /^v[0-9]+\.[0-9]+\.[0-9]+$/ { next }
        /^Merge pull request #[0-9]+/ { next }
        /^release script$/ { next }
        /^Update release automation runner$/ { next }
        /^Make release script self-contained$/ { next }
        /^Create clean release notes drafts$/ { next }
        /^Fix clean release notes draft generation$/ { next }
        !seen[$0]++ { print "- " $0 }
      ' > "$changes_file"

  {
    cat <<EOF
## Changes

EOF

    if [[ -s "$changes_file" ]]; then
      cat "$changes_file"
    else
      echo "- Release packaging and maintenance updates."
    fi

    if [[ -n "$previous_tag" ]]; then
      printf '\n[Full diff](https://github.com/%s/compare/%s...%s)\n' "$REPO" "$previous_tag" "$current_tag"
    else
      printf '\n[Full diff](https://github.com/%s/commits/%s)\n' "$REPO" "$current_tag"
    fi
  } > "$notes_file"

  rm -f "$changes_file"
}

VERSION=""

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      if [[ -n "$VERSION" ]]; then
        echo "error: unexpected argument: $arg" >&2
        usage >&2
        exit 1
      fi
      VERSION="$arg"
      ;;
  esac
done

if [[ -z "$VERSION" ]]; then
  echo "error: version is required" >&2
  usage >&2
  exit 1
fi

if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "error: version must be in X.Y.Z format" >&2
  exit 1
fi

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

for cmd in bun gh git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "error: required command not found: $cmd" >&2
    exit 1
  fi
done

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree must be clean before releasing" >&2
  exit 1
fi

TAG="v$VERSION"

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "error: local tag $TAG already exists" >&2
  exit 1
fi

if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "error: remote tag $TAG already exists" >&2
  exit 1
fi

LATEST_RELEASE_TAG="$(gh release view --repo "$REPO" --json tagName --jq '.tagName' 2>/dev/null || true)"
if [[ -n "$LATEST_RELEASE_TAG" ]]; then
  echo "Latest published release: $LATEST_RELEASE_TAG"
else
  echo "Latest published release: none"
fi

./scripts/bump-version.sh "$VERSION"

NOTES_FILE="$(mktemp "${TMPDIR:-/tmp}/gloomberb-release-notes-$TAG.XXXXXX")"
build_release_notes "$NOTES_FILE" "$LATEST_RELEASE_TAG" "$TAG"

create_args=(
  release create "$TAG"
  --repo "$REPO"
  --draft
  --verify-tag
  --title "$TAG"
  --notes-file "$NOTES_FILE"
)

gh "${create_args[@]}"

echo "Created draft release $TAG. The tag-triggered GitHub Actions workflow will build and upload assets."
echo
echo "Clean the draft release before publishing:"
echo "- Add a Highlights section with 3-5 user-facing bullets for substantial releases."
echo "- Group a long Changes list by area when the release is large."
echo "- Remove release-only maintenance noise unless it matters to users."
echo "- Keep PR references compact, like #123."
echo "- Do not publish generated author/full-URL notes."
echo
echo "Draft notes source: $NOTES_FILE"
