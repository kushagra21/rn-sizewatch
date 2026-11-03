import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { SOURCE_KINDS, type PackageSize, type SourceKind, type SourceSize } from "../core/types.js";
import { GENERATED } from "./sourcemap.js";

const NODE_MODULES = "node_modules/";
/** Anything else in your own code (JSON, the modules Metro writes for images and fonts) is data. */
const CODE = /\.(?:[cm]?[jt]sx?)$/;

/** The package folder a path is in, through the last node_modules so nested copies stay apart. */
export function packageOf(path: string): { name: string; dir: string } | undefined {
  const at = path.lastIndexOf(NODE_MODULES);
  if (at === -1) return undefined;
  const parts = path.slice(at + NODE_MODULES.length).split("/");
  const nameParts = parts[0]?.startsWith("@") ? parts.slice(0, 2) : parts.slice(0, 1);
  if (nameParts.length === 0 || nameParts.some((p) => !p) || parts.length <= nameParts.length) return undefined;
  const name = nameParts.join("/");
  return { name, dir: path.slice(0, at + NODE_MODULES.length) + name };
}

/** A source map path as a forward-slash path relative to the project root. */
export function projectPath(source: string, root: string): string {
  const path = isAbsolute(source) ? relative(root, source) : source;
  return path.split(sep).join("/");
}

export function classify(source: string, root: string): Omit<SourceSize, "bytes"> {
  if (source === GENERATED) return { path: "(Metro runtime)", kind: "runtime" };
  // Metro's generated modules, like __prelude__, have no path.
  if (!source.includes("/") && !source.includes(sep)) return { path: source, kind: "runtime" };
  const path = projectPath(source, root);
  const pkg = packageOf(path);
  if (pkg) return { path, kind: "package", package: pkg.dir };
  return { path, kind: CODE.test(path) ? "app" : "data" };
}

const versionAt = (root: string, dir: string) => {
  const file = join(root, dir, "package.json");
  try {
    return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).version as string | undefined) : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Turns bytes per source map source into per-file sizes, per-package sizes and totals by kind.
 * `chains` (from dependencyChains) says which dependency brings in each package folder.
 */
export function attribute(bytes: Map<string, number>, root: string, chains: Map<string, string[]> = new Map()) {
  const sources: SourceSize[] = [];
  const packages = new Map<string, PackageSize>();
  const breakdown = Object.fromEntries(SOURCE_KINDS.map((kind) => [kind, 0])) as Record<SourceKind, number>;

  for (const [source, size] of bytes) {
    const entry = { ...classify(source, root), bytes: size };
    sources.push(entry);
    breakdown[entry.kind] += size;
    if (entry.package) {
      const pkg = packages.get(entry.package) ?? { name: packageOf(entry.path)!.name, dir: entry.package, bytes: 0, files: 0 };
      pkg.bytes += size;
      pkg.files += 1;
      packages.set(entry.package, pkg);
    }
  }

  for (const pkg of packages.values()) {
    const version = versionAt(root, pkg.dir);
    if (version) pkg.version = version;
    const via = chains.get(pkg.dir);
    if (via) pkg.via = via;
  }
  const bySize = <T extends { bytes: number }>(list: T[], key: (item: T) => string) =>
    list.sort((a, b) => b.bytes - a.bytes || key(a).localeCompare(key(b)));
  return {
    sources: bySize(sources, (s) => s.path),
    packages: bySize([...packages.values()], (p) => p.dir),
    breakdown,
  };
}
