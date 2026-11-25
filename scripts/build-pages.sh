#!/usr/bin/env bash
set -euo pipefail

# Run from the repository root after wasm-pack has produced web/pkg.
site=${1:?Missing Pages output directory}
build=$(git rev-parse HEAD)
mkdir -p "$site"
cp -R web/. "$site/"

# Keep each module worker at its original URL so nested workers, WASM and
# locale files resolve relative to the same directory as in development.
esbuild web/app.js web/worker.js web/economic-worker.js web/layout-worker.js \
    web/power-team-map-worker.js --bundle --minify --format=esm --target=es2022 --outdir="$site"

# Match the exact URLs and fetch credentials the workers use. Both binaries
# can start transferring while the browser initializes the settings page.
awk -v build="$build" '
    /<\/head>/ {
        print "    <link rel=\"preload\" as=\"fetch\" crossorigin href=\"./pkg/aniimax_bg.wasm?load=" build "\">"
        print "    <link rel=\"preload\" as=\"fetch\" crossorigin href=\"./vendor/highs/highs.wasm\">"
    }
    { sub(/app\.js\?v=[^"]+/, "app.js?build=" build); sub(/style\.css\?v=[^"]+/, "style.css?build=" build); print }
' web/index.html > "$site/index.html"
