#!/usr/bin/env bash
# vapor-chamber — scaffold a runnable Laravel demo around the example files.
#
# Usage:  ./setup.sh [target-dir]      (default: ./demo-app)
# Needs:  php >= 8.2, composer. The vapor-chamber IIFE is taken from the
#         repo's dist/ (built automatically if missing).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$HERE/../.."
TARGET="${1:-$HERE/demo-app}"

# 1. Fresh Laravel skeleton (skipped if the target already exists).
if [ ! -d "$TARGET" ]; then
  composer create-project laravel/laravel "$TARGET" --prefer-dist --no-interaction
fi

# 2. Library IIFE — build the repo dist/ on demand, then copy into public/.
if [ ! -f "$REPO/dist/vapor-chamber-core.iife.min.js" ]; then
  echo "[setup] building vapor-chamber dist/ ..."
  (cd "$REPO" && npm install && npm run build)
fi
mkdir -p "$TARGET/public/js"
cp "$REPO/dist/vapor-chamber-core.iife.min.js" "$TARGET/public/js/"

# 3. Drop in the demo files. The controller is the audited drop-in companion
#    from ../laravel-backend — one source, no duplication.
mkdir -p "$TARGET/app/Actions/Cart" "$TARGET/app/Http/Controllers"
cp "$HERE/app/Actions/Cart/"*.php           "$TARGET/app/Actions/Cart/"
cp "$HERE/../laravel-backend/VaporChamberController.php" "$TARGET/app/Http/Controllers/"
cp "$HERE/config/vapor-chamber.php"         "$TARGET/config/"
cp "$HERE/resources/views/cart.blade.php"   "$TARGET/resources/views/"

# 4. Routes — append once (idempotent re-runs).
if ! grep -q VaporChamberController "$TARGET/routes/web.php"; then
  # strip the <?php opener before appending into the existing file
  tail -n +2 "$HERE/routes/append-to-web.php" >> "$TARGET/routes/web.php"
fi

echo
echo "[setup] done. Run it:"
echo "  cd $TARGET && php artisan serve"
echo "  open http://127.0.0.1:8000/cart"
