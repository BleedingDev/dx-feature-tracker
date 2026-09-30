# Releasing dft

One command cuts a release. npm publishing stays a manual last step because npm asks for your one-time password.

```sh
scripts/release.sh 0.1.5 --notes release-notes.md
```

## Before you start

- You are on `main`, the working tree is clean and `main` is not behind `origin/main`.
- `gh` is logged in with push rights to `BleedingDev/dx-feature-tracker` (`gh auth status`).
- pnpm is 11.3.0. The script uses `~/.proto/tools/pnpm/11.3.0/shims/pnpm` when it exists, otherwise `pnpm` on `PATH`; set `PNPM_BIN` to override.
- Write the release notes to a Markdown file. It becomes the GitHub release body.

## What the script does

1. Preflight: version is `X.Y.Z` and newer than the current one, tools exist, `gh` is logged in, branch is `main`, tree is clean, `main` is level with `origin/main` after a fetch, the tag and the GitHub release do not exist yet, and `apps/cli/src/version.ts` agrees with `packages/dft-npm/package.json`.
2. Sets the version in `apps/cli/src/version.ts` and `packages/dft-npm/package.json`.
3. Runs the root fence once: `pnpm check && pnpm test`. On failure it restores both version files.
4. Commits `release: vX.Y.Z` with the `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` trailer and pushes `main`. The lefthook pre-commit hook runs as usual.
5. Bundles with `packages/dft-npm/scripts/bundle.sh` (`PNPM_BIN` passed through).
6. Verifies the bundle: `dist/dft.mjs --version` prints the new version, no file in `dist` contains your home path, and `node dist/check-node.cjs` exits 0.
7. Runs `npm pack` and checks the tarball has `package.json`, `dist/dft.mjs`, `dist/dft-main.mjs` and `dist/check-node.cjs` at the right version.
8. Creates GitHub release `vX.Y.Z` titled `dft X.Y.Z`, marked latest, at the release commit, with two identical assets: `dx-feature-tracker-X.Y.Z.tgz` and `dx-feature-tracker.tgz`.
9. Downloads `https://github.com/BleedingDev/dx-feature-tracker/releases/latest/download/dx-feature-tracker.tgz` (retrying for about a minute) and checks it returns 200 and matches the packed tarball byte for byte.
10. Prints the publish command:

```sh
cd packages/dft-npm && npm publish --access public --otp=<code>
```

## Dry run

```sh
scripts/release.sh 0.1.5 --notes release-notes.md --dry-run
```

A dry run does every check, runs the fence, bundles, verifies the bundle, packs into a temporary directory and checks the current latest download URL. It never writes the version files, commits, pushes or creates a release, so the bundle it verifies carries the current version.

Two flags exist only for dry runs:

- `--allow-dirty` continues past a dirty working tree, for trying the script while other work is in progress.
- `--skip-fence` skips `pnpm check && pnpm test`.

## When a release stops halfway

- It failed before the commit: fix the cause and rerun the same command. The version files were restored.
- It failed after the push (bundle, pack, release or download check): rerun the same command. When `HEAD` is the pushed `release: vX.Y.Z` commit and no `vX.Y.Z` tag exists, the script skips the version, fence and commit steps and resumes at the bundle.
- The GitHub release exists but the download check failed: check the release page. Delete the release and its tag (`gh release delete vX.Y.Z --cleanup-tag`) before rerunning.
