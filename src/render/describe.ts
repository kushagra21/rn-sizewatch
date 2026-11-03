import pc from "picocolors";
import type { BudgetResult } from "../compare/budgets.js";
import type { Change, ChangeKind, FileDelta } from "../compare/diff.js";
import { formatBytes } from "../core/format.js";
import type { Platform } from "../core/types.js";

/** How emphasis looks in each output. */
export interface Style {
  bold: (text: string) => string;
  code: (text: string) => string;
}

export const MARKDOWN: Style = { bold: (t) => `**${t}**`, code: (t) => `\`${t.replaceAll("`", "")}\`` };
export const TERMINAL: Style = { bold: pc.bold, code: pc.cyan };

export const PLATFORM_LABEL: Record<Platform, string> = { ios: "iOS", android: "Android" };

export const ICON: Record<ChangeKind, string> = {
  added: "🆕",
  removed: "🗑️",
  upgraded: "⬆️",
  downgraded: "⬇️",
  duplicate: "⚠️",
  deduped: "♻️",
  grown: "📈",
  shrunk: "📉",
  app: "✏️",
  data: "📄",
  assets: "🖼️",
  runtime: "⚙️",
};

export const signed = (bytes: number) => (bytes > 0 ? `+${formatBytes(bytes)}` : bytes < 0 ? `−${formatBytes(-bytes)}` : "±0");

const baseName = (path: string) => path.split("/").at(-1) ?? path;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function via(change: Change, s: Style): string {
  if (!change.via) return "";
  if (change.via.length === 0) return ", in your package.json";
  return `, pulled in by ${change.via.map(s.code).join(" → ")}`;
}

/** The first few files, e.g. `Checkout.tsx` +1.8 KB, `Cart.tsx` −200 B and 2 more. */
function fileList(files: FileDelta[], s: Style, shown = 3): string {
  const listed = files.slice(0, shown).map((f) => `${s.code(baseName(f.path))} ${f.status === "removed" ? "removed" : signed(f.delta)}`);
  return files.length > shown ? `${listed.join(", ")} and ${files.length - shown} more` : listed.join(", ");
}

function counts(files: FileDelta[]): string {
  const by = (status: FileDelta["status"]) => files.filter((f) => f.status === status).length;
  return [
    by("added") && `${by("added")} added`,
    by("removed") && `${by("removed")} removed`,
    by("changed") && `${by("changed")} changed`,
  ]
    .filter(Boolean)
    .join(", ");
}

/** One line saying what changed and why, without the sizes. */
export function describe(change: Change, s: Style): string {
  const version = (v?: string) => (v ? ` ${v}` : "");
  switch (change.kind) {
    case "added":
      return `${s.bold(change.name)}${version(change.to)}: new${via(change, s)}`;
    case "removed":
      return `${s.bold(change.name)}${version(change.from)}: removed`;
    case "upgraded":
    case "downgraded":
      return `${s.bold(change.name)} ${change.from} → ${change.to}${change.kind === "downgraded" ? " (downgrade)" : ""}`;
    case "duplicate":
      return `${s.bold(change.name)}: another copy installed at ${change.dirs!.map(s.code).join(", ")}${via(change, s)}; versions now ${change.versions!.join(", ")}`;
    case "deduped":
      return `${s.bold(change.name)}: a duplicate copy is gone (${change.dirs!.map(s.code).join(", ")})`;
    case "grown":
    case "shrunk": {
      const files = change.files ?? [];
      const added = files.filter((f) => f.status === "added").length;
      const removed = files.filter((f) => f.status === "removed").length;
      const detail = [added && `${plural(added, "more file")}`, removed && `${plural(removed, "file")} fewer`].filter(Boolean).join(", ");
      return `${s.bold(change.name)}${version(change.to)}: ${change.kind === "grown" ? "more" : "less"} of it used${detail ? ` (${detail})` : ""}`;
    }
    case "app":
      return `${s.bold("Your code")}: ${plural(change.files?.length ?? 0, "file")} ${change.files?.length ? `(${fileList(change.files, s)})` : "changed"}`;
    case "data": {
      const file = change.files![0]!;
      // Metro writes a small JS module for each image or font that registers the file; the file itself is in Assets.
      const what = /\.json$/i.test(change.name) ? "your data" : "asset module";
      return `${s.bold(change.name)}: ${what}, ${file.status}`;
    }
    case "assets":
      return `${s.bold("Assets")}: ${counts(change.files ?? []) || "changed"}${change.files?.length ? ` (${fileList(change.files, s)})` : ""}`;
    case "runtime":
      return `${s.bold("Metro runtime")}`;
  }
}

const BUDGET_LABEL: Record<BudgetResult["budget"], string> = { js: "JS bundle", hermes: "Hermes bytecode", assets: "assets", increase: "growth" };

export function describeBudget(result: BudgetResult): string {
  const platform = PLATFORM_LABEL[result.platform];
  if (result.budget === "increase") {
    return `${platform} grew ${signed(result.actual)}, ${result.pass ? "within" : "over"} the ${result.limitText} increase budget`;
  }
  return `${platform} ${BUDGET_LABEL[result.budget]} is ${formatBytes(result.actual)}, ${result.pass ? "within" : "over"} the ${result.limitText} budget`;
}
