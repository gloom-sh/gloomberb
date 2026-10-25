#!/bin/sh
main() {
  set -e

  REPO="gloom-sh/gloomberb"
  INSTALL_DIR="${GLOOM_INSTALL_DIR:-${GLOOMBERB_INSTALL_DIR:-$HOME/.local/bin}}"
  APP_DIR="${GLOOM_APP_DIR:-${GLOOMBERB_APP_DIR:-/Applications}}"
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

  # Alpine and other musl systems get the musl build. The glibc one cannot load
  # its render library there. ldd names its C library; without ldd, musl's
  # dynamic loader being there decides.
  variant=""
  if [ "$os" = "linux" ]; then
    case "$(ldd --version 2>&1 || true)" in
      *musl*) variant="-musl" ;;
      *GNU*|*GLIBC*|*glibc*) ;;
      *) for loader in /lib/ld-musl-*.so.1; do
           if [ -e "$loader" ]; then variant="-musl"; fi
         done ;;
    esac
  fi

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

  # A `gloom` already in the install folder is replaced only when it is ours:
  # a link into Gloom.app (Gloomberb.app before the rename) or to the
  # `gloomberb` beside it, or the binary this script installed, which it pairs
  # with a `gloomberb` link to it. Anything else is another program's command
  # and stays as it is.
  owns_command() {
    command_path="$1"
    command_dir="$(dirname "$command_path")"
    if [ -L "$command_path" ]; then
      case "$(readlink "$command_path")" in
        gloomberb|./gloomberb|"${command_dir}/gloomberb") return 0 ;;
        */Gloom.app/Contents/Resources/gloom|*/Gloom.app/Contents/Resources/gloomberb) return 0 ;;
        */Gloomberb.app/Contents/Resources/gloom|*/Gloomberb.app/Contents/Resources/gloomberb) return 0 ;;
        *) return 1 ;;
      esac
    fi
    [ -e "$command_path" ] || return 0
    [ -L "${command_dir}/gloomberb" ] && [ "$(readlink "${command_dir}/gloomberb")" = "gloom" ]
  }

  skip_command() {
    echo "Left $1 as it is: it belongs to another program. Use gloomberb to run Gloom."
    RUN_COMMAND="gloomberb"
  }

  has_asset() {
    awk -F '\t' -v asset="$1" '$1 == asset { found = 1 } END { exit !found }' "$TMP_DIR/assets"
  }

  # Gloomberb.app is the app's name before the rename. Once Gloom.app is in
  # and the commands point at it, a copy under the old name beside it goes,
  # unless Homebrew installed that one: Homebrew moves its own when it upgrades.
  remove_legacy_app() {
    legacy_app="${APP_DIR}/Gloomberb.app"
    [ -d "$legacy_app" ] || return 0
    grep -q 'com\.vincelwt\.gloomberb' "${legacy_app}/Contents/Resources/version.json" 2>/dev/null || return 0
    for brew_prefix in /opt/homebrew /usr/local; do
      if [ -d "${brew_prefix}/Caskroom/gloomberb" ]; then
        echo "Left ${legacy_app} to Homebrew, which installed it."
        return 0
      fi
    done
    if [ -w "$APP_DIR" ]; then
      rm -rf "$legacy_app"
    else
      sudo rm -rf "$legacy_app"
    fi
    echo "Removed ${legacy_app}, the app under its name before Gloom."
  }

  install_macos_app() {
    # Releases from before the rename ship the app only as Gloomberb.app, and
    # this script is served from main, so it meets those too. Either way the
    # app goes in as Gloom.app. Without release metadata, both names are tried.
    app_assets="stable-macos-arm64-Gloom.app.zip stable-macos-arm64-Gloomberb.app.zip"
    if [ -s "$TMP_DIR/assets" ] && ! has_asset "stable-macos-arm64-Gloom.app.zip"; then
      app_assets="stable-macos-arm64-Gloomberb.app.zip"
    fi
    DEST_APP="${APP_DIR}/Gloom.app"
    DEST_CLI="${INSTALL_DIR}/gloom"

    downloaded=""
    for app_asset in $app_assets; do
      select_asset "$app_asset"
      ZIP_PATH="${TMP_DIR}/${ASSET}"
      echo "Downloading ${ASSET} from ${DOWNLOAD_URL}"
      if download_file "$DOWNLOAD_URL" "$ZIP_PATH"; then
        downloaded=1
        break
      fi
      rm -f "$ZIP_PATH"
    done
    if [ -z "$downloaded" ]; then
      echo "Combined macOS app install is not available for the latest release yet."
      echo "Falling back to the standalone terminal command."
      install_standalone_cli
      return
    fi
    echo "Will install ${DEST_APP} and link ${DEST_CLI}."

    verify_download "$ZIP_PATH"

    echo "Extracting app..."
    if command -v ditto >/dev/null 2>&1; then
      ditto -x -k "$ZIP_PATH" "$TMP_DIR"
    else
      unzip -q "$ZIP_PATH" -d "$TMP_DIR"
    fi

    APP_PATH=""
    for bundle in Gloom.app Gloomberb.app; do
      if [ -d "${TMP_DIR}/${bundle}" ]; then
        APP_PATH="${TMP_DIR}/${bundle}"
        break
      fi
    done
    if [ -z "$APP_PATH" ]; then
      echo "Error: ${ASSET} did not contain the Gloom app" >&2
      exit 1
    fi

    echo "Installing Gloom.app to ${APP_DIR}..."
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

    APP_RESOURCES="${DEST_APP}/Contents/Resources"
    if [ ! -x "${APP_RESOURCES}/gloomberb" ]; then
      echo "Error: installed app is missing the gloom terminal command" >&2
      exit 1
    fi
    # Releases from before the command's rename ship it only as gloomberb.
    APP_CLI="${APP_RESOURCES}/gloom"
    if [ ! -x "$APP_CLI" ]; then
      APP_CLI="${APP_RESOURCES}/gloomberb"
    fi

    if owns_command "$DEST_CLI"; then
      install_symlink "$APP_CLI" "$DEST_CLI"
      install_symlink "${APP_RESOURCES}/gloomberb" "${INSTALL_DIR}/gloomberb"
      echo "Installed Gloom.app to ${DEST_APP}"
      echo "Installed terminal command to ${DEST_CLI} (gloomberb runs it too)"
    else
      install_symlink "${APP_RESOURCES}/gloomberb" "${INSTALL_DIR}/gloomberb"
      echo "Installed Gloom.app to ${DEST_APP}"
      skip_command "$DEST_CLI"
    fi
    remove_legacy_app
  }

  install_standalone_cli() {
    select_asset "gloomberb-${os}-${arch}${variant}.gz"
    TMP="${TMP_DIR}/gloom"
    echo "Downloading ${ASSET} from ${DOWNLOAD_URL}"
    echo "Will install ${INSTALL_DIR}/gloom."
    if ! download_file "$DOWNLOAD_URL" "$TMP"; then
      rm -f "$TMP"
      echo "Error: ${ASSET} is not available in the latest release." >&2
      if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
        echo "Intel Macs need a release that ships ${ASSET}." >&2
        echo "Run Gloom in the browser meanwhile: https://term.gloom.sh" >&2
        echo "Intel support: https://github.com/gloom-sh/gloomberb/issues/539" >&2
      fi
      if [ "$variant" = "-musl" ]; then
        echo "musl systems such as Alpine need a release that ships ${ASSET}." >&2
        echo "Install with Bun meanwhile: bun install -g gloomberb" >&2
      fi
      exit 1
    fi

    verify_download "$TMP"

    # Decompress
    echo "Extracting..."
    mv "$TMP" "$TMP.gz"
    gunzip "$TMP.gz"
    chmod +x "$TMP"
    if ! owns_command "$INSTALL_DIR/gloom"; then
      install_file "$TMP" "$INSTALL_DIR/gloomberb"
      skip_command "$INSTALL_DIR/gloom"
      return
    fi
    install_file "$TMP" "$INSTALL_DIR/gloom"
    # The command's previous name, kept for scripts and habits. This also
    # turns an install from before the rename into a link to the new binary.
    install_symlink "gloom" "$INSTALL_DIR/gloomberb"

    echo "Installed gloom to ${INSTALL_DIR}/gloom (gloomberb runs it too)"
  }

  RUN_COMMAND="gloom"
  echo "Fetching release metadata from https://api.github.com/repos/${REPO}/releases/latest"
  : > "$TMP_DIR/assets"
  if download_file "https://api.github.com/repos/${REPO}/releases/latest" "$TMP_DIR/release.json" 2>/dev/null; then
    release_assets > "$TMP_DIR/assets"
  fi

  if [ "$os" = "darwin" ] && [ "$arch" = "arm64" ]; then
    install_macos_app
  else
    if [ "$os" = "darwin" ]; then
      echo "Intel Mac detected. The desktop app is Apple Silicon only, so this installs"
      echo "the terminal app instead."
    fi
    install_standalone_cli
  fi

  # Every musl Bun binary links libstdc++, which minimal Alpine images lack.
  if [ "$variant" = "-musl" ]; then
    libstdcxx=""
    for lib in /lib/libstdc++.so.6 /usr/lib/libstdc++.so.6 /usr/local/lib/libstdc++.so.6; do
      if [ -e "$lib" ]; then libstdcxx="$lib"; fi
    done
    if [ -z "$libstdcxx" ]; then
      echo "Warning: gloom needs libstdc++. On Alpine: apk add libstdc++"
    fi
  fi

  case ":$PATH:" in
    *":$INSTALL_DIR:"*) ;;
    *) echo "Warning: $INSTALL_DIR is not in your PATH. Add it with:"
       echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
  esac

  echo "Run '${RUN_COMMAND}' to start."
}

# Keep invocation last: a truncated download must not begin installing.
main "$@"
