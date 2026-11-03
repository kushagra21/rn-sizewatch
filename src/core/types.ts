export const PLATFORMS = ["ios", "android"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Byte counts of one file as stored and as served compressed (OTA updates are downloaded compressed). */
export interface Sizes {
  raw: number;
  gzip: number;
  brotli: number;
}

/**
 * Where a source file's bytes come from:
 * app = your own code, data = your own JSON and image/font modules, package = node_modules,
 * runtime = code Metro generates (the prelude and module system).
 */
export const SOURCE_KINDS = ["app", "data", "package", "runtime"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface SourceSize {
  /** Relative to the project root, with forward slashes. */
  path: string;
  bytes: number;
  kind: SourceKind;
  /** For kind "package": the package folder it belongs to, as in PackageSize.dir. */
  package?: string;
}

/** One installed copy of a package. Two entries with the same name are duplicate copies. */
export interface PackageSize {
  name: string;
  version?: string;
  /** The package folder relative to the project root, e.g. node_modules/a/node_modules/b. */
  dir: string;
  bytes: number;
  files: number;
  /**
   * The chain of packages that brings this one in, from one of the app's direct dependencies down
   * to its parent; [] when the app depends on it directly. Absent when no dependency leads to it.
   */
  via?: string[];
}

export interface AssetSize {
  /** Relative to the assets folder Metro wrote. */
  path: string;
  bytes: number;
}

export interface PlatformMeasurement {
  /** The minified JS bundle. Bytes per package and file are measured on this. */
  js: Sizes;
  /** The Hermes bytecode compiled from the bundle; what ships when Hermes is on. */
  hermes?: Sizes;
  /** Images, fonts and other files loaded with require(); they ship next to the bundle, not in it. */
  assets: { bytes: number; count: number; files: AssetSize[] };
  /** JS bundle bytes by kind of source. */
  breakdown: Record<SourceKind, number>;
  packages: PackageSize[];
  sources: SourceSize[];
  timings: { bundleMs: number; hermesMs?: number };
}

export interface ProjectInfo {
  /** Absolute; never written to the measurement file. */
  root: string;
  kind: "bare" | "expo";
  reactNative: string;
  expo?: string;
  /** Relative to the root. Undefined for Expo when the CLI resolves it itself. */
  entry?: string;
  hermes: Record<Platform, boolean>;
}

export interface Measurement {
  schemaVersion: 1;
  tool: { name: "rn-sizewatch"; version: string };
  createdAt: string;
  git?: { commit: string; branch?: string };
  project: Omit<ProjectInfo, "root">;
  platforms: Partial<Record<Platform, PlatformMeasurement>>;
}
