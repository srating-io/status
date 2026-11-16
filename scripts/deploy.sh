#!/bin/bash

# Publish the page: copy public/ into the directory nginx serves status.srating.io from.
#
# Copies over what is there and deletes nothing. The json the prober writes lives in ../data, not
# here, but a box still on the old one-directory layout keeps its status.json this way too.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="${STATUS_HTML_PATH:-/var/www/status.srating.io/html}"

mkdir -p "$TARGET"
cp -r "$SCRIPT_DIR/../public/." "$TARGET/"

echo "Deployed $(git -C "$SCRIPT_DIR/.." rev-parse --short HEAD 2>/dev/null || echo 'unknown') to $TARGET"
