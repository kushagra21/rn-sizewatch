import { UserError } from "../core/exec.js";
import { PLATFORMS, type Measurement, type PackageSize, type Platform, type PlatformMeasurement, type SourceSize } from "../core/types.js";

/**
 * Why a size changed:
 * added / removed: a package that's new or gone. upgraded / downgraded: same package, other version.
 * duplicate: another installed copy of a package already there; deduped: a copy gone.
 * grown / shrunk: same version, more or less of its files used.
 * app: your own code. data: one of your JSON or asset modules. assets: files next to the bundle.
 * runtime: code Metro generates.
 */
export type ChangeKind = "added" | "removed" | "upgraded" | "downgraded" | "duplicate" | "deduped" | "grown" | "shrunk" | "app" | "data" | "assets" | "runtime";

export interface FileDelta {
  path: string;
  delta: number;
  status: "added" | "removed" | "changed";
}

export interface Change {
  /** Stable across platforms, so the same change on iOS and Android is one row. */
  key: string;
  kind: ChangeKind;
  /** Package name, data file path, or empty for app/assets/runtime. */
  name: string;
  from?: string;
  to?: string;
  /** For packages: how it's brought in (see PackageSize.via). */
  via?: string[];
  /** For duplicate / deduped: the folders of the copies that came or went, and the versions now installed. */
  dirs?: string[];
  versions?: string[];
  /** For app / assets / grown / shrunk: the files behind it, biggest change first. */
  files?: FileDelta[];
  /** Bytes per platform, of the minified JS (assets: of the assets). */
  delta: Partial<Record<Platform, number>>;
}

export interface Totals {
  js: number;
  hermes?: number;
  assets: number;
  /** What an OTA update downloads: the brotli-compressed Hermes bytecode, or JS without Hermes. */
  ota: number;
  /** What ships in the app: the Hermes bytecode, or the JS without Hermes. */
  shipped: number;
}

export interface Comparison {
  platforms: Platform[];
  /** Platforms only one side measured. */
  skipped: Platform[];
  totals: Partial<Record<Platform, { base: Totals; head: Totals }>>;
  /** Biggest change (on any platform) first. */
  changes: Change[];
  base: Measurement;
  head: Measurement;
}

export function totalsOf(m: PlatformMeasurement): Totals {
  return {
    js: m.js.raw,
    ...(m.hermes ? { hermes: m.hermes.raw } : {}),
    assets: m.assets.bytes,
    ota: (m.hermes ?? m.js).brotli,
    shipped: (m.hermes ?? m.js).raw,
  };
}

const parts = (version: string) => version.split(/[.+-]/).map((p) => (/^\d+$/.test(p) ? Number(p) : p));
/** Plain dotted versions compared number by number; anything else counts as an upgrade when it differs. */
function isDowngrade(from: string, to: string) {
  const a = parts(from);
  const b = parts(to);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return y < x;
    } else if (x !== y) return false;
  }
  return false;
}

/** File-level changes inside one group of sources, biggest first. */
function fileDeltas(base: SourceSize[], head: SourceSize[]): FileDelta[] {
  const before = new Map(base.map((s) => [s.path, s.bytes]));
  const after = new Map(head.map((s) => [s.path, s.bytes]));
  const files: FileDelta[] = [];
  for (const [path, bytes] of after) {
    const old = before.get(path);
    if (old === undefined) files.push({ path, delta: bytes, status: "added" });
    else if (old !== bytes) files.push({ path, delta: bytes - old, status: "changed" });
  }
  for (const [path, bytes] of before) if (!after.has(path)) files.push({ path, delta: -bytes, status: "removed" });
  return files.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.path.localeCompare(b.path));
}

const sumBytes = (list: { bytes: number }[]) => list.reduce((sum, item) => sum + item.bytes, 0);
const largest = (copies: PackageSize[]) => copies.reduce((a, b) => (b.bytes > a.bytes ? b : a));
const versionsOf = (copies: PackageSize[]) => [...new Set(copies.map((c) => c.version ?? "?"))];

