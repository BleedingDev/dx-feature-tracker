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
  --file "$pkg_dir/dist/dft-main.mjs"
cat > "$pkg_dir/dist/check-node.cjs" <<'CHECK_NODE'
"use strict";

var REQUIRED = [24, 18, 0];

function parse(version) {
  return String(version)
    .replace(/^v/, "")
    .split(".")
    .map(function (part) {
      return parseInt(part, 10) || 0;
    });
}

function isOldNode(current) {
  for (var i = 0; i < REQUIRED.length; i++) {
    if (current[i] > REQUIRED[i]) return false;
    if (current[i] < REQUIRED[i]) return true;
  }
  return false;
}

function hasSqlite() {
  try {
    require("node:sqlite");
    return true;
  } catch {
    return false;
  }
}

function fail(reason) {
  var red = process.stderr.isTTY ? "\u001b[1;41;97m" : "";
  var bold = process.stderr.isTTY ? "\u001b[1m" : "";
  var reset = process.stderr.isTTY ? "\u001b[0m" : "";
  var lines = [
    "",
    red + "  dft needs Node.js 24.18.0 or newer  " + reset,
    "",
    "  You have Node.js " + process.version + " (" + process.execPath + ").",
    "  " + reason,
    "",
    bold + "  Upgrade Node, then install again:" + reset,
    "    nvm:    nvm install 24 && nvm use 24",
    "    fnm:    fnm install 24 && fnm use 24",
    "    Ubuntu: curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - && sudo apt-get install -y nodejs",
    "    macOS:  brew install node@24",
    "    Other:  https://nodejs.org/en/download",
    "",
    "  Then: npm i -g dx-feature-tracker && dft install",
    "",
  ];
  process.stderr.write(lines.join("\n") + "\n");
  process.exit(1);
}

function check() {
  if (isOldNode(parse(process.versions.node))) {
    fail("dft uses the built-in node:sqlite module, which needs Node.js 24.18.0 or newer.");
  }
  if (!hasSqlite()) {
    fail("This Node.js build has no node:sqlite module.");
  }
}

module.exports = { check: check };

if (require.main === module) {
  check();
}
CHECK_NODE
cat > "$pkg_dir/dist/dft.mjs" <<'LAUNCHER'
#!/usr/bin/env node
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

require("./check-node.cjs").check();

import("./dft-main.mjs");
LAUNCHER
chmod 755 "$pkg_dir/dist/dft.mjs"
cp -R "$root/.cursor/skills" "$pkg_dir/dist/skills"
mkdir -p "$pkg_dir/dist/assets"
cp -R "$root/apps/cli/assets/intro" "$pkg_dir/dist/assets/intro"
