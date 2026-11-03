import { PLATFORMS, type Measurement, type PackageSize, type PlatformMeasurement } from "../core/types.js";

/** A size problem the measurement shows, with what fixing it would save. */
export interface Hint {
  /** Stable across measurements, so a pull request's new hints can be told from old ones. */
  key: string;
  title: string;
  /** What to do about it, as plain text with `code` in backticks. */
  fix: string;
  /** Bytes at stake on the platform where it's biggest (minified JS, or the asset's size). */
  bytes: number;
}

const KB = 1000;
const sum = (list: { bytes: number }[]) => list.reduce((total, item) => total + item.bytes, 0);

/** Packages with a much smaller replacement; only flagged above `min` bytes. */
const HEAVY: { name: string; min: number; title: string; fix: string }[] = [
  { name: "moment", min: 20 * KB, title: "moment is in the bundle", fix: "`dayjs` has the same API at a fraction of the size, or use `date-fns` with per-function imports." },
  { name: "core-js", min: 50 * KB, title: "A large part of core-js is bundled", fix: "Hermes supports modern JavaScript; polyfill only the features you use instead of importing all of `core-js`." },
  { name: "aws-sdk", min: 50 * KB, title: "AWS SDK v2 is in the bundle", fix: "The v3 SDK is modular: import only the clients you use, like `@aws-sdk/client-s3`." },
];

/** A library's single entry file that pulls in everything; importing from a path inside it doesn't. */
const WHOLE_LIBRARY: { name: string; file: string; fix: string }[] = [
  { name: "lodash", file: "lodash.js", fix: "Metro doesn't tree-shake, so `import { debounce } from 'lodash'` brings in all of it. Import single functions: `import debounce from 'lodash/debounce'`." },
  { name: "validator", file: "index.js", fix: "Import single validators, like `import isEmail from 'validator/lib/isEmail'`." },
  { name: "crypto-js", file: "index.js", fix: "Import single algorithms, like `import sha256 from 'crypto-js/sha256'`." },
];

/** Packages that are only useful while developing. */
const DEV_ONLY = /^(?:@storybook\/.+|storybook|reactotron-.+|@welldone-software\/why-did-you-render|redux-devtools.*|@redux-devtools\/.+|react-native-flipper|@dev-plugins\/.+)$/;

const LARGE_DATA = 50 * KB;
const LARGE_IMAGE = 200 * KB;
const IMAGE = /\.(?:png|jpe?g|gif|bmp)$/i;
/** Android renames assets (drawable-mdpi/myphoto.png for assets/my-photo.png), so images match by a normalised name. */
const imageKey = (path: string) => path.split("/").at(-1)!.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]/g, "");

function platformHints(m: PlatformMeasurement): Hint[] {
  const hints: Hint[] = [];
  const byName = new Map<string, PackageSize[]>();
  for (const pkg of m.packages) byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg]);

  for (const [name, copies] of byName) {
    if (copies.length < 2) continue;
    const sorted = [...copies].sort((a, b) => b.bytes - a.bytes);
    const extra = sum(sorted.slice(1));
    if (extra < KB) continue;
    const versions = [...new Set(copies.map((c) => c.version ?? "?"))].join(", ");
    hints.push({
      key: `duplicate:${name}`,
      title: `${copies.length} copies of ${name} are bundled (${versions})`,
      fix: `Align the versions so one copy is installed: run \`npm dedupe\`, or pin it with \`overrides\` (npm), \`resolutions\` (yarn) or \`pnpm.overrides\`. Installed at ${sorted.map((c) => `\`${c.dir}\``).join(", ")}.`,
      bytes: extra,
    });
  }

  for (const rule of HEAVY) {
    const bytes = sum(byName.get(rule.name) ?? []);
    if (bytes >= rule.min) hints.push({ key: `heavy:${rule.name}`, title: rule.title, fix: rule.fix, bytes });
  }

  for (const rule of WHOLE_LIBRARY) {
    const entry = m.sources.filter((s) => s.package && byName.get(rule.name)?.some((p) => p.dir === s.package) && s.path === `${s.package}/${rule.file}`);
    const bytes = sum(entry);
    if (bytes >= 5 * KB) hints.push({ key: `whole:${rule.name}`, title: `All of ${rule.name} is bundled`, fix: rule.fix, bytes });
  }

  const momentLocales = m.sources.filter((s) => /(?:^|\/)node_modules\/moment\/(?:dist\/)?locale\//.test(s.path));
  if (momentLocales.length >= 10) {
    hints.push({ key: "locales:moment", title: `${momentLocales.length} moment locales are bundled`, fix: "Import only the locales you use, like `import 'moment/locale/fr'`, and stop importing `moment/min/moment-with-locales`.", bytes: sum(momentLocales) });
  }
  const formatjsLocales = m.sources.filter((s) => /node_modules\/@formatjs\/[^/]+\/locale-data\//.test(s.path));
  if (formatjsLocales.length >= 10) {
    hints.push({ key: "locales:formatjs", title: `${formatjsLocales.length} @formatjs locale data files are bundled`, fix: "Import the locale data only for the languages your app supports.", bytes: sum(formatjsLocales) });
  }

  for (const [name, copies] of byName) {
    if (!DEV_ONLY.test(name)) continue;
    const bytes = sum(copies);
    if (bytes >= KB) hints.push({ key: `dev:${name}`, title: `${name} is in the release bundle`, fix: "It's only useful while developing: load it behind `if (__DEV__)` with `require()`, so release builds leave it out.", bytes });
  }

  for (const data of m.sources) {
    if (data.kind === "data" && data.path.endsWith(".json") && data.bytes >= LARGE_DATA) {
      hints.push({ key: `data:${data.path}`, title: `${data.path} adds a large JSON file to the bundle`, fix: "Data this big is parsed when the app starts. Fetch it when it's needed, or ship it as a file and read it lazily.", bytes: data.bytes });
    }
  }
  for (const asset of m.assets.files) {
    if (IMAGE.test(asset.path) && asset.bytes >= LARGE_IMAGE) {
      hints.push({ key: `image:${imageKey(asset.path)}`, title: `${asset.path} is a large image`, fix: "Resize it to the largest size it's shown at and compress it, or convert it to WebP.", bytes: asset.bytes });
    }
  }
  return hints;
}

/** Every hint for a measurement, one per problem across platforms, biggest first. */
export function hintsFor(measurement: Measurement): Hint[] {
  const merged = new Map<string, Hint>();
  for (const platform of PLATFORMS) {
    const m = measurement.platforms[platform];
    if (!m) continue;
    for (const hint of platformHints(m)) {
      const existing = merged.get(hint.key);
      if (!existing || hint.bytes > existing.bytes) merged.set(hint.key, hint);
    }
  }
  return [...merged.values()].sort((a, b) => b.bytes - a.bytes || a.key.localeCompare(b.key));
}

/** The hints a change brings: ones `head` has that `base` doesn't. */
export function introducedHints(base: Measurement, head: Measurement): Hint[] {
  const before = new Set(hintsFor(base).map((h) => h.key));
  return hintsFor(head).filter((h) => !before.has(h.key));
}
