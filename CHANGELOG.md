# Changelog

## Unreleased

- `measure`: bundles iOS and Android with release settings (bare React Native or Expo), compiles to Hermes bytecode, and records raw, gzip and brotli sizes, assets, and bytes per package and per file from the source map. Duplicate package copies are listed separately.
- `measure` records which of your dependencies brings in each package.
- `compare`: what changed between two measurements and why (new, removed, upgraded, downgraded, another copy, more or less used, your code, your data, assets), in the terminal, as JSON, or as a pull request comment with `--markdown`.
- Budgets in `sizewatch.config.json`: largest JS, Hermes and asset sizes, and the largest increase per change, per platform. `check` checks them; `compare` fails on them.
- `doctor`.
- GitHub Action: measures pushes as baselines; on pull requests compares with the base commit (built in the job when no baseline was saved), comments once and edits it, writes the job summary, skips pull requests that change nothing bundled, caches Metro, and fails on budgets.
