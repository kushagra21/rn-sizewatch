import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { checkBudgets } from "../compare/budgets.js";
import { compare } from "../compare/diff.js";
import { readMeasurement } from "../commands/compare.js";
import { runMeasure } from "../commands/measure.js";
import { loadConfig } from "../core/config.js";
import { exec as realExec, tail, UserError, type Exec } from "../core/exec.js";
import type { Platform } from "../core/types.js";
import { commentMarker, renderMarkdown } from "../render/markdown.js";
import { GitHub, GitHubError } from "./github.js";

const PR_EVENTS = ["pull_request", "pull_request_target"];

/** Files that can change the JS bundle or its assets; a PR touching none of them is skipped. */
const RELEVANT_EXTENSION = /\.(?:[cm]?[jt]sx?|json|json5|png|jpe?g|gif|webp|bmp|svg|ttf|otf|woff2?|mp3|mp4|wav|m4a|aac|lottie|html|txt)$/i;
const RELEVANT_NAME = /^(?:\.babelrc|\.npmrc|\.yarnrc(?:\.yml)?|\.pnpmfile\.cjs|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|\.env(?:\..+)?)$/;
export const isRelevant = (file: string) => RELEVANT_EXTENSION.test(file) || RELEVANT_NAME.test(basename(file));

