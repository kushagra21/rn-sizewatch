import type { Budgets, Config } from "../core/config.js";
import { formatBytes } from "../core/format.js";
import { PLATFORMS, type Measurement, type Platform } from "../core/types.js";
import { totalsOf } from "./diff.js";

export type BudgetName = keyof Budgets;

export interface BudgetResult {
  platform: Platform;
  budget: BudgetName;
  /** The size measured; for "increase", the growth of the shipped size. */
  actual: number;
  limit: number;
  /** The limit as written, e.g. "5% (51 KB)". */
  limitText: string;
  pass: boolean;
}

/** Absolute budgets against `head`; the increase budget only when there's a `base` to compare with. */
export function checkBudgets(config: Config, head: Measurement, base?: Measurement): BudgetResult[] {
  const results: BudgetResult[] = [];
  for (const platform of PLATFORMS) {
    const m = head.platforms[platform];
    if (!m) continue;
    const budgets = config.budgets[platform];
    const totals = totalsOf(m);
    const add = (budget: BudgetName, actual: number | undefined, limit: number | undefined, limitText = formatBytes(limit ?? 0)) => {
      if (actual === undefined || limit === undefined) return;
      results.push({ platform, budget, actual, limit, limitText, pass: actual <= limit });
    };
    add("js", totals.js, budgets.js);
    add("hermes", totals.hermes, budgets.hermes);
    add("assets", totals.assets, budgets.assets);

    const before = base?.platforms[platform];
    if (budgets.increase && before) {
      const baseShipped = totalsOf(before).shipped;
      const growth = totals.shipped - baseShipped;
      if ("percent" in budgets.increase) {
        const limit = Math.round((baseShipped * budgets.increase.percent) / 100);
        add("increase", growth, limit, `${budgets.increase.percent}% (${formatBytes(limit)})`);
      } else {
        add("increase", growth, budgets.increase.bytes);
      }
    }
  }
  return results;
}
