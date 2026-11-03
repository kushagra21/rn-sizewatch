import { join } from "node:path";
import { findPackageDir } from "../core/project.js";
import { UserError, tail, type Exec } from "../core/exec.js";
import type { Platform, ProjectInfo } from "../core/types.js";

export interface BundleFiles {
  bundle: string;
  sourcemap: string;
  assetsDir: string;
}

export const bundleFiles = (dir: string, platform: Platform): BundleFiles => ({
  bundle: join(dir, platform === "ios" ? "main.jsbundle" : "index.android.bundle"),
  sourcemap: join(dir, "bundle.map"),
  assetsDir: join(dir, "assets"),
});

/**
 * The command that writes a release bundle, run with the project's own CLI so its Metro config applies.
 * Always minified, so bytes per package reflect code rather than comments and whitespace.
 */
export function bundleCommand(project: ProjectInfo, platform: Platform, files: BundleFiles, options: { resetCache?: boolean } = {}): string[] {
  const common = [
    "--platform", platform,
    "--dev", "false",
    "--minify", "true",
    "--bundle-output", files.bundle,
    "--sourcemap-output", files.sourcemap,
    "--assets-dest", files.assetsDir,
    ...(project.entry ? ["--entry-file", project.entry] : []),
    ...(options.resetCache ? ["--reset-cache"] : []),
  ];
  if (project.kind === "expo") return [join(findPackageDir(project.root, "expo")!, "bin", "cli"), "export:embed", ...common];
  return [join(findPackageDir(project.root, "react-native")!, "cli.js"), "bundle", ...common];
}

export async function writeBundle(exec: Exec, project: ProjectInfo, platform: Platform, files: BundleFiles, options: { resetCache?: boolean } = {}) {
  const args = bundleCommand(project, platform, files, options);
  const started = performance.now();
  const result = await exec(process.execPath, args, {
    cwd: project.root,
    timeoutMs: 15 * 60_000,
    env: { ...process.env, NODE_ENV: "production", CI: process.env.CI ?? "1" },
  });
  if (result.exitCode !== 0) {
    const cli = project.kind === "expo" ? "expo export:embed" : "react-native bundle";
    throw new UserError(`${cli} failed for ${platform}:\n${tail(result.stderr || result.stdout)}`);
  }
  return { ms: Math.round(performance.now() - started) };
}