const LOCKFILES: [string, (dir: string) => string[]][] = [
  ["package-lock.json", () => ["npm", "ci", "--no-audit", "--no-fund"]],
  ["npm-shrinkwrap.json", () => ["npm", "ci", "--no-audit", "--no-fund"]],
  ["pnpm-lock.yaml", () => ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", (dir) => (existsSync(join(dir, ".yarnrc.yml")) ? ["yarn", "install", "--immutable"] : ["yarn", "install", "--frozen-lockfile"])],
  ["bun.lock", () => ["bun", "install", "--frozen-lockfile"]],
  ["bun.lockb", () => ["bun", "install", "--frozen-lockfile"]],
];

/** The nearest lockfile from `dir` up to `top`, and the command that installs from it. */
export function findLockfile(dir: string, top: string): { dir: string; file: string; install: string[] } | undefined {
  for (let current = resolve(dir); ; current = dirname(current)) {
    for (const [file, install] of LOCKFILES) if (existsSync(join(current, file))) return { dir: current, file, install: install(current) };
    if (current === resolve(top) || dirname(current) === current) return undefined;
  }
}

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-");
export const artifactName = (sha: string, name?: string) => `rn-sizewatch-${name ? `${safeName(name)}-` : ""}${sha}`;

export interface Prepared {
  mode: "baseline" | "pr" | "skip";
  /** Why a PR is skipped. */
  reason?: string;
  /** Baseline: the name to upload this commit's measurement under. */
  artifact: string;
  prNumber?: number;
  baseSha?: string;
  /** PR: the name the base commit's measurement is saved under (downloaded, or uploaded once built here). */
  baseArtifact?: string;
  /** PR: the run that saved it, when one did. */
  baseRunId?: string;
  metroCache: string;
  cacheKey: string;
  cacheRestoreKeys: string;
}

/** Decides what this run does, and finds the base commit's saved measurement for a PR. */
export async function prepare(github: GitHub, options: { cwd: string; name?: string; top?: string }): Promise<Prepared> {
  const { context } = github;
  const lock = findLockfile(options.cwd, options.top ?? options.cwd);
  const lockHash = lock ? createHash("sha256").update(readFileSync(join(lock.dir, lock.file))).digest("hex").slice(0, 16) : "none";
  const prefix = `rn-sizewatch-metro-${process.platform}-${options.name ? `${safeName(options.name)}-` : ""}`;
  const common = {
    artifact: artifactName(context.sha, options.name),
    // Metro keeps its cache in the system temp folder; it's keyed by file contents, so an older one is safe to restore.
    metroCache: [join(tmpdir(), "metro-*"), join(tmpdir(), "haste-map-*")].join("\n"),
    cacheKey: `${prefix}${lockHash}-${context.sha}`,
    cacheRestoreKeys: [`${prefix}${lockHash}-`, prefix].join("\n"),
  };

  if (!PR_EVENTS.includes(context.eventName)) return { mode: "baseline", ...common };

  const pr = context.event.pull_request;
  if (!pr) throw new UserError(`The ${context.eventName} event has no pull_request.`);
  const prNumber = pr.number as number;
  const baseSha = pr.base.sha as string;
  // GitHub lists at most 3000 files; a PR that big is measured whatever it touches.
  const files = await github.list<{ filename: string }>(`/repos/${context.repo}/pulls/${prNumber}/files`);
  if (files.length < 3000 && !files.some((f) => isRelevant(f.filename))) {
    return { mode: "skip", reason: "no file that can change the JS bundle or its assets", prNumber, baseSha, ...common };
  }

  const baseArtifact = artifactName(baseSha, options.name);
  const found = await github.list<{ expired: boolean; workflow_run?: { id: number } }>(
    `/repos/${context.repo}/actions/artifacts?name=${encodeURIComponent(baseArtifact)}`,
    100,
    (page) => page.artifacts,
  );
  const usable = found.find((a) => !a.expired && a.workflow_run?.id);
  return {
    mode: "pr",
    prNumber,
    baseSha,
    baseArtifact,
    ...(usable ? { baseRunId: String(usable.workflow_run!.id) } : {}),
    ...common,
  };
}

export interface RunOptions {
  cwd: string;
  mode: "baseline" | "pr";
  /** Scratch folder; measurements go to head/ and base/ in it. */
  tmp: string;
  platform?: Platform | "both";
  name?: string;
  baseSha?: string;
  /** The downloaded base measurement; built from baseSha when missing. */
  baseFile?: string;
  prNumber?: number;
  comment: boolean;
  version: string;
}

export interface RunResult {
  measureFile: string;
  /** A base measurement built in this run, worth saving for the next PR. */
  baseBuiltFile?: string;
  failed: boolean;
  commented?: "created" | "updated" | "forbidden";
  markdown?: string;
}

/** Checks out the base commit next to this one, installs it the way the project does, and measures it. */
export async function buildBase(exec: Exec, options: { cwd: string; sha: string; tmp: string; platform?: Platform | "both"; version: string; log: (m: string) => void }) {
  const git = async (args: string[], cwd: string) => {
    const result = await exec("git", args, { cwd, timeoutMs: 10 * 60_000 });
    if (result.exitCode !== 0) throw new UserError(`git ${args.join(" ")} failed:\n${tail(result.stderr || result.stdout)}`);
    return result.stdout.trim();
  };
  const top = await git(["rev-parse", "--show-toplevel"], options.cwd);
  const sub = relative(top, resolve(options.cwd));
  const dir = join(options.tmp, "base-src");
  rmSync(dir, { recursive: true, force: true });
  options.log(`No saved measurement for the base commit ${options.sha.slice(0, 7)}; building it here.`);
  await git(["fetch", "--no-tags", "--depth=1", "origin", options.sha], top);
  await git(["worktree", "add", "--detach", "--force", dir, options.sha], top);

  const appDir = join(dir, sub);
  const lock = findLockfile(appDir, dir);
  if (!lock) throw new UserError("The base commit has no lockfile (package-lock.json, yarn.lock, pnpm-lock.yaml or bun.lock), so it can't be installed the same way.");
  options.log(`Installing the base commit with ${lock.install.join(" ")}…`);
  const install = await exec(lock.install[0]!, lock.install.slice(1), { cwd: lock.dir, timeoutMs: 20 * 60_000, env: { ...process.env, CI: "1" } });
  if (install.exitCode !== 0) throw new UserError(`${lock.install.join(" ")} failed for the base commit:\n${tail(install.stderr || install.stdout)}`);

  const { file } = await runMeasure({ cwd: appDir, platform: options.platform, out: join(options.tmp, "base") }, { version: options.version, exec, warn: options.log });
  return file;
}

/** One comment per PR (and per app name), edited on every run. */
export async function upsertComment(github: GitHub, prNumber: number, body: string, marker: string): Promise<RunResult["commented"]> {
  const { repo } = github.context;
  try {
    const comments = await github.list<{ id: number; body?: string; user?: { type?: string } }>(`/repos/${repo}/issues/${prNumber}/comments`);
    const mine = comments.find((c) => c.user?.type === "Bot" && c.body?.includes(marker));
    if (mine) {
      await github.request("PATCH", `/repos/${repo}/issues/comments/${mine.id}`, { body });
      return "updated";
    }
    await github.request("POST", `/repos/${repo}/issues/${prNumber}/comments`, { body });
    return "created";
  } catch (error) {
    // A pull request from a fork gets a read-only token.
    if (error instanceof GitHubError && (error.status === 403 || error.status === 404)) return "forbidden";
    throw error;
  }
}

export async function run(github: GitHub | undefined, options: RunOptions, context: { exec?: Exec; log?: (m: string) => void } = {}): Promise<RunResult> {
  const exec = context.exec ?? realExec;
  const log = context.log ?? console.log;
  const { file: measureFile } = await runMeasure({ cwd: options.cwd, platform: options.platform, out: join(options.tmp, "head") }, { version: options.version, exec, warn: log, progress: log });
  if (options.mode === "baseline") return { measureFile, failed: false };

  let baseFile = options.baseFile && existsSync(options.baseFile) ? options.baseFile : undefined;
  let baseBuiltFile: string | undefined;
  if (!baseFile) {
    if (!options.baseSha) throw new UserError("A pull request run needs the base commit.");
    baseBuiltFile = baseFile = await buildBase(exec, { cwd: options.cwd, sha: options.baseSha, tmp: options.tmp, platform: options.platform, version: options.version, log });
  }

  const config = loadConfig(resolve(options.cwd));
  const base = readMeasurement(baseFile);
  const head = readMeasurement(measureFile);
  const comparison = compare(base, head);
  const budgets = checkBudgets(config, head, base);
  const markdown = renderMarkdown(comparison, { threshold: config.threshold, budgets, version: options.version, name: options.name });
  const failed = budgets.some((b) => !b.pass);

  let commented: RunResult["commented"];
  if (options.comment && github && options.prNumber) {
    commented = await upsertComment(github, options.prNumber, markdown, commentMarker(options.name));
    if (commented === "forbidden") log("This token can't comment on the pull request (a fork's token is read-only); the result is in the job summary.");
  }
  return { measureFile, ...(baseBuiltFile ? { baseBuiltFile } : {}), failed, ...(commented ? { commented } : {}), markdown };
}
