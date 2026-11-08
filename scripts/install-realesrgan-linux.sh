#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERSION="v0.2.5.0"
ARCHIVE="realesrgan-ncnn-vulkan-20220424-ubuntu.zip"
URL="https://github.com/xinntao/Real-ESRGAN/releases/download/${VERSION}/${ARCHIVE}"
SHA256="e5aa6eb131234b87c0c51f82b89390f5e3e642b7b70f2b9bbe95b6a285a40c96"
LICENSE_URL="https://raw.githubusercontent.com/xinntao/Real-ESRGAN-ncnn-vulkan/v0.2.0/LICENSE"
LICENSE_SHA256="5abb941454de437b0e90d78dcb72e3688f74e14bcd4e24393273cb5cd0e9c937"
INSTALL_DIR="$ROOT/.tools/realesrgan-${VERSION}"

if [[ "$(uname -s)" != "Linux" || "$(uname -m)" != "x86_64" ]]; then
  echo "This installer supports Linux x86_64 only; install a platform-matched release manually." >&2
  exit 1
fi

for tool in curl sha256sum unzip; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required installer tool '$tool' is missing." >&2
    exit 1
  fi
done

if [[ -x "$INSTALL_DIR/realesrgan-ncnn-vulkan" \
  && -f "$INSTALL_DIR/models/realesrgan-x4plus.bin" \
  && -f "$INSTALL_DIR/models/realesrgan-x4plus-anime.bin" ]]; then
  echo "Real-ESRGAN ${VERSION} is already installed at $INSTALL_DIR"
  exit 0
fi

if [[ -e "$INSTALL_DIR" ]]; then
  echo "Refusing to overwrite an incomplete install at $INSTALL_DIR" >&2
  exit 1
fi

mkdir -p "$ROOT/.tools"
WORK_DIR="$(mktemp -d)"
STAGE_DIR="$(mktemp -d "$ROOT/.tools/.realesrgan-install.XXXXXX")"
trap 'rm -rf -- "$WORK_DIR" "$STAGE_DIR"' EXIT

if [[ -n "${REALESRGAN_ARCHIVE_PATH:-}" ]]; then
  cp "$REALESRGAN_ARCHIVE_PATH" "$WORK_DIR/$ARCHIVE"
else
  curl --fail --location --retry 2 "$URL" --output "$WORK_DIR/$ARCHIVE"
fi
printf '%s  %s\n' "$SHA256" "$WORK_DIR/$ARCHIVE" | sha256sum --check --status
if [[ -n "${REALESRGAN_LICENSE_PATH:-}" ]]; then
  cp "$REALESRGAN_LICENSE_PATH" "$WORK_DIR/LICENSE"
else
  curl --fail --location --retry 2 "$LICENSE_URL" --output "$WORK_DIR/LICENSE"
fi
printf '%s  %s\n' "$LICENSE_SHA256" "$WORK_DIR/LICENSE" | sha256sum --check --status
unzip -q "$WORK_DIR/$ARCHIVE" -d "$WORK_DIR"

SOURCE_DIR="$WORK_DIR"
install -m 755 "$SOURCE_DIR/realesrgan-ncnn-vulkan" "$STAGE_DIR/realesrgan-ncnn-vulkan"
install -m 644 "$WORK_DIR/LICENSE" "$STAGE_DIR/LICENSE"
cp -a "$SOURCE_DIR/models" "$STAGE_DIR/models"
mv "$STAGE_DIR" "$INSTALL_DIR"

echo "Installed Real-ESRGAN ${VERSION} at $INSTALL_DIR"
echo "Run 'make worker-gpu' to start the native GPU worker."
