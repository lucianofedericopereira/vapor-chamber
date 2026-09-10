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

# 2. Library IIFEs — build the repo dist/ on demand, then copy into public/.
#    Two variants, one per page: `core` for /cart (no Vue) and `elements` for
#    /widget (defineWidget + emitDOMEvent, which core deliberately omits).
#    Only the LIBRARY is copied; Vue and Alpine come from a CDN on the page that
#    needs them, so nothing third-party is vendored into the demo.
if [ ! -f "$REPO/dist/vapor-chamber-core.iife.min.js" ]; then
  echo "[setup] building vapor-chamber dist/ ..."
  (cd "$REPO" && npm install && npm run build)
fi
mkdir -p "$TARGET/public/js"
cp "$REPO/dist/vapor-chamber-core.iife.min.js"     "$TARGET/public/js/"
cp "$REPO/dist/vapor-chamber-elements.iife.min.js" "$TARGET/public/js/"

# 3. Drop in the demo files. The controller is the audited drop-in companion
#    from ../laravel-backend — one source, no duplication.
mkdir -p "$TARGET/app/Actions/Cart" "$TARGET/app/Http/Controllers"
cp "$HERE/app/Actions/Cart/"*.php           "$TARGET/app/Actions/Cart/"
cp "$HERE/../laravel-backend/VaporChamberController.php" "$TARGET/app/Http/Controllers/"
cp "$HERE/config/vapor-chamber.php"         "$TARGET/config/"
cp "$HERE/resources/views/cart.blade.php"   "$TARGET/resources/views/"
cp "$HERE/resources/views/widget.blade.php" "$TARGET/resources/views/"

# 4. Routes — REPLACE our block, don't just skip when present.
#    The old guard was `grep -q VaporChamberController || append`, which is
#    idempotent but not update-safe: a demo-app scaffolded before a route was
#    added to this example kept the stale block forever, so `/widget` never
#    appeared on a re-run and the only symptom was a 404. Dropping our block
#    (marker to EOF) and re-appending makes a re-run pick up whatever this
#    example currently defines. `perl -i`, not `sed -i`: macOS ships BSD sed,
#    whose -i takes a mandatory suffix argument.
WEB="$TARGET/routes/web.php"
MARKER='vapor-chamber demo routes'
if grep -q "$MARKER" "$WEB"; then
  VC_MARKER="$MARKER" perl -i -ne 'if (index($_, $ENV{VC_MARKER}) >= 0) { $d = 1 } print unless $d' "$WEB"
fi
# strip the <?php opener before appending into the existing file
tail -n +2 "$HERE/routes/append-to-web.php" >> "$WEB"

echo
echo "[setup] done. Run it:"
echo "  cd $TARGET && php artisan serve"
echo "  open http://127.0.0.1:8000/cart"
