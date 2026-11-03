import pc from "picocolors";
import type { BudgetResult } from "../compare/budgets.js";
import { biggest, type Comparison } from "../compare/diff.js";
import { formatBytes } from "../core/format.js";
import { PLATFORM_LABEL, TERMINAL, describe, describeBudget, signed } from "./describe.js";

const colored = (delta: number, threshold: number) => {
  const text = signed(delta);
  return delta >= threshold ? pc.red(text) : delta <= -threshold ? pc.green(text) : pc.dim(text);
};

export function renderBudgets(budgets: BudgetResult[]): string[] {
  return budgets.map((b) => (b.pass ? `${pc.green("✓")} ${describeBudget(b)}` : `${pc.red("✗")} ${describeBudget(b)}`));
}

export function renderTerminal(comparison: Comparison, options: { threshold: number; budgets: BudgetResult[]; all?: boolean }): string {
  const { threshold } = options;
  const lines: string[] = [];
  for (const platform of comparison.platforms) {
    const { base, head } = comparison.totals[platform]!;
    const cell = (label: string, b: number | undefined, h: number | undefined) =>
      h === undefined ? "" : `${label} ${formatBytes(h)} ${colored(h - (b ?? 0), threshold)}`;
    const cells = [cell("JS", base.js, head.js), cell("Hermes", base.hermes, head.hermes), cell("assets", base.assets, head.assets), cell("OTA", base.ota, head.ota)];
    lines.push(`${pc.bold(PLATFORM_LABEL[platform].padEnd(8))} ${cells.filter(Boolean).join("   ")}`);
  }
  if (comparison.skipped.length) lines.push(pc.dim(`${comparison.skipped.map((p) => PLATFORM_LABEL[p]).join(", ")}: measured on one side only, not compared`));

  const shown = options.all ? comparison.changes : comparison.changes.filter((c) => biggest(c) >= threshold);
  lines.push("");
  if (comparison.changes.length === 0) lines.push("No size changes.");
  else if (shown.length === 0) lines.push(`No changes of ${formatBytes(threshold)} or more ${pc.dim(`(${comparison.changes.length} smaller; --all lists them)`)}.`);
  else {
    lines.push(pc.dim(`Why it changed (minified JS; ${comparison.platforms.map((p) => PLATFORM_LABEL[p]).join(" / ")})`));
    for (const change of shown) {
      const deltas = comparison.platforms.map((p) => (change.delta[p] === undefined ? "—" : colored(change.delta[p]!, threshold)));
      lines.push(`  ${deltas.join(pc.dim(" / "))}  ${describe(change, TERMINAL)}`);
    }
    const hidden = comparison.changes.length - shown.length;
    if (hidden > 0) lines.push(pc.dim(`  and ${hidden} smaller (--all lists them)`));
  }

  if (options.budgets.length) lines.push("", ...renderBudgets(options.budgets));
  return lines.join("\n");
}
