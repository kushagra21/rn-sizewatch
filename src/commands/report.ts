import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import pc from "picocolors";
import { formatBytes } from "../core/format.js";
import type { Measurement } from "../core/types.js";
import { reportData } from "../report/data.js";
import { renderReport } from "../report/html.js";
import { readMeasurement } from "./compare.js";
import { DEFAULT_OUT } from "./measure.js";

export interface ReportOptions {
  cwd: string;
  base?: string;
  out?: string;
}

export function writeReport(head: Measurement, base: Measurement | undefined, file: string, version: string) {
  const data = reportData(head, base, version);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, renderReport(data));
  return data;
}

export function reportCommand(file: string | undefined, options: ReportOptions, version: string) {
  const root = resolve(options.cwd);
  const head = readMeasurement(resolve(root, file ?? join(DEFAULT_OUT, "measure.json")));
  const base = options.base ? readMeasurement(resolve(root, options.base)) : undefined;
  const out = resolve(root, options.out ?? join(DEFAULT_OUT, "report.html"));
  const data = writeReport(head, base, out, version);
  const rel = relative(process.cwd(), out);
  console.log(`Report written to ${rel && !rel.startsWith("..") ? rel : out}`);
  for (const hint of data.hints.slice(0, 5)) console.log(`${pc.yellow("💡")} ${hint.title} ${pc.dim(`(${formatBytes(hint.bytes)})`)}`);
  if (data.hints.length > 5) console.log(pc.dim(`   and ${data.hints.length - 5} more in the report`));
}
