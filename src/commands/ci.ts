import { resolve } from "node:path";
import { prepare, run } from "../ci/action.js";
import { GitHub, addSummary, githubContext, setOutputs } from "../ci/github.js";
import { UserError } from "../core/exec.js";
import type { Platform } from "../core/types.js";

/** The action's first step: what this run does and where the base measurement is. */
export async function ciPrepareCommand(options: { cwd: string; name?: string }) {
  const github = new GitHub(githubContext());
  const top = process.env.GITHUB_WORKSPACE ?? options.cwd;
  const prepared = await prepare(github, { cwd: resolve(options.cwd), name: options.name || undefined, top });
  const what = {
    baseline: `Measuring ${github.context.sha.slice(0, 7)} as a baseline for later pull requests.`,
    pr: `Pull request #${prepared.prNumber}: comparing with ${prepared.baseSha?.slice(0, 7)}${prepared.baseRunId ? ", measured in run " + prepared.baseRunId : ", which will be built here (no saved measurement)"}.`,
    skip: `Skipping: the pull request changes ${prepared.reason}.`,
  }[prepared.mode];
  console.log(what);
  setOutputs({
    mode: prepared.mode,
    artifact: prepared.artifact,
    "pr-number": prepared.prNumber?.toString(),
    "base-sha": prepared.baseSha,
    "base-artifact": prepared.baseArtifact,
    "base-run-id": prepared.baseRunId,
    "metro-cache": prepared.metroCache,
    "cache-key": prepared.cacheKey,
    "cache-restore-keys": prepared.cacheRestoreKeys,
  });
}

export interface CiRunOptions {
  cwd: string;
  mode: string;
  tmp: string;
  platform?: string;
  name?: string;
  baseSha?: string;
  baseFile?: string;
  pr?: string;
  comment: string;
}

/** The action's main step: measure, and on a pull request compare and comment. */
export async function ciRunCommand(options: CiRunOptions, version: string) {
  if (options.mode !== "baseline" && options.mode !== "pr") throw new UserError(`--mode should be baseline or pr, not ${options.mode}.`);
  const platform = options.platform ? (options.platform as Platform | "both") : undefined;
  if (platform && !["ios", "android", "both"].includes(platform)) throw new UserError(`platforms should be ios, android or both, not ${platform}.`);
  const github = options.mode === "pr" ? new GitHub(githubContext()) : undefined;

  const result = await run(github, {
    cwd: resolve(options.cwd),
    mode: options.mode,
    tmp: resolve(options.tmp),
    platform,
    name: options.name || undefined,
    baseSha: options.baseSha || undefined,
    baseFile: options.baseFile || undefined,
    prNumber: options.pr ? Number(options.pr) : undefined,
    headSha: github?.context.event.pull_request?.head?.sha,
    comment: options.comment !== "false",
    version,
  });
  if (result.markdown) addSummary(result.markdown);
  setOutputs({
    "measure-file": result.measureFile,
    "base-built-file": result.baseBuiltFile,
    "budget-failed": String(result.failed),
    commented: result.commented,
  });
}
