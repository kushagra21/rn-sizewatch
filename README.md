# rn-sizewatch

Measure a React Native app's release JS bundle, Hermes bytecode and assets, and see which packages and files the bytes come from. Works with bare React Native and Expo.

> Early work: not on npm yet. The GitHub Action builds the CLI from this repository.

## GitHub Action

Add a workflow to your app's repository:

```yaml
# .github/workflows/size.yml
name: Bundle size
on:
  push:
    branches: [main]
  pull_request:
permissions:
  contents: read
  pull-requests: write
  actions: read
jobs:
  size:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v7
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - uses: kushagra21/rn-sizewatch@main
```

- **On a push** it measures the commit and saves the result as an artifact, the baseline for later pull requests.
- **On a pull request** it measures the pull request merged onto its base branch, compares that with the base commit's saved measurement, and comments with what changed and why. It edits the same comment on every push. When no measurement of the base commit was saved (the first run, or one still going), it checks the base commit out, installs it with your package manager and measures it in the same job.
- Pull requests that only touch native code, docs or CI config are skipped in seconds.
- The result also goes to the job summary, so pull requests from forks, whose tokens can't comment, still get it.
- It fails the check when a budget in `sizewatch.config.json` fails, unless `fail-on-budget: false`.
- Each run saves an HTML report as an artifact, linked from the comment. The comment also lists suggestions for problems the pull request brings in; ones that were already there stay in the report.

No native build is needed, so it runs on `ubuntu-latest`.

| Input | |
|---|---|
| `working-directory` | the app's folder (default `.`) |
| `platforms` | `ios`, `android` or `both` (default: the config's, else both) |
| `comment` | `false` to only write the job summary |
| `fail-on-budget` | `false` to comment without failing |
| `name` | when one repository measures several apps: keeps their comments and baselines apart |
| `github-token` | default `github.token`; needs `pull-requests: write` and `actions: read` |

## Measure

Run it from your app's root:

```bash
npx rn-sizewatch measure
```

```
iOS (1.5 s)
  JS bundle     1.12 MB   gzip 287 KB, brotli 204 KB
  Hermes        1.72 MB   gzip 727 KB, brotli 531 KB
  Assets          282 B   1 file
  JS by source: packages 1.07 MB, your code 5.1 KB, your JSON and asset modules 42 KB, Metro runtime 1.4 KB
  Biggest packages:
       860 KB  react-native@0.83.6
        73 KB  lodash@4.18.1
```

It runs your project's own `react-native bundle` (or `expo export:embed`) for iOS and Android with release settings, compiles the bundle with the Hermes compiler that ships with React Native, and writes everything to `.sizewatch/`: the bundles, their source maps and `measure.json`. Add `.sizewatch/` to your `.gitignore`.

No native build is needed: no Xcode, no Gradle. A small app takes a few seconds per platform.

| Option | |
|---|---|
| `-p, --platform <ios\|android\|both>` | default both |
| `--entry <file>` | entry file (default: package.json `main`, then `index.js`/`ts`; Expo finds its own) |
| `-o, --out <dir>` | output folder (default `.sizewatch`) |
| `--hermesc <path>` | a Hermes compiler to use instead of the bundled one |
| `--no-hermes` | skip Hermes bytecode |
| `--reset-cache` | clear Metro's cache first |
| `--json` | print the measurement as JSON |

### What the numbers mean

- **JS bundle**: the minified bundle. Bytes per package and file are measured on it, using the source map. Metro doesn't tree-shake, so `import { debounce } from "lodash"` brings in all of lodash, and you'll see it here.
- **Hermes**: the bytecode compiled from that bundle with `-O`, which is what ships when Hermes is on. gzip and brotli sizes are what an OTA update downloads.
- **Assets**: images, fonts and other files loaded with `require()`. They ship next to the bundle, not in it.
- **Duplicate copies**: a package installed twice (for example at `node_modules/x` and `node_modules/y/node_modules/x`) is listed once per copy.

## Compare

Measure your base branch and your change, then compare them:

```bash
npx rn-sizewatch compare base/measure.json head/measure.json --markdown comment.md
```

```
iOS      JS 1.12 MB +115 KB   Hermes 1.72 MB +199 KB   assets 282 B +282 B   OTA 531 KB +69 KB
Android  JS 1.13 MB +115 KB   Hermes 1.73 MB +199 KB   assets 381 B +381 B   OTA 534 KB +70 KB

Why it changed (minified JS; iOS / Android)
  +73 KB / +73 KB  lodash 4.18.1: new, pulled in by my-utils
  +41 KB / +41 KB  countries.json: your data, added
  and 6 smaller (--all lists them)

✗ iOS grew +199 KB, over the 50 KB increase budget
```

Each change says why it happened:

| | |
|---|---|
| 🆕 new / 🗑️ removed | a package that wasn't there before, and which of your dependencies pulls it in |
| ⬆️ upgraded / ⬇️ downgraded | the same package at another version |
| ⚠️ another copy | a package installed a second time, at another folder and often another version |
| 📈 more of it used / 📉 less | same version, more or fewer of its files bundled |
| ✏️ your code · 📄 your data · 🖼️ assets | your own files, JSON (and the small modules Metro writes for images), and the files next to the bundle |

`--markdown` writes the same as a pull request comment. Changes under 1 KB go in a collapsed list; `--threshold` changes that. `compare` exits with code 1 when a budget fails.

## Budgets

Put budgets in `sizewatch.config.json` at your app's root:

```json
{
  "budgets": {
    "hermes": "2 MB",
    "js": "1.5 MB",
    "assets": "5 MB",
    "increase": "50 KB",
    "android": { "hermes": "2.2 MB" }
  },
  "threshold": "1 KB",
  "platforms": ["ios", "android"],
  "entry": "index.js"
}
```

- `hermes`, `js`, `assets`: the most each may be. `ios` and `android` override them per platform.
- `increase`: how much the shipped size (Hermes bytecode, or JS without Hermes) may grow in one change, in bytes or as a share like `"5%"`. Checked by `compare`, or by `check --base`.
- Sizes are written like `"50 KB"` or `"2 MB"` (1 KB = 1000 bytes; `KiB` is 1024), or as a number of bytes.
- Every key is optional; with no budgets, nothing fails.

`npx rn-sizewatch check` checks `.sizewatch/measure.json` against them without a base.

## Report

```bash
npx rn-sizewatch report                                   # from .sizewatch/measure.json
npx rn-sizewatch report --base base/measure.json          # and what changed since the base
```

Writes `.sizewatch/report.html`, one file that works offline:

- the sizes per platform, and their change against the base
- a treemap of the JS bundle: packages, then their files; your code by folder. Click to open a block; with a base, colour it by what grew, shrank or is new
- tables of packages (version, size, what pulls each in), your files and assets, sortable and filterable
- suggestions, each with the bytes at stake. They're only made when the measurement shows the problem:
  - more than one installed copy of a package
  - a whole library bundled where single imports exist (`lodash`, `validator`, `crypto-js`)
  - heavy packages with lighter options (`moment`, much of `core-js`, `aws-sdk` v2)
  - many `moment` or `@formatjs` locales
  - dev-only packages in the release bundle (Storybook, Reactotron, why-did-you-render, Redux DevTools)
  - JSON files over 50 KB in the bundle, images over 200 KB

## Doctor

`npx rn-sizewatch doctor` checks that it can find your project, its bundler, the Hermes compiler and git.

## License

MIT
