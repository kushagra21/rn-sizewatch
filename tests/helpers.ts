import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { ToolMissingError, type Exec, type ExecResult } from "../src/core/exec.js";
import type { Measurement, PackageSize, PlatformMeasurement, SourceSize } from "../src/core/types.js";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SourceMapInput } from "@jridgewell/trace-mapping";
import { addMapping, setSourceContent, toEncodedMap, GenMapping } from "@jridgewell/gen-mapping";

/** A temporary folder with the given files; values that aren't strings are written as JSON. */
export function makeDir(files: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rn-sizewatch-")));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

export const bareApp = (extra: Record<string, unknown> = {}) =>
  makeDir({
    "package.json": { name: "app", dependencies: { "react-native": "0.83.6" } },
    "node_modules/react-native/package.json": { name: "react-native", version: "0.83.6" },
    "index.js": "",
    ...extra,
  });

/**
 * Line i of a bundle: `text` is the whole line; `maps` gives the parts of it that map to a source
 * (by column), the rest is unmapped. A line with no maps has no mappings at all.
 */
export interface Line {
  text: string;
  maps?: { column: number; source: string }[];
}

/** A Metro-style bundle and its source map; `sources` sets the order sources are listed in. */
export function makeBundle(lines: Line[], sources: string[]) {
  const map = new GenMapping({ file: "main.jsbundle" });
  for (const source of sources) setSourceContent(map, source, "");
  lines.forEach((line, i) => {
    for (const part of line.maps ?? []) {
      // A segment without a source ends the previous one; a source segment starts a new part.
      if (part.source === "") addMapping(map, { generated: { line: i + 1, column: part.column } });
      else addMapping(map, { generated: { line: i + 1, column: part.column }, source: part.source, original: { line: 1, column: 0 } });
    }
  });
  return { code: lines.map((l) => l.text).join("\n"), map: toEncodedMap(map) as unknown as SourceMapInput };
}

export const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
export const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

/** A machine where Metro writes a small bundle with one asset, hermesc writes bytecode, and git may be missing. */
export function fakeExec(options: { git?: boolean; metroFails?: boolean; other?: (file: string, args: string[], cwd?: string) => ExecResult | undefined } = {}): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (file: string, args: string[], execOptions?: { cwd?: string }) => {
    calls.push([file, ...args]);
    const handled = options.other?.(file, args, execOptions?.cwd);
    if (handled) return handled;
    if (file === "git") {
      if (!options.git) throw new ToolMissingError("git");
      return ok(args.includes("--abbrev-ref") ? "feature/x\n" : "abc123\n");
    }
    if (file === process.execPath) {
      if (options.metroFails) return { stdout: "", stderr: "info Writing bundle\nerror Unable to resolve module ./missing", exitCode: 1 };
      const root = dirname(dirname(dirname(args[0]!)));
      const { code, map } = makeBundle(
        [
          { text: "__d(function(){var a=1},0,[]);", maps: [{ column: 15, source: `${root}/index.js` }] },
          { text: "__d(function(){var lodash=1},1,[]);", maps: [{ column: 15, source: `${root}/node_modules/lodash/index.js` }] },
        ],
        [`${root}/index.js`, `${root}/node_modules/lodash/index.js`],
      );
      writeFileSync(argAfter(args, "--bundle-output"), code);
      writeFileSync(argAfter(args, "--sourcemap-output"), JSON.stringify(map));
      mkdirSync(join(argAfter(args, "--assets-dest"), "img"), { recursive: true });
      writeFileSync(join(argAfter(args, "--assets-dest"), "img", "logo.png"), Buffer.alloc(1234));
      return ok();
    }
    if (file === "/fake/hermesc") {
      writeFileSync(argAfter(args, "-out"), Buffer.alloc(5000, 7));
      return ok();
    }
    throw new Error(`unexpected ${file}`);
  }) as Exec & { calls: string[][] };
  run.calls = calls;
  return run;
}


export interface Spec {
  packages?: (Omit<PackageSize, "files"> & { files?: Record<string, number> })[];
  app?: Record<string, number>;
  data?: Record<string, number>;
  runtime?: number;
  assets?: Record<string, number>;
  hermes?: number;
}

/** A platform measurement from just the parts a test cares about; sizes add up like the real thing. */
export function platform(spec: Spec): PlatformMeasurement {
  const sources: SourceSize[] = [];
  const packages: PackageSize[] = [];
  for (const { files = { "index.js": 0 }, ...pkg } of spec.packages ?? []) {
    const entries = Object.entries(files);
    const each = entries.some(([, b]) => b) ? undefined : pkg.bytes / entries.length;
    for (const [file, bytes] of entries) sources.push({ path: `${pkg.dir}/${file}`, bytes: each ?? bytes, kind: "package", package: pkg.dir });
    packages.push({ ...pkg, files: entries.length });
  }
  for (const [path, bytes] of Object.entries(spec.app ?? {})) sources.push({ path, bytes, kind: "app" });
  for (const [path, bytes] of Object.entries(spec.data ?? {})) sources.push({ path, bytes, kind: "data" });
  if (spec.runtime) sources.push({ path: "__prelude__", bytes: spec.runtime, kind: "runtime" });
  const sum = (kind: SourceSize["kind"]) => sources.filter((s) => s.kind === kind).reduce((a, s) => a + s.bytes, 0);
  const js = sources.reduce((a, s) => a + s.bytes, 0);
  const assetFiles = Object.entries(spec.assets ?? {}).map(([path, bytes]) => ({ path, bytes }));
  return {
    js: { raw: js, gzip: Math.round(js / 4), brotli: Math.round(js / 5) },
    ...(spec.hermes !== undefined ? { hermes: { raw: spec.hermes, gzip: Math.round(spec.hermes / 2.5), brotli: Math.round(spec.hermes / 3) } } : {}),
    assets: { bytes: assetFiles.reduce((a, f) => a + f.bytes, 0), count: assetFiles.length, files: assetFiles },
    breakdown: { app: sum("app"), data: sum("data"), package: sum("package"), runtime: sum("runtime") },
    packages,
    sources,
    timings: { bundleMs: 1000 },
  };
}

export function measurement(ios: Spec, android: Spec | null = ios, commit = "a".repeat(40)): Measurement {
  return {
    schemaVersion: 1,
    tool: { name: "rn-sizewatch", version: "0.0.0" },
    createdAt: "2026-11-03T00:00:00.000Z",
    git: { commit, branch: "main" },
    project: { kind: "bare", reactNative: "0.83.6", entry: "index.js", hermes: { ios: true, android: true } },
    platforms: { ios: platform(ios), ...(android ? { android: platform(android) } : {}) },
  };
}

