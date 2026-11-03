# Changelog

## 0.1.0 (2026-11-03)

First release.

- `measure`: bundles iOS and Android with release settings (bare React Native or Expo), compiles to Hermes bytecode, and records raw, gzip and brotli sizes, assets, and bytes per package and per file from the source map. Duplicate package copies are listed separately.
- `measure` records which of your dependencies brings in each package.
- `compare`: what changed between two measurements and why (new, removed, upgraded, downgraded, another copy, more or less used, your code, your data, assets), in the terminal, as JSON, or as a pull request comment with `--markdown`.
- Budgets in `sizewatch.config.json`: largest JS, Hermes and asset sizes, and the largest increase per change, per platform. `check` checks them; `compare` fails on them.
- `doctor`.
- GitHub Action: measures pushes as baselines; on pull requests compares with the base commit (built in the job when no baseline was saved), comments once and edits it, writes the job summary, skips pull requests that change nothing bundled, caches Metro, and fails on budgets.
- `report`: a self-contained HTML report with a zoomable treemap of the bundle (coloured by change against a base), tables of packages, files and assets, and suggestions backed by the measurement (duplicate copies, whole-library imports, heavy packages, locales, dev-only code, large JSON and images).
- The pull request comment lists suggestions for problems the change brings in and links the full report, which the Action saves as an artifact. `compare` prints them too.
- Measurements record the app's package.json name.
- Checked against a bare React Native 0.83 app and an Expo SDK 58 app (React Native 0.88). Expo's root-relative source map paths are read correctly.
