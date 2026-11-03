import type { BudgetResult } from "../compare/budgets.js";
import { biggest, type Change, type Comparison, type Totals } from "../compare/diff.js";
import { formatBytes } from "../core/format.js";
import { ICON, MARKDOWN, PLATFORM_LABEL, describe, describeBudget, signed } from "./describe.js";

/** Marks the bot's comment so the GitHub Action can find and update it. */
export const COMMENT_MARKER = "<!-- rn-sizewatch -->";

export interface MarkdownOptions {
  threshold: number;
  budgets: BudgetResult[];
  version: string;
  /** Rows shown before the collapsed list. */
  top?: number;
}

const escape = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ");

function sizeCell(base: number | undefined, head: number | undefined, threshold: number): string {
  if (head === undefined) return "—";
  const delta = head - (base ?? 0);
  if (base === undefined || delta === 0) return formatBytes(head);
  return `${formatBytes(head)} **${signed(delta)}**${delta >= threshold ? " 🔺" : ""}`;
}

function totalsTable(comparison: Comparison, threshold: number): string[] {
  const hasHermes = comparison.platforms.some((p) => comparison.totals[p]!.head.hermes !== undefined);
  const columns: { title: string; pick: (t: Totals) => number | undefined }[] = [
    { title: "JS bundle", pick: (t) => t.js },
    ...(hasHermes ? [{ title: "Hermes", pick: (t: Totals) => t.hermes }] : []),
    { title: "Assets", pick: (t) => t.assets },
    { title: "OTA download", pick: (t) => t.ota },
  ];
  return [
    `| | ${columns.map((c) => c.title).join(" | ")} |`,
    `|---|${columns.map(() => "---").join("|")}|`,
    ...comparison.platforms.map((platform) => {
      const { base, head } = comparison.totals[platform]!;
      return `| **${PLATFORM_LABEL[platform]}** | ${columns.map((c) => sizeCell(c.pick(base), c.pick(head), threshold)).join(" | ")} |`;
    }),
  ];
}

function changesTable(comparison: Comparison, changes: Change[]): string[] {
  return [
    `| | Change | ${comparison.platforms.map((p) => PLATFORM_LABEL[p]).join(" | ")} |`,
    `|---|---|${comparison.platforms.map(() => "---:").join("|")}|`,
    ...changes.map((change) => {
      const cells = comparison.platforms.map((p) => (change.delta[p] === undefined ? "—" : signed(change.delta[p]!)));
      return `| ${ICON[change.kind]} | ${escape(describe(change, MARKDOWN))} | ${cells.join(" | ")} |`;
    }),
  ];
}

function budgetLines(budgets: BudgetResult[]): string[] {
  if (budgets.length === 0) return [];
  const failed = budgets.filter((b) => !b.pass);
  if (failed.length === 0) return [`✅ ${budgets.length === 1 ? "The budget passes" : `All ${budgets.length} budgets pass`}.`, ""];
  if (failed.length === 1) return [`❌ **Budget:** ${describeBudget(failed[0]!)}.`, ""];
  return ["❌ **Budgets:**", ...failed.map((b) => `- ${describeBudget(b)}`), ""];
}

const short = (commit?: string) => (commit ? `\`${commit.slice(0, 7)}\`` : "unknown");

/** The pull request comment. */
export function renderMarkdown(comparison: Comparison, options: MarkdownOptions): string {
  const { threshold, top = 10 } = options;
  const notable = comparison.changes.filter((c) => biggest(c) >= threshold);
  const lines = [COMMENT_MARKER, "### 📦 rn-sizewatch", "", ...totalsTable(comparison, threshold), "", ...budgetLines(options.budgets)];

  if (comparison.changes.length === 0) {
    lines.push("No size changes.", "");
  } else {
    if (notable.length === 0) {
      lines.push(`No changes of ${formatBytes(threshold)} or more.`, "");
    } else {
      lines.push("**Why it changed** <sub>(measured on the minified JS; assets on their own)</sub>", "", ...changesTable(comparison, notable.slice(0, top)), "");
    }
    if (comparison.changes.length > Math.min(notable.length, top)) {
      lines.push(`<details><summary>All ${comparison.changes.length} changes</summary>`, "", ...changesTable(comparison, comparison.changes), "", "</details>", "");
    }
  }

  const { base, head } = comparison;
  const ref = (m: typeof base) => `${short(m.git?.commit)}${m.git?.branch ? ` (${m.git.branch})` : ""}`;
  const footer = [
    ...(base.git || head.git ? [`base ${ref(base)} · head ${ref(head)}`] : []),
    ...(comparison.skipped.length ? [`${comparison.skipped.map((p) => PLATFORM_LABEL[p]).join(", ")} measured on one side only`] : []),
    `rn-sizewatch ${options.version}`,
  ];
  lines.push(`<sub>${footer.join(" · ")}</sub>`);
  return `${lines.join("\n")}\n`;
}
