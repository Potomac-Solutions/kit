#!/bin/sh
# Run the kit against Zubra as merged but not yet released: package components (#197) and id() in
# server HTML (#188) landed after the 5.8.0 build. Builds the native compiler from a Zubra
# checkout (no wasm32 target needed: @zubra/compiler uses $ZUBRA_COMPILER when zubra.wasm is
# missing), installs that checkout's packages here without saving them, and runs the browser tests.
#
#   scripts/zubra-main.sh ../zubra
#
# `npm install` puts the released ones back.
set -eu
zubra=$(cd "${1:?usage: scripts/zubra-main.sh <path to a zubra checkout>}" && pwd)
kit=$(cd "$(dirname "$0")/.." && pwd)
packs=$(mktemp -d)
(cd "$zubra" && cargo build --release --bin zubra)
for package in compiler server runtime sync; do
  (cd "$zubra/$package" && npm pack --ignore-scripts --pack-destination "$packs" >/dev/null)
done
cd "$kit"
rm -rf node_modules/@zubra
npm install --no-save "$packs"/*.tgz
ZUBRA_COMPILER="$zubra/target/release/zubra" npm run test:browser
