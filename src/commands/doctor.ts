import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import pc from "picocolors";
import { findHermesc } from "../bundle/hermes.js";
import { CONFIG_FILE, hasBudgets, loadConfig } from "../core/config.js";
import { exec as realExec, ToolMissingError, UserError, type Exec } from "../core/exec.js";
import { findPackageDir, detectProject } from "../core/project.js";
import { PLATFORMS } from "../core/types.js";

export interface Check {
  ok: boolean;
  /** Not having it is fine, just worth knowing. */
  optional?: boolean;
  label: string;
  detail: string;
}

export async function doctor(cwd: string, exec: Exec = realExec): Promise<Check[]> {
  const root = resolve(cwd);
  const checks: Check[] = [];
  const failed = (label: string, error: unknown) => {
    if (!(error instanceof UserError)) throw error;
    checks.push({ ok: false, label, detail: error.message });
  };

  try {
    const config = loadConfig(root);
    checks.push({ ok: true, optional: true, label: CONFIG_FILE, detail: existsSync(join(root, CONFIG_FILE)) ? (hasBudgets(config) ? "valid, with budgets" : "valid, no budgets") : "none (defaults apply)" });
  } catch (error) {
    failed(CONFIG_FILE, error);
  }

  try {
    const project = detectProject(root, { entry: undefined });
    const kind = project.kind === "expo" ? `Expo ${project.expo}` : "bare React Native";
    checks.push({ ok: true, label: "Project", detail: `${kind}, react-native ${project.reactNative}${project.entry ? `, entry ${project.entry}` : ""}` });

    const cli = project.kind === "expo" ? join(findPackageDir(root, "expo")!, "bin", "cli") : join(findPackageDir(root, "react-native")!, "cli.js");
    checks.push({ ok: existsSync(cli), label: "Bundler", detail: existsSync(cli) ? (project.kind === "expo" ? "expo export:embed" : "react-native bundle") : `${cli} is missing` });

    const hermesPlatforms = PLATFORMS.filter((p) => project.hermes[p]);
    if (hermesPlatforms.length) {
      const hermesc = findHermesc(root);
      checks.push({ ok: !!hermesc, label: "Hermes", detail: hermesc ? `on for ${hermesPlatforms.join(" and ")}; compiler ${hermesc}` : `on for ${hermesPlatforms.join(" and ")} but no hermesc in hermes-compiler or react-native/sdks; pass --hermesc` });
    } else {
      checks.push({ ok: true, optional: true, label: "Hermes", detail: "off; the JS bundle is what ships" });
    }
  } catch (error) {
    failed("Project", error);
  }

  try {
    const git = await exec("git", ["rev-parse", "--short", "HEAD"], { cwd: root });
    checks.push({ ok: git.exitCode === 0, optional: true, label: "git", detail: git.exitCode === 0 ? `at ${git.stdout.trim()}` : "not a git repository; measurements won't record a commit" });
  } catch (error) {
    if (!(error instanceof ToolMissingError)) throw error;
    checks.push({ ok: false, optional: true, label: "git", detail: "not installed; measurements won't record a commit" });
  }
  return checks;
}

export async function doctorCommand(options: { cwd: string }) {
  const checks = await doctor(options.cwd);
  for (const check of checks) {
    const mark = check.ok ? pc.green("✓") : check.optional ? pc.yellow("!") : pc.red("✗");
    console.log(`${mark} ${pc.bold(check.label.padEnd(22))} ${check.detail}`);
  }
  if (checks.some((c) => !c.ok && !c.optional)) process.exitCode = 1;
}
