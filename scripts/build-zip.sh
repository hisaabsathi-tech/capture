#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="${ROOT_DIR}/dist"
WORK_DIR="${DIST_DIR}/hisaabsathi-capture"

cd "${ROOT_DIR}"

VERSION="$(node -e "process.stdout.write(require('./manifest.json').version)")"
ZIP_NAME="Hisaabsathi Capture v${VERSION}.zip"
ZIP_PATH="${DIST_DIR}/${ZIP_NAME}"

rm -rf "${WORK_DIR}" "${ZIP_PATH}"
mkdir -p "${WORK_DIR}" "${DIST_DIR}"

copy_path() {
  local path="$1"
  if [[ ! -e "${path}" ]]; then
    echo "Missing required extension path: ${path}" >&2
    exit 1
  fi
  mkdir -p "${WORK_DIR}/$(dirname "${path}")"
  cp -R "${path}" "${WORK_DIR}/${path}"
}

copy_path "manifest.json"
copy_path "background.js"
copy_path "sidepanel.html"
copy_path "sidepanel.css"
copy_path "sidepanel.js"
copy_path "assets-logo.png"
copy_path "lib"
copy_path "adapters"
copy_path "icons"

find "${WORK_DIR}" -name ".DS_Store" -delete

(
  cd "${WORK_DIR}"
  zip -qr "${ZIP_PATH}" .
)

echo "${ZIP_PATH}"
