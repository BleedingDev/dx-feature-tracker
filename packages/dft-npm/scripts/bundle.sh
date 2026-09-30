#!/bin/sh
set -eu
pkg_dir=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$pkg_dir/../.." && pwd)
rolldown_dir=$(ls -d "$root"/node_modules/.pnpm/rolldown@*/node_modules/rolldown | sort | tail -n 1)
if [ "${DFT_SKIP_WORKSPACE_BUILD:-}" != "1" ]; then
  (cd "$root" && "${PNPM_BIN:-pnpm}" turbo run build --filter=@rat-stack/cli...)
fi
rm -rf "$pkg_dir/dist"
node "$rolldown_dir/bin/cli.mjs" "$root/apps/cli/dist/dft-main.js" \
  --platform node \
  --format esm \
  --no-code-splitting \
  --file "$pkg_dir/dist/dft.mjs"
chmod 755 "$pkg_dir/dist/dft.mjs"
cp -R "$root/.cursor/skills" "$pkg_dir/dist/skills"
