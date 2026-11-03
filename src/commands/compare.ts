import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import pc from "picocolors";
import { checkBudgets, type BudgetResult } from "../compare/budgets.js";
import { compare, type Comparison } from "../compare/diff.js";
import { CONFIG_FILE, hasBudgets, loadConfig, parseSize } from "../core/config.js";
import { UserError } from "../core/exec.js";
import type { Measurement } from "../core/types.js";
import { renderMarkdown } from "../render/markdown.js";
import { renderBudgets, renderTerminal } from "../render/terminal.js";
import { DEFAULT_OUT } from "./measure.js";

/** Relative to where you are when that's shorter to read, else absolute. */
const displayPath = (file: string) => {
  const rel = relative(process.cwd(), file);
  return rel && !rel.startsWith("..") ? rel : file;
};

export function readMeasurement(file: string): Measurement {
  if (!existsSync(file)) throw new UserError(`${file} doesn't exist. Write one with rn-sizewatch measure.`);
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UserError(`${file} isn't valid JSON: ${(error as Error).message}`);
  }
}

export interface CompareOptions {
  /** Where sizewatch.config.json is. */
  cwd: string;
  markdown?: string;
  json?: boolean;
  threshold?: string;
  all?: boolean;
}

export function runCompare(basePath: string, headPath: string, options: CompareOptions, version: string) {
  const root = resolve(options.cwd);
  const config = loadConfig(root);
  const threshold = options.threshold === undefined ? config.threshold : parseSize(options.threshold, "--threshold");
  const base = readMeasurement(resolve(root, basePath));
  const head = readMeasurement(resolve(root, headPath));
  const comparison = compare(base, head);
  const budgets = checkBudgets(config, head, base);
  return { comparison, budgets, threshold, markdown: renderMarkdown(comparison, { threshold, budgets, version }), failed: budgets.some((b) => !b.pass) };
}

const forJson = (comparison: Comparison, budgets: BudgetResult[]) => {
  const { base, head, ...rest } = comparison;
  return { ...rest, base: { git: base.git }, head: { git: head.git }, budgets };
};

export function compareCommand(base: string, head: string, options: CompareOptions, version: string) {
  const result = runCompare(base, head, options, version);
  if (options.markdown) {
    const file = resolve(options.cwd, options.markdown);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, result.markdown);
  }
  if (options.json) console.log(JSON.stringify(forJson(result.comparison, result.budgets), null, 2));
  else {
    console.log(renderTerminal(result.comparison, { threshold: result.threshold, budgets: result.budgets, all: options.all }));
    if (options.markdown) console.log(pc.dim(`\nComment written to ${displayPath(resolve(options.cwd, options.markdown))}`));
  }
  if (result.failed) process.exitCode = 1;
}

export interface CheckOptions {
  cwd: string;
  base?: string;
  json?: boolean;
}

export function checkCommand(file: string | undefined, options: CheckOptions) {
  const root = resolve(options.cwd);
  const config = loadConfig(root);
  if (!hasBudgets(config)) {
    console.log(`No budgets in ${CONFIG_FILE}, so there's nothing to check.`);
    return;
  }
  const head = readMeasurement(resolve(root, file ?? join(DEFAULT_OUT, "measure.json")));
  const base = options.base ? readMeasurement(resolve(root, options.base)) : undefined;
  const results = checkBudgets(config, head, base);
  if (options.json) console.log(JSON.stringify(results, null, 2));
  else {
    console.log(renderBudgets(results).join("\n"));
    if (!base && Object.values(config.budgets).some((b) => b.increase)) console.log(pc.dim("The increase budget needs --base <measure.json> to compare with."));
  }
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}
