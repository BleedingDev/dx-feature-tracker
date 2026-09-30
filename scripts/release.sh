#!/bin/sh
set -eu

usage() {
  cat <<'USAGE'
Usage: scripts/release.sh <version> --notes <file> [--dry-run [--allow-dirty] [--skip-fence]]

Cuts dft release v<version> in one go:
  preflight -> set version -> pnpm check && pnpm test -> commit + push
  -> bundle -> verify bundle -> npm pack -> GitHub release (latest)
  -> verify latest download URL -> print the npm publish command.

Options:
  --notes <file>   Release notes (markdown) for the GitHub release. Required.
  --dry-run        Run every check, bundle and pack into a temp dir, but never
                   write version files, commit, push or create a release.
  --allow-dirty    Dry run only: do not refuse a dirty working tree.
  --skip-fence     Dry run only: skip the root pnpm check/test fence.
  -h, --help       Show this help.

Environment:
  PNPM_BIN         pnpm 11.3.0 binary (default: ~/.proto pnpm 11.3.0 shim, else pnpm on PATH).
USAGE
}

say() { printf '==> %s\n' "$*" >&2; }
die() { printf 'release: %s\n' "$*" >&2; exit 1; }

version=""
notes=""
dry_run=0
allow_dirty=0
skip_fence=0

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --dry-run) dry_run=1 ;;
    --allow-dirty) allow_dirty=1 ;;
    --skip-fence) skip_fence=1 ;;
    --notes)
      [ $# -ge 2 ] || die "--notes needs a file"
      notes=$2
      shift
      ;;
    --notes=*) notes=${1#--notes=} ;;
    -*) usage >&2; die "unknown option: $1" ;;
    *)
      [ -z "$version" ] || die "version given twice: $version and $1"
      version=${1#v}
      ;;
  esac
  shift
done

[ -n "$version" ] || { usage >&2; die "missing <version>"; }
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' \
  || die "version must be X.Y.Z, got: $version"
[ -n "$notes" ] || die "missing --notes <file>"
[ -f "$notes" ] && [ -s "$notes" ] || die "notes file missing or empty: $notes"
if [ "$dry_run" -eq 0 ]; then
  [ "$allow_dirty" -eq 0 ] || die "--allow-dirty is only allowed with --dry-run"
  [ "$skip_fence" -eq 0 ] || die "--skip-fence is only allowed with --dry-run"
fi

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"
notes=$(cd "$(dirname "$notes")" && pwd)/$(basename "$notes")

version_ts=apps/cli/src/version.ts
pkg_dir=packages/dft-npm
pkg_json=$pkg_dir/package.json
tag=v$version
asset_name=dx-feature-tracker-$version.tgz
latest_name=dx-feature-tracker.tgz
coauthor="Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"

if [ -z "${PNPM_BIN:-}" ]; then
  if [ -x "$HOME/.proto/tools/pnpm/11.3.0/shims/pnpm" ]; then
    PNPM_BIN=$HOME/.proto/tools/pnpm/11.3.0/shims/pnpm
  else
    PNPM_BIN=pnpm
  fi
fi
export PNPM_BIN
case "$PNPM_BIN" in
  */*) PATH=$(dirname "$PNPM_BIN"):$PATH; export PATH ;;
esac

tmp=$(mktemp -d "${TMPDIR:-/tmp}/dft-release.XXXXXX")
versioned=0
committed=0
cleanup() {
  status=$?
  if [ "$versioned" -eq 1 ] && [ "$committed" -eq 0 ]; then
    git restore --source=HEAD --staged --worktree -- "$version_ts" "$pkg_json" 2>/dev/null || true
    printf 'release: restored %s and %s after failure\n' "$version_ts" "$pkg_json" >&2
  fi
  rm -rf "$tmp"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

say "preflight for $tag$([ "$dry_run" -eq 1 ] && printf ' (dry run)')"

for tool in git gh node npm curl tar shasum; do
  command -v "$tool" >/dev/null 2>&1 || die "required tool not found: $tool"
done
[ -x "$PNPM_BIN" ] || command -v "$PNPM_BIN" >/dev/null 2>&1 || die "pnpm not found: $PNPM_BIN"
pnpm_version=$("$PNPM_BIN" --version 2>/dev/null)
[ "$pnpm_version" = "11.3.0" ] || die "pnpm 11.3.0 required, $PNPM_BIN is $pnpm_version"
gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"

branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "main" ] || die "not on main (on $branch)"

if [ -n "$(git status --porcelain)" ]; then
  if [ "$allow_dirty" -eq 1 ]; then
    say "working tree is dirty; continuing because of --dry-run --allow-dirty"
  else
    git status --short >&2
    die "working tree is dirty; commit or stash first"
  fi
fi

say "fetching origin"
git fetch --quiet --tags origin main
behind=$(git rev-list --count HEAD..origin/main)
[ "$behind" -eq 0 ] || die "main is $behind commit(s) behind origin/main; pull first"
ahead=$(git rev-list --count origin/main..HEAD)
[ "$ahead" -eq 0 ] || say "main is $ahead commit(s) ahead of origin/main; they ship with this release"

current_ts=$(sed -n 's/^export const VERSION = "\([^"]*\)";$/\1/p' "$version_ts")
current_pkg=$(node -p 'require(process.argv[1]).version' "$root/$pkg_json")
[ -n "$current_ts" ] || die "cannot read VERSION from $version_ts"
[ "$current_ts" = "$current_pkg" ] || die "$version_ts ($current_ts) and $pkg_json ($current_pkg) disagree"
resume=0
if [ "$version" = "$current_ts" ] \
  && [ "$(git log -1 --format=%s)" = "release: $tag" ] \
  && [ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ]; then
  resume=1
  say "HEAD is the pushed 'release: $tag' commit; resuming at the bundle step"
else
  node -e '
const [a, b] = process.argv.slice(1).map((v) => v.split(".").map(Number));
for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) process.exit(a[i] > b[i] ? 0 : 1); }
process.exit(1);
' "$version" "$current_ts" || die "$version is not newer than current $current_ts"
fi

git rev-parse -q --verify "refs/tags/$tag" >/dev/null && die "tag $tag already exists locally"
[ -z "$(git ls-remote --tags origin "refs/tags/$tag")" ] || die "tag $tag already exists on origin"
repo=$(gh repo view --json nameWithOwner -q .nameWithOwner)
if gh release view "$tag" --repo "$repo" >/dev/null 2>&1; then
  die "GitHub release $tag already exists in $repo"
fi
say "repo $repo, current $current_ts -> $version"

if [ "$resume" -eq 1 ]; then
  bundle_version=$version
elif [ "$dry_run" -eq 1 ]; then
  bundle_version=$current_ts
  say "dry run: leaving $version_ts and $pkg_json at $current_ts"
else
  versioned=1
  printf 'export const VERSION = "%s";\n' "$version" > "$version_ts"
  node -e '
const fs = require("node:fs");
const [file, version] = process.argv.slice(1);
const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
pkg.version = version;
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
' "$root/$pkg_json" "$version"
  bundle_version=$version
  say "set version $version in $version_ts and $pkg_json"
fi

if [ "$resume" -eq 1 ]; then
  say "resume: fence already passed for the release commit"
elif [ "$skip_fence" -eq 1 ]; then
  say "dry run: skipping root fence (--skip-fence)"
else
  say "root fence: pnpm check && pnpm test"
  "$PNPM_BIN" check
  "$PNPM_BIN" test
fi

if [ "$dry_run" -eq 0 ] && [ "$resume" -eq 0 ]; then
  git add -- "$version_ts" "$pkg_json"
  git commit --quiet -m "release: $tag" -m "$coauthor"
  committed=1
  say "committed $(git rev-parse --short HEAD) release: $tag"
  git push --quiet origin main
  say "pushed main"
fi
release_sha=$(git rev-parse HEAD)

say "bundling $pkg_dir"
sh "$pkg_dir/scripts/bundle.sh"

say "verifying bundle"
dist=$pkg_dir/dist
printed=$(node "$dist/dft.mjs" --version 2>&1 | tr -d '\r')
case "$printed" in
  "$bundle_version"|*" v$bundle_version"|*" $bundle_version") ;;
  *) die "dist/dft.mjs --version printed '$printed', expected $bundle_version" ;;
esac
if grep -rIlF "$HOME" "$dist" >"$tmp/home-hits" 2>/dev/null; then
  sed 's/^/  /' "$tmp/home-hits" >&2
  die "bundle contains the builder home path $HOME"
fi
node "$dist/check-node.cjs" || die "node dist/check-node.cjs failed"
say "bundle ok: --version '$printed', no home path, check-node exits 0"

say "npm pack"
(cd "$pkg_dir" && npm pack --silent --pack-destination "$tmp" >/dev/null)
packed=$tmp/dx-feature-tracker-$bundle_version.tgz
[ -f "$packed" ] || die "npm pack did not produce $(basename "$packed")"
for entry in package/package.json package/dist/dft.mjs package/dist/dft-main.mjs package/dist/check-node.cjs; do
  tar -tzf "$packed" | grep -Fxq "$entry" || die "tarball is missing $entry"
done
packed_version=$(tar -xOzf "$packed" package/package.json | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
[ "$packed_version" = "$bundle_version" ] || die "tarball version $packed_version, expected $bundle_version"
local_sha=$(shasum -a 256 "$packed" | cut -d' ' -f1)
say "packed $(basename "$packed") ($(wc -c <"$packed" | tr -d ' ') bytes, sha256 $local_sha)"

latest_url=https://github.com/$repo/releases/latest/download/$latest_name

check_url() {
  attempt=1
  while :; do
    code=$(curl -sSL -o "$tmp/download.tgz" -w '%{http_code}' "$latest_url" || printf '000')
    if [ "$code" = "200" ]; then
      return 0
    fi
    [ "$attempt" -lt "$1" ] || return 1
    attempt=$((attempt + 1))
    sleep 5
  done
}

if [ "$dry_run" -eq 1 ]; then
  check_url 1 || die "current latest download URL did not return 200: $latest_url"
  say "dry run: current $latest_url returns 200"
  say "dry run: would commit 'release: $tag', push main, create release $tag at $(git rev-parse --short "$release_sha")"
  say "dry run: would upload $asset_name and $latest_name, --latest, notes from $notes"
  say "dry run passed; nothing was committed, pushed or released"
  exit 0
fi

[ "$(basename "$packed")" = "$asset_name" ] || die "packed $(basename "$packed"), expected $asset_name"
cp "$packed" "$tmp/$latest_name"
say "creating GitHub release $tag"
gh release create "$tag" \
  "$packed" \
  "$tmp/$latest_name" \
  --repo "$repo" \
  --target "$release_sha" \
  --title "dft $version" \
  --notes-file "$notes" \
  --latest

check_url 12 || die "latest download URL did not return 200: $latest_url"
remote_sha=$(shasum -a 256 "$tmp/download.tgz" | cut -d' ' -f1)
[ "$remote_sha" = "$local_sha" ] || die "downloaded latest tarball sha256 $remote_sha differs from local $local_sha"
say "latest download URL returns 200 and matches the packed tarball: $latest_url"

cat <<EOF

Release $tag is live: https://github.com/$repo/releases/tag/$tag

To publish to npm, run (npm needs your one-time password):

  cd $root/$pkg_dir && npm publish --access public --otp=<code>

EOF
