#!/usr/bin/env bash
# vapor-chamber - scaffold a runnable Laravel demo around the example files.
#
# Usage:  ./setup.sh [target-dir]      (default: ./demo-app)
# Needs:  php >= 8.3 (Laravel 13), composer. The vapor-chamber IIFE is taken from the
#         repo's dist/ (built automatically if missing).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$HERE/../.."
TARGET="${1:-$HERE/demo-app}"

# 1. Fresh Laravel skeleton (skipped if the target already exists).
if [ ! -d "$TARGET" ]; then
  composer create-project laravel/laravel "$TARGET" --prefer-dist --no-interaction
fi

# 2. Library IIFEs - build the repo dist/ on demand, then copy into public/.
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
#    from ../laravel-backend - one source, no duplication.
mkdir -p "$TARGET/app/Actions/Cart" "$TARGET/app/Http/Controllers"
cp "$HERE/app/Actions/Cart/"*.php           "$TARGET/app/Actions/Cart/"
cp "$HERE/../laravel-backend/VaporChamberController.php" "$TARGET/app/Http/Controllers/"
cp "$HERE/config/vapor-chamber.php"         "$TARGET/config/"
cp "$HERE/resources/views/cart.blade.php"   "$TARGET/resources/views/"
cp "$HERE/resources/views/widget.blade.php" "$TARGET/resources/views/"

# 4. Routes - REPLACE our block, don't just skip when present: a skip would
#    keep a stale block from an older scaffold forever (a route added since
#    would 404). Dropping our block (marker to EOF) and re-appending makes a
#    re-run pick up whatever this example currently defines. `perl -i`, not `sed -i`: macOS ships BSD sed,
#    whose -i takes a mandatory suffix argument.
WEB="$TARGET/routes/web.php"
MARKER='vapor-chamber demo routes'
if grep -q "$MARKER" "$WEB"; then
  VC_MARKER="$MARKER" perl -i -ne 'if (index($_, $ENV{VC_MARKER}) >= 0) { $d = 1 } print unless $d' "$WEB"
fi
# strip the <?php opener before appending into the existing file
tail -n +2 "$HERE/routes/append-to-web.php" >> "$WEB"

# 5. The repo's Composer package, from this checkout. Its provider leaves
#    command input as the client sent it: TrimStrings and
#    ConvertEmptyStringsToNull skip api/vc and everything under it. In local
#    it adds the wire contract's test commands and development routes, which
#    `node scripts/verify-contract.mjs` checks the demo with.
(cd "$TARGET" && composer config repositories.vapor-chamber path "$(cd "$REPO" && pwd)" \
  && composer require 'lucianofedericopereira/vapor-chamber:@dev' --no-interaction)

# An older demo carries the same skip as lines in bootstrap/app.php, between
# these markers. The provider applies it now, so the lines go.
VC_BEGIN='// vapor-chamber: command input as sent (begin)'
VC_END='// vapor-chamber: command input as sent (end)'
export VC_BEGIN VC_END
perl -i -ne 'if (index($_, $ENV{VC_BEGIN}) >= 0) { $d = 1 } print unless $d; $d = 0 if index($_, $ENV{VC_END}) >= 0' "$TARGET/bootstrap/app.php"

# 6. The skeleton's agent files (AGENTS.md, CLAUDE.md) ask a coding agent to
#    install Laravel Boost, and PHP through a curl-to-shell installer into the
#    user's home. Only a file that carries those guidelines is replaced, by a
#    note scoped to this demo. A file of your own is left as it is.
for AGENT_FILE in AGENTS.md CLAUDE.md; do
  if grep -q '<laravel-boost-guidelines>' "$TARGET/$AGENT_FILE" 2>/dev/null; then
    cp "$HERE/AGENTS.demo.md" "$TARGET/$AGENT_FILE"
    echo "[setup] $AGENT_FILE: replaced the Laravel Boost guidelines with the demo note"
  fi
done

echo
echo "[setup] done. Run it:"
echo "  cd $TARGET && php artisan serve"
echo "  open http://127.0.0.1:8000/cart"
