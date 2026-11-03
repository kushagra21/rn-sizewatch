# rn-sizewatch

Measure a React Native app's release JS bundle, Hermes bytecode and assets, and see which packages and files the bytes come from. Works with bare React Native and Expo.

> Early work. `measure` works today; comparing two measurements and the GitHub Action that comments on pull requests are next.

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

## License

MIT
