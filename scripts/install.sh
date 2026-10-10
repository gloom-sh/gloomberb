#!/bin/sh
main() {
  set -e

  REPO="gloom-sh/gloomberb"
  INSTALL_DIR="${GLOOMBERB_INSTALL_DIR:-$HOME/.local/bin}"
  APP_DIR="${GLOOMBERB_APP_DIR:-/Applications}"
  TMP_DIR="$(mktemp -d)"
  trap 'rm -rf "$TMP_DIR"' EXIT
  trap 'exit 1' HUP INT TERM

  # Detect platform
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *)
      echo "Unsupported OS: $OS" >&2
      exit 1
      ;;
  esac

  case "$ARCH" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *)
      echo "Unsupported architecture: $ARCH" >&2
      exit 1
      ;;
  esac

  # Apple Silicon shells under Rosetta report x86_64, and they still want the
  # arm64 build. Genuine Intel Macs keep x64 and get the terminal app, because
  # the desktop app bundle is published for Apple Silicon only.
  if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
    translated="$(sysctl -n sysctl.proc_translated 2>/dev/null || true)"
    has_arm64="$(sysctl -n hw.optional.arm64 2>/dev/null || true)"
    if [ "$translated" = "1" ] || [ "$has_arm64" = "1" ]; then
      arch="arm64"
    fi
  fi

  download_file() {
    url="$1"
    dest="$2"
    if command -v curl >/dev/null 2>&1; then
      curl -fSL --progress-bar "$url" -o "$dest"
    elif command -v wget >/dev/null 2>&1; then
      wget -q --show-progress "$url" -O "$dest"
    else
      echo "Error: curl or wget required" >&2
      exit 1
    fi
  }

  # Read only asset names, digests and URLs. Track object depth so nested uploader
  # fields and escaped strings cannot be mistaken for release asset metadata.
  release_assets() {
    awk '
      {
        for (i = 1; i <= length($0); i++) {
          c = substr($0, i, 1)
          if (quoted) {
            if (escaped) { value = value c; escaped = 0 }
            else if (c == "\\") escaped = 1
            else if (c == "\"") {
              quoted = 0
              if (is_key[depth]) { key[depth] = value; is_key[depth] = 0 }
              else if (key[depth] == "name" || key[depth] == "digest" || key[depth] == "browser_download_url")
                fields[depth, key[depth]] = value
            } else value = value c
          } else if (c == "\"") { quoted = 1; value = "" }
          else if (c == "{") { depth++; is_key[depth] = 1 }
          else if (c == "}") {
            if (fields[depth, "browser_download_url"] != "")
              printf "%s\t%s\t%s\n", fields[depth, "name"], fields[depth, "digest"], fields[depth, "browser_download_url"]
            delete fields[depth, "name"]
            delete fields[depth, "digest"]
            delete fields[depth, "browser_download_url"]
            depth--
          } else if (c == ",") is_key[depth] = 1
        }
      }
    ' "$TMP_DIR/release.json"
  }

  select_asset() {
    ASSET="$1"
    DOWNLOAD_URL="$(awk -F '\t' -v asset="$ASSET" '$1 == asset { print $3; exit }' "$TMP_DIR/assets")"
    # If metadata is unavailable, retain the existing latest-release install path.
    if [ -z "$DOWNLOAD_URL" ]; then
      DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
    fi
  }

  checksum_digest() {
    awk -F '\t' -v asset="$ASSET" '
      $1 == asset ".sha256" || tolower($1) ~ /^(sha256sums?|checksums?)(\.sha256)?(\.txt)?$/ {
        print $1 " " $3
      }
    ' "$TMP_DIR/assets" | while read -r checksum_name checksum_url; do
      if download_file "$checksum_url" "$TMP_DIR/checksums" 2>/dev/null; then
        checksum="$(awk -v asset="$ASSET" -v sidecar="$checksum_name" '
          $2 == asset || $2 == "*" asset || $2 == "./" asset { print $1; exit }
          $1 == "SHA256" && $2 == "(" asset ")" && $3 == "=" { print $4; exit }
          NF == 1 && sidecar == asset ".sha256" { print $1; exit }
        ' "$TMP_DIR/checksums")"
        if printf '%s\n' "$checksum" | grep -Eq '^[[:xdigit:]]{64}$'; then
          printf '%s\n' "$checksum"
          break
        fi
      fi
    done
  }

  verify_download() {
    expected="$(awk -F '\t' -v asset="$ASSET" '$1 == asset && $2 ~ /^sha256:/ { sub(/^sha256:/, "", $2); print $2; exit }' "$TMP_DIR/assets")"
    if ! printf '%s\n' "$expected" | grep -Eq '^[[:xdigit:]]{64}$'; then
      expected="$(checksum_digest)"
    fi
    if [ -z "$expected" ]; then
      echo "Warning: could not obtain a SHA-256 digest or checksum file for ${ASSET}." >&2
      echo "Continuing without checksum verification." >&2
      return
    fi

    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$1" | awk '{ print $1 }')"
    elif command -v shasum >/dev/null 2>&1; then
      actual="$(shasum -a 256 "$1" | awk '{ print $1 }')"
    else
      echo "Error: sha256sum or shasum is required to verify this download." >&2
      exit 1
    fi
    expected="$(printf '%s' "$expected" | tr 'A-F' 'a-f')"
    if [ "$actual" != "$expected" ]; then
      echo "Error: SHA-256 mismatch for ${ASSET}. Nothing was installed." >&2
      exit 1
    fi
    echo "Verified SHA-256 for ${ASSET}."
  }

  install_file() {
    src="$1"
    dest="$2"
    dir="$(dirname "$dest")"
    mkdir -p "$dir" 2>/dev/null || true
    if [ -w "$dir" ]; then
      mv "$src" "$dest"
    else
      echo "Installing to ${dest} (requires sudo)..."
      sudo mkdir -p "$dir"
      sudo mv "$src" "$dest"
    fi
  }

  install_symlink() {
    target="$1"
    dest="$2"
    dir="$(dirname "$dest")"
    mkdir -p "$dir" 2>/dev/null || true
    if [ -w "$dir" ]; then
      ln -sfn "$target" "$dest"
    else
      echo "Linking ${dest} (requires sudo)..."
      sudo mkdir -p "$dir"
      sudo ln -sfn "$target" "$dest"
    fi
  }

  install_macos_app() {
    select_asset "stable-macos-arm64-Gloomberb.app.zip"
    ZIP_PATH="${TMP_DIR}/${ASSET}"
    APP_PATH="${TMP_DIR}/Gloomberb.app"
    DEST_APP="${APP_DIR}/Gloomberb.app"
    DEST_CLI="${INSTALL_DIR}/gloomberb"

    echo "Downloading ${ASSET} from ${DOWNLOAD_URL}"
    echo "Will install ${DEST_APP} and link ${DEST_CLI}."
    if ! download_file "$DOWNLOAD_URL" "$ZIP_PATH"; then
      echo "Combined macOS app install is not available for the latest release yet."
      echo "Falling back to the standalone terminal command."
      install_standalone_cli
      return
    fi

    verify_download "$ZIP_PATH"

    echo "Extracting app..."
    if command -v ditto >/dev/null 2>&1; then
      ditto -x -k "$ZIP_PATH" "$TMP_DIR"
    else
      unzip -q "$ZIP_PATH" -d "$TMP_DIR"
    fi

    if [ ! -d "$APP_PATH" ]; then
      echo "Error: ${ASSET} did not contain Gloomberb.app" >&2
      exit 1
    fi

    echo "Installing Gloomberb.app to ${APP_DIR}..."
    mkdir -p "$APP_DIR" 2>/dev/null || true
    if [ -w "$APP_DIR" ]; then
      rm -rf "$DEST_APP"
      mv "$APP_PATH" "$DEST_APP"
    else
      echo "Installing app to ${APP_DIR} (requires sudo)..."
      sudo mkdir -p "$APP_DIR"
      sudo rm -rf "$DEST_APP"
      sudo mv "$APP_PATH" "$DEST_APP"
    fi

    APP_CLI="${DEST_APP}/Contents/Resources/gloomberb"
    if [ ! -x "$APP_CLI" ]; then
      echo "Error: installed app is missing the gloomberb terminal shim" >&2
      exit 1
    fi

    install_symlink "$APP_CLI" "$DEST_CLI"

    echo "Installed Gloomberb.app to ${DEST_APP}"
    echo "Installed terminal command to ${DEST_CLI}"
  }

  install_standalone_cli() {
    select_asset "gloomberb-${os}-${arch}.gz"
    TMP="${TMP_DIR}/gloomberb"
    echo "Downloading ${ASSET} from ${DOWNLOAD_URL}"
    echo "Will install ${INSTALL_DIR}/gloomberb."
    if ! download_file "$DOWNLOAD_URL" "$TMP"; then
      rm -f "$TMP"
      echo "Error: ${ASSET} is not available in the latest release." >&2
      if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
        echo "Intel Macs need a release that ships ${ASSET}." >&2
        echo "Run Gloomberb in the browser meanwhile: https://term.gloom.sh" >&2
        echo "Intel support: https://github.com/gloom-sh/gloomberb/issues/539" >&2
      fi
      exit 1
    fi

    verify_download "$TMP"

    # Decompress
    echo "Extracting..."
    mv "$TMP" "$TMP.gz"
    gunzip "$TMP.gz"
    chmod +x "$TMP"
    install_file "$TMP" "$INSTALL_DIR/gloomberb"

    echo "Installed gloomberb to ${INSTALL_DIR}/gloomberb"
  }

  echo "Fetching release metadata from https://api.github.com/repos/${REPO}/releases/latest"
  : > "$TMP_DIR/assets"
  if download_file "https://api.github.com/repos/${REPO}/releases/latest" "$TMP_DIR/release.json" 2>/dev/null; then
    release_assets > "$TMP_DIR/assets"
  fi

  if [ "$os" = "darwin" ] && [ "$arch" = "arm64" ]; then
    install_macos_app
  else
    if [ "$os" = "darwin" ]; then
      echo "Intel Mac detected. Gloomberb.app is Apple Silicon only, so this installs"
      echo "the terminal app instead."
    fi
    install_standalone_cli
  fi

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) echo "Warning: $INSTALL_DIR is not in your PATH. Add it with:"
       echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
  esac

  echo "Run 'gloomberb' to start."
}

# Keep invocation last: a truncated download must not begin installing.
main "$@"
