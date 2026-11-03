import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import pc from "picocolors";
import { dependencyChains } from "../attribution/dependencies.js";
import { attribute } from "../attribution/packages.js";
import { bytesBySource } from "../attribution/sourcemap.js";
import { compileHermes, findHermesc } from "../bundle/hermes.js";
import { bundleFiles, writeBundle } from "../bundle/metro.js";
import { measureAssets, sizesOf } from "../bundle/sizes.js";
import { loadConfig } from "../core/config.js";
import { exec as realExec, ToolMissingError, type Exec } from "../core/exec.js";
import { formatBytes, formatMs } from "../core/format.js";
import { detectProject } from "../core/project.js";
import { PLATFORMS, type Measurement, type Platform, type PlatformMeasurement, type ProjectInfo } from "../core/types.js";

export interface MeasureOptions {
  cwd: string;
  /** Default: the config's platforms, else both. */
  platform?: Platform | "both";
  entry?: string;
  /** Folder for the bundles and measure.json, relative to cwd. */
  out?: string;
  hermesc?: string;
  /** false skips Hermes even where it's on. */
  hermes?: boolean;
  resetCache?: boolean;
  json?: boolean;
}

export const DEFAULT_OUT = ".sizewatch";

async function gitInfo(exec: Exec, root: string): Promise<Measurement["git"]> {
  try {
    const commit = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
    if (commit.exitCode !== 0) return undefined;
    // On a pull request, GitHub checks out a detached merge commit; its env says which branch it is.
    let branch = process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || undefined;
    if (!branch) {
      const ref = await exec("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root });
      if (ref.exitCode === 0 && ref.stdout.trim() !== "HEAD") branch = ref.stdout.trim();
    }
    return { commit: commit.stdout.trim(), ...(branch ? { branch } : {}) };
  } catch (error) {
    if (error instanceof ToolMissingError) return undefined;
    throw error;
  }
}

/**
 * Runs Metro and hermesc for one platform. Compression, the slow part, carries on in the background
 * so the next platform can bundle meanwhile; `done` resolves with the measurement.
 */
async function measurePlatform(
  exec: Exec,
  project: ProjectInfo,
  platform: Platform,
  outDir: string,
  options: MeasureOptions,
  warn: (message: string) => void,
  chains: Map<string, string[]>,
): Promise<{ done: Promise<PlatformMeasurement> }> {
  const dir = join(outDir, platform);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const files = bundleFiles(dir, platform);

  const { ms: bundleMs } = await writeBundle(exec, project, platform, files, { resetCache: options.resetCache });
  const code = readFileSync(files.bundle);
  const map = readFileSync(files.sourcemap, "utf8");
  const { sources, packages, breakdown } = attribute(bytesBySource(code.toString("utf8"), map), project.root, chains);
  const timings: PlatformMeasurement["timings"] = { bundleMs };

  let bytecode: Buffer | undefined;
  if (project.hermes[platform] && options.hermes !== false) {
    const hermesc = findHermesc(project.root, options.hermesc);
    if (!hermesc) {
      warn(`Hermes is on for ${platform} but hermesc wasn't found in hermes-compiler or react-native/sdks; skipping bytecode. Pass --hermesc <path>.`);
    } else {
      const out = join(dir, "bundle.hbc");
      timings.hermesMs = (await compileHermes(exec, hermesc, files.bundle, out)).ms;
      bytecode = readFileSync(out);
    }
  }

  const done = Promise.all([sizesOf(code), bytecode && sizesOf(bytecode)]).then(([js, hermes]) => ({
    js,
    ...(hermes ? { hermes } : {}),
    assets: measureAssets(files.assetsDir),
    breakdown,
    packages,
    sources,
    timings,
  }));
  return { done };
}

export async function runMeasure(
  options: MeasureOptions,
  context: { version: string; exec?: Exec; warn?: (message: string) => void; progress?: (message: string) => void },
): Promise<{ measurement: Measurement; file: string }> {
  const exec = context.exec ?? realExec;
  const warn = context.warn ?? (() => {});
  // Metro writes real paths in source maps, so a symlinked root has to be resolved to match them.
  const root = realpathSync(resolve(options.cwd));
  const config = loadConfig(root);
  const project = detectProject(root, { entry: options.entry ?? config.entry });
  const outDir = resolve(root, options.out ?? DEFAULT_OUT);
  const platforms = options.platform === "both" ? [...PLATFORMS] : options.platform ? [options.platform] : (config.platforms ?? [...PLATFORMS]);

  const measurement: Measurement = {
    schemaVersion: 1,
    tool: { name: "rn-sizewatch", version: context.version },
    createdAt: new Date().toISOString(),
    project: { kind: project.kind, reactNative: project.reactNative, ...(project.expo ? { expo: project.expo } : {}), entry: project.entry, hermes: project.hermes },
    platforms: {},
  };
  const git = await gitInfo(exec, root);
  if (git) measurement.git = git;

  const chains = dependencyChains(root);
  // Bundles one at a time: two Metro processes would fight over the same cache.
  const pending: Promise<void>[] = [];
  for (const platform of platforms) {
    context.progress?.(`Bundling ${platform}…`);
    const { done } = await measurePlatform(exec, project, platform, outDir, options, warn, chains);
    pending.push(done.then((m) => void (measurement.platforms[platform] = m)));
  }
  await Promise.all(pending);

  const file = join(outDir, "measure.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(measurement, null, 2)}\n`);
  return { measurement, file };
}

const LABEL: Record<Platform, string> = { ios: "iOS", android: "Android" };

export function summary(measurement: Measurement, top = 8): string {
  const lines: string[] = [];
  for (const platform of PLATFORMS) {
    const m = measurement.platforms[platform];
    if (!m) continue;
    const time = formatMs(m.timings.bundleMs + (m.timings.hermesMs ?? 0));
    lines.push(`${pc.bold(LABEL[platform])} ${pc.dim(`(${time})`)}`);
    lines.push(`  JS bundle   ${formatBytes(m.js.raw).padStart(9)}   ${pc.dim(`gzip ${formatBytes(m.js.gzip)}, brotli ${formatBytes(m.js.brotli)}`)}`);
    if (m.hermes) lines.push(`  Hermes      ${formatBytes(m.hermes.raw).padStart(9)}   ${pc.dim(`gzip ${formatBytes(m.hermes.gzip)}, brotli ${formatBytes(m.hermes.brotli)}`)}`);
    lines.push(`  Assets      ${formatBytes(m.assets.bytes).padStart(9)}   ${pc.dim(`${m.assets.count} file${m.assets.count === 1 ? "" : "s"}`)}`);
    const b = m.breakdown;
    lines.push(pc.dim(`  JS by source: packages ${formatBytes(b.package)}, your code ${formatBytes(b.app)}, your JSON and asset modules ${formatBytes(b.data)}, Metro runtime ${formatBytes(b.runtime)}`));
    lines.push("  Biggest packages:");
    for (const pkg of m.packages.slice(0, top)) {
      const copies = m.packages.filter((p) => p.name === pkg.name).length;
      const note = copies > 1 ? pc.yellow(` (${copies} copies installed)`) : "";
      lines.push(`    ${formatBytes(pkg.bytes).padStart(9)}  ${pkg.name}${pkg.version ? pc.dim(`@${pkg.version}`) : ""}${note}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function measureCommand(options: MeasureOptions, version: string) {
  const progress = options.json ? undefined : (message: string) => console.error(pc.dim(message));
  const { measurement, file } = await runMeasure(options, { version, progress, warn: (message) => console.error(pc.yellow(message)) });
  if (options.json) {
    console.log(JSON.stringify(measurement, null, 2));
    return;
  }
  console.log(`\n${summary(measurement)}`);
  console.log(pc.dim(`Saved to ${relative(process.cwd(), file) || file}`));
}
