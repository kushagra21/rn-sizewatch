import { totalsOf, type Totals } from "../compare/diff.js";
import { PLATFORMS, type Measurement, type Platform, type PlatformMeasurement } from "../core/types.js";
import { hintsFor, introducedHints, type Hint } from "../hints/rules.js";
import { bundleTree, type TreeNode } from "./tree.js";

export type Status = "new" | "removed" | "changed" | "same";

export interface PackageRow {
  name: string;
  version?: string;
  dir: string;
  bytes: number;
  files: number;
  via?: string[];
  copies: number;
  delta?: number;
  status?: Status;
}

export interface FileRow {
  path: string;
  kind: string;
  bytes: number;
  delta?: number;
  status?: Status;
}

export interface PlatformData {
  totals: { head: Totals; base?: Totals };
  tree: TreeNode;
  packages: PackageRow[];
  files: FileRow[];
  assets: FileRow[];
}

export interface ReportData {
  title: string;
  version: string;
  createdAt: string;
  head: { commit?: string; branch?: string };
  base?: { commit?: string; branch?: string };
  platforms: Partial<Record<Platform, PlatformData>>;
  hints: Hint[];
  /** Keys of the hints the change brings, when there's a base. */
  introduced: string[];
}

function rows<T extends { bytes: number }>(head: T[], base: T[] | undefined, key: (item: T) => string, removed: (item: T) => T): (T & { delta?: number; status?: Status })[] {
  if (!base) return head;
  const before = new Map(base.map((item) => [key(item), item]));
  const after = new Set(head.map(key));
  const result: (T & { delta?: number; status?: Status })[] = head.map((item) => {
    const old = before.get(key(item));
    if (!old) return { ...item, delta: item.bytes, status: "new" as const };
    return { ...item, delta: item.bytes - old.bytes, status: item.bytes === old.bytes ? ("same" as const) : ("changed" as const) };
  });
  for (const old of base) if (!after.has(key(old))) result.push({ ...removed(old), delta: -old.bytes, status: "removed" });
  return result;
}

function platformData(head: PlatformMeasurement, base?: PlatformMeasurement): PlatformData {
  const copies = new Map<string, number>();
  for (const pkg of head.packages) copies.set(pkg.name, (copies.get(pkg.name) ?? 0) + 1);
  const packages = rows(
    head.packages.map((p) => ({ ...p, copies: copies.get(p.name) ?? 1 })),
    base?.packages.map((p) => ({ ...p, copies: 1 })),
    (p) => p.dir,
    (p) => ({ ...p, bytes: 0, files: 0 }),
  );
  const own = (m: PlatformMeasurement) => m.sources.filter((s) => s.kind !== "package").map((s) => ({ path: s.path, kind: s.kind, bytes: s.bytes }));
  return {
    totals: { head: totalsOf(head), ...(base ? { base: totalsOf(base) } : {}) },
    tree: bundleTree(head, base),
    packages,
    files: rows(own(head), base && own(base), (f) => f.path, (f) => ({ ...f, bytes: 0 })),
    assets: rows(
      head.assets.files.map((f) => ({ ...f, kind: "asset" })),
      base?.assets.files.map((f) => ({ ...f, kind: "asset" })),
      (f) => f.path,
      (f) => ({ ...f, bytes: 0 }),
    ),
  };
}

export function reportData(head: Measurement, base: Measurement | undefined, version: string): ReportData {
  const platforms: ReportData["platforms"] = {};
  for (const platform of PLATFORMS) {
    const m = head.platforms[platform];
    if (m) platforms[platform] = platformData(m, base?.platforms[platform]);
  }
  return {
    title: head.project.name ?? "React Native app",
    version,
    createdAt: head.createdAt,
    head: { ...head.git },
    ...(base ? { base: { ...base.git } } : {}),
    platforms,
    hints: hintsFor(head),
    introduced: base ? introducedHints(base, head).map((h) => h.key) : [],
  };
}
