#!/usr/bin/env bash
set -euo pipefail

# Bump version, commit, tag, and push.
# Called by release.sh after selecting the version.

usage() {
  cat <<'EOF'
Usage: ./scripts/bump-version.sh <version> [--skip-push]

Steps:
1. Update package.json
2. Commit package.json as v<version>
3. Create tag v<version>
4. Push commit and tag with git push --atomic origin HEAD v<version>

Options:
  --skip-push   Prepare the release locally without pushing to origin
EOF
}

VERSION=""
SKIP_PUSH=0

for arg in "$@"; do
  case "$arg" in
    -h|--help)
      usage
      exit 0
      ;;
    --skip-push)
      SKIP_PUSH=1
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

if [[ -n "$(git status --porcelain)" ]]; then
  echo "error: working tree must be clean before releasing" >&2
  exit 1
fi

CURRENT_VERSION="$(bun -e 'const pkg = JSON.parse(await Bun.file("package.json").text()); console.log(pkg.version);')"
if [[ "$VERSION" == "$CURRENT_VERSION" ]]; then
  echo "error: version $VERSION is already current" >&2
  exit 1
fi

TAG="v$VERSION"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "error: tag $TAG already exists" >&2
  exit 1
fi

bun -e '
  const path = "package.json";
  const pkg = JSON.parse(await Bun.file(path).text());
  pkg.version = process.argv[1];
  await Bun.write(path, `${JSON.stringify(pkg, null, 2)}\n`);
' "$VERSION"

git add package.json
git commit -m "$TAG"
git tag -a "$TAG" -m "$TAG"

if [[ "$SKIP_PUSH" -eq 1 ]]; then
  echo "Prepared $TAG locally. Skipping push."
  exit 0
fi

git push --atomic origin HEAD "$TAG"
