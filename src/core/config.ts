import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { UserError } from "./exec.js";
import { PLATFORMS, type Platform } from "./types.js";

export const CONFIG_FILE = "sizewatch.config.json";

/** How much the shipped size may grow in one change: a number of bytes or a share of the base size. */
export type Increase = { bytes: number } | { percent: number };

export interface Budgets {
  js?: number;
  hermes?: number;
  assets?: number;
  increase?: Increase;
}

export interface Config {
  budgets: Record<Platform, Budgets>;
  /** Changes smaller than this go in the collapsed list. */
  threshold: number;
  platforms?: Platform[];
  entry?: string;
}

export const DEFAULT_THRESHOLD = 1000;

const UNITS: Record<string, number> = { b: 1, kb: 1000, mb: 1_000_000, gb: 1_000_000_000, kib: 1024, mib: 1024 ** 2 };

/** "50 KB", "1.5MB", "200 B" or a plain number of bytes. KB is 1000 bytes, KiB 1024. */
export function parseSize(value: unknown, field: string): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.round(value);
  const match = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*([a-z]*)\s*$/i.exec(value) : null;
  const unit = match ? UNITS[(match[2] || "b").toLowerCase()] : undefined;
  if (!match || !unit) throw new UserError(`${CONFIG_FILE}: ${field} should be a size like "50 KB" or "2 MB", not ${JSON.stringify(value)}.`);
  return Math.round(Number(match[1]) * unit);
}

export function parseIncrease(value: unknown, field: string): Increase {
  const percent = typeof value === "string" ? /^\s*(\d+(?:\.\d+)?)\s*%\s*$/.exec(value) : null;
  return percent ? { percent: Number(percent[1]) } : { bytes: parseSize(value, field) };
}

const BUDGET_KEYS = ["js", "hermes", "assets", "increase"] as const;

function parseBudgets(raw: Record<string, unknown>, field: string): Budgets {
  const budgets: Budgets = {};
  for (const key of BUDGET_KEYS) {
    if (raw[key] === undefined) continue;
    if (key === "increase") budgets.increase = parseIncrease(raw[key], `${field}.increase`);
    else budgets[key] = parseSize(raw[key], `${field}.${key}`);
  }
  return budgets;
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function parseConfig(raw: unknown): Config {
  if (!isObject(raw)) throw new UserError(`${CONFIG_FILE} should hold a JSON object.`);
  const known = ["budgets", "threshold", "platforms", "entry", "$schema"];
  const unknown = Object.keys(raw).filter((key) => !known.includes(key));
  if (unknown.length) throw new UserError(`${CONFIG_FILE}: unknown option ${unknown.join(", ")}. Known: ${known.slice(0, 4).join(", ")}.`);

  const budgetsRaw = raw.budgets ?? {};
  if (!isObject(budgetsRaw)) throw new UserError(`${CONFIG_FILE}: budgets should be an object.`);
  const extra = Object.keys(budgetsRaw).filter((key) => !(BUDGET_KEYS as readonly string[]).includes(key) && !(PLATFORMS as readonly string[]).includes(key));
  if (extra.length) throw new UserError(`${CONFIG_FILE}: unknown budget ${extra.join(", ")}. Budgets: ${BUDGET_KEYS.join(", ")}, with ios or android overrides.`);
  const shared = parseBudgets(budgetsRaw, "budgets");
  const budgets = Object.fromEntries(
    PLATFORMS.map((platform) => {
      const override = budgetsRaw[platform];
      if (override !== undefined && !isObject(override)) throw new UserError(`${CONFIG_FILE}: budgets.${platform} should be an object.`);
      return [platform, { ...shared, ...(override ? parseBudgets(override, `budgets.${platform}`) : {}) }];
    }),
  ) as Record<Platform, Budgets>;

  const config: Config = { budgets, threshold: raw.threshold === undefined ? DEFAULT_THRESHOLD : parseSize(raw.threshold, "threshold") };
  if (raw.platforms !== undefined) {
    const list = raw.platforms;
    if (!Array.isArray(list) || list.length === 0 || list.some((p) => !(PLATFORMS as readonly unknown[]).includes(p))) {
      throw new UserError(`${CONFIG_FILE}: platforms should be a list of "ios" and/or "android".`);
    }
    config.platforms = [...new Set(list as Platform[])];
  }
  if (raw.entry !== undefined) {
    if (typeof raw.entry !== "string") throw new UserError(`${CONFIG_FILE}: entry should be a file path.`);
    config.entry = raw.entry;
  }
  return config;
}

/** The project's config; defaults when there's no file. */
export function loadConfig(root: string): Config {
  const file = join(root, CONFIG_FILE);
  if (!existsSync(file)) return parseConfig({});
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new UserError(`${CONFIG_FILE} isn't valid JSON: ${(error as Error).message}`);
  }
  return parseConfig(raw);
}

export const hasBudgets = (config: Config) => PLATFORMS.some((p) => Object.keys(config.budgets[p]).length > 0);
