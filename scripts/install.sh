#!/bin/sh
set -e

REPO="gloom-sh/gloomberb"
INSTALL_DIR="${GLOOMBERB_INSTALL_DIR:-$HOME/.local/bin}"
APP_DIR="${GLOOMBERB_APP_DIR:-/Applications}"

# Detect platform
OS="$(uname -s)"
ARCH="$(uname -m)"

case "$OS" in
  Darwin) os="darwin" ;;
  Linux)  os="linux" ;;
  *)
    echo "Unsupported OS: $OS"
    exit 1
    ;;
esac

case "$ARCH" in
  arm64|aarch64) arch="arm64" ;;
  x86_64|amd64)  arch="x64" ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

# Apple Silicon shells under Rosetta report x86_64. Genuine Intel Macs cannot
# run the arm64 app and must fail instead of downloading a bad binary.
if [ "$os" = "darwin" ] && [ "$arch" = "x64" ]; then
  translated="$(sysctl -n sysctl.proc_translated 2>/dev/null || true)"
  has_arm64="$(sysctl -n hw.optional.arm64 2>/dev/null || true)"
  if [ "$translated" = "1" ] || [ "$has_arm64" = "1" ]; then
    arch="arm64"
  else
    echo "Intel Macs are not supported. Gloomberb currently ships Apple Silicon (arm64) only."
    exit 1
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
    echo "Error: curl or wget required"
    exit 1
  fi
}

install_file() {
  src="$1"
  dest="$2"
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  if [ -w "$dir" ]; then
    mv "$src" "$dest"
  else
    echo "Installing to ${dest} (requires sudo)..."
    sudo mv "$src" "$dest"
  fi
}

install_symlink() {
  target="$1"
  dest="$2"
  dir="$(dirname "$dest")"
  mkdir -p "$dir"
  if [ -w "$dir" ]; then
    ln -sfn "$target" "$dest"
  else
    echo "Linking ${dest} (requires sudo)..."
    sudo ln -sfn "$target" "$dest"
  fi
}

install_macos_app() {
  ASSET="stable-macos-arm64-Gloomberb.app.zip"
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"
  TMP_DIR="$(mktemp -d)"
  ZIP_PATH="${TMP_DIR}/${ASSET}"
  APP_PATH="${TMP_DIR}/Gloomberb.app"
  DEST_APP="${APP_DIR}/Gloomberb.app"
  DEST_CLI="${INSTALL_DIR}/gloomberb"

  echo "Fetching latest macOS release..."
  echo "Downloading ${ASSET}..."
  if ! download_file "$DOWNLOAD_URL" "$ZIP_PATH"; then
    rm -rf "$TMP_DIR"
    echo "Combined macOS app install is not available for the latest release yet."
    echo "Falling back to the standalone terminal command."
    install_standalone_cli
    return
  fi

  echo "Extracting app..."
  if command -v ditto >/dev/null 2>&1; then
    ditto -x -k "$ZIP_PATH" "$TMP_DIR"
  else
    unzip -q "$ZIP_PATH" -d "$TMP_DIR"
  fi

  if [ ! -d "$APP_PATH" ]; then
    echo "Error: ${ASSET} did not contain Gloomberb.app"
    exit 1
  fi

  echo "Installing Gloomberb.app to ${APP_DIR}..."
  mkdir -p "$APP_DIR" 2>/dev/null || true
  if [ -w "$APP_DIR" ]; then
    rm -rf "$DEST_APP"
    mv "$APP_PATH" "$DEST_APP"
  else
    echo "Installing app to ${APP_DIR} (requires sudo)..."
    sudo rm -rf "$DEST_APP"
    sudo mv "$APP_PATH" "$DEST_APP"
  fi

  APP_CLI="${DEST_APP}/Contents/Resources/gloomberb"
  if [ ! -x "$APP_CLI" ]; then
    echo "Error: installed app is missing the gloomberb terminal shim"
    exit 1
  fi

  install_symlink "$APP_CLI" "$DEST_CLI"
  rm -rf "$TMP_DIR"

  echo "Installed Gloomberb.app to ${DEST_APP}"
  echo "Installed terminal command to ${DEST_CLI}"
}

install_standalone_cli() {
  ASSET="gloomberb-${os}-${arch}.gz"

  # Get latest release download URL
  echo "Fetching latest release..."
  DOWNLOAD_URL="https://github.com/${REPO}/releases/latest/download/${ASSET}"

  # Download
  TMP="$(mktemp)"
  echo "Downloading ${ASSET}..."
  download_file "$DOWNLOAD_URL" "$TMP"

  # Decompress
  echo "Extracting..."
  mv "$TMP" "$TMP.gz"
  gunzip "$TMP.gz"
  chmod +x "$TMP"
  install_file "$TMP" "$INSTALL_DIR/gloomberb"

  echo "Installed gloomberb to ${INSTALL_DIR}/gloomberb"
}

if [ "$os" = "darwin" ]; then
  install_macos_app
else
  install_standalone_cli
fi

case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *) echo "Warning: $INSTALL_DIR is not in your PATH. Add it with:"
     echo "  export PATH=\"$INSTALL_DIR:\$PATH\"" ;;
esac

echo "Run 'gloomberb' to start."