/** The changes on one platform, each with its delta in `bytes`. */
function platformChanges(base: PlatformMeasurement, head: PlatformMeasurement): (Omit<Change, "delta"> & { bytes: number })[] {
  const changes: (Omit<Change, "delta"> & { bytes: number })[] = [];
  const group = (list: PackageSize[]) => {
    const byName = new Map<string, PackageSize[]>();
    for (const pkg of list) byName.set(pkg.name, [...(byName.get(pkg.name) ?? []), pkg]);
    return byName;
  };
  const before = group(base.packages);
  const after = group(head.packages);

  for (const name of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(name) ?? [];
    const now = after.get(name) ?? [];
    if (old.length === 0) {
      const main = largest(now);
      changes.push({ key: `pkg:${name}:added`, kind: "added", name, to: main.version, ...(main.via ? { via: main.via } : {}), bytes: sumBytes(now) });
      continue;
    }
    if (now.length === 0) {
      changes.push({ key: `pkg:${name}:removed`, kind: "removed", name, from: largest(old).version, bytes: -sumBytes(old) });
      continue;
    }

    // Copies that came or went, when the number of copies changed; a copy that only moved isn't one.
    let rest = sumBytes(now) - sumBytes(old);
    const oldDirs = new Set(old.map((p) => p.dir));
    const newDirs = new Set(now.map((p) => p.dir));
    if (now.length > old.length) {
      const extra = now.filter((p) => !oldDirs.has(p.dir)).sort((a, b) => b.bytes - a.bytes).slice(0, now.length - old.length);
      const bytes = sumBytes(extra);
      if (extra.length) {
        changes.push({ key: `pkg:${name}:duplicate`, kind: "duplicate", name, dirs: extra.map((p) => p.dir), versions: versionsOf(now), ...(extra[0]!.via ? { via: extra[0]!.via } : {}), bytes });
        rest -= bytes;
      }
    } else if (now.length < old.length) {
      const gone = old.filter((p) => !newDirs.has(p.dir)).sort((a, b) => b.bytes - a.bytes).slice(0, old.length - now.length);
      const bytes = -sumBytes(gone);
      if (gone.length) {
        changes.push({ key: `pkg:${name}:deduped`, kind: "deduped", name, dirs: gone.map((p) => p.dir), versions: versionsOf(now), bytes });
        rest -= bytes;
      }
    }

    const from = largest(old).version;
    const to = largest(now).version;
    if (from && to && from !== to) {
      changes.push({ key: `pkg:${name}:version`, kind: isDowngrade(from, to) ? "downgraded" : "upgraded", name, from, to, bytes: rest });
    } else if (rest !== 0) {
      const files = fileDeltas(
        base.sources.filter((s) => old.some((p) => p.dir === s.package)),
        head.sources.filter((s) => now.some((p) => p.dir === s.package)),
      );
      changes.push({ key: `pkg:${name}:size`, kind: rest > 0 ? "grown" : "shrunk", name, ...(to ? { to } : {}), files, bytes: rest });
    }
  }

  // Your code in one row; each data file in its own, since one JSON file can be most of a change.
  const app = fileDeltas(base.sources.filter((s) => s.kind === "app"), head.sources.filter((s) => s.kind === "app"));
  const appBytes = head.breakdown.app - base.breakdown.app;
  if (appBytes !== 0 || app.length) changes.push({ key: "app", kind: "app", name: "", files: app, bytes: appBytes });
  for (const file of fileDeltas(base.sources.filter((s) => s.kind === "data"), head.sources.filter((s) => s.kind === "data"))) {
    changes.push({ key: `data:${file.path}`, kind: "data", name: file.path, files: [file], bytes: file.delta });
  }
  const runtime = head.breakdown.runtime - base.breakdown.runtime;
  if (runtime !== 0) changes.push({ key: "runtime", kind: "runtime", name: "", bytes: runtime });

  const assets = fileDeltas(
    base.assets.files.map((f) => ({ ...f, kind: "data" as const })),
    head.assets.files.map((f) => ({ ...f, kind: "data" as const })),
  );
  const assetBytes = head.assets.bytes - base.assets.bytes;
  if (assetBytes !== 0 || assets.length) changes.push({ key: "assets", kind: "assets", name: "", files: assets, bytes: assetBytes });
  return changes;
}

export function compare(base: Measurement, head: Measurement): Comparison {
  for (const [label, m] of [["base", base], ["head", head]] as const) {
    if (m?.schemaVersion !== 1 || m.tool?.name !== "rn-sizewatch") throw new UserError(`The ${label} file isn't a measure.json written by rn-sizewatch.`);
  }
  const platforms = PLATFORMS.filter((p) => base.platforms[p] && head.platforms[p]);
  const skipped = PLATFORMS.filter((p) => !platforms.includes(p) && (base.platforms[p] || head.platforms[p]));
  if (platforms.length === 0) throw new UserError("The two measurements have no platform in common.");

  const totals: Comparison["totals"] = {};
  const merged = new Map<string, Change>();
  for (const platform of platforms) {
    const b = base.platforms[platform]!;
    const h = head.platforms[platform]!;
    totals[platform] = { base: totalsOf(b), head: totalsOf(h) };
    for (const { bytes, ...change } of platformChanges(b, h)) {
      // iOS comes first, so its details (versions, files) are the ones shown.
      const existing = merged.get(change.key);
      if (existing) existing.delta[platform] = bytes;
      else merged.set(change.key, { ...change, delta: { [platform]: bytes } });
    }
  }

  const changes = [...merged.values()]
    .filter((c) => Object.values(c.delta).some((d) => d !== 0) || (c.files?.length ?? 0) > 0)
    .sort((a, b) => biggest(b) - biggest(a) || a.key.localeCompare(b.key));
  return { platforms, skipped, totals, changes, base, head };
}

/** A change's largest size change on any platform, ignoring direction. */
export const biggest = (change: Change) => Math.max(0, ...Object.values(change.delta).map((d) => Math.abs(d ?? 0)));
