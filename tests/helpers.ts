import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SourceMapInput } from "@jridgewell/trace-mapping";
import { addMapping, setSourceContent, toEncodedMap, GenMapping } from "@jridgewell/gen-mapping";

/** A temporary folder with the given files; values that aren't strings are written as JSON. */
export function makeDir(files: Record<string, unknown>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "rn-sizewatch-")));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  }
  return root;
}

export const bareApp = (extra: Record<string, unknown> = {}) =>
  makeDir({
    "package.json": { name: "app", dependencies: { "react-native": "0.83.6" } },
    "node_modules/react-native/package.json": { name: "react-native", version: "0.83.6" },
    "index.js": "",
    ...extra,
  });

/**
 * Line i of a bundle: `text` is the whole line; `maps` gives the parts of it that map to a source
 * (by column), the rest is unmapped. A line with no maps has no mappings at all.
 */
export interface Line {
  text: string;
  maps?: { column: number; source: string }[];
}

/** A Metro-style bundle and its source map; `sources` sets the order sources are listed in. */
export function makeBundle(lines: Line[], sources: string[]) {
  const map = new GenMapping({ file: "main.jsbundle" });
  for (const source of sources) setSourceContent(map, source, "");
  lines.forEach((line, i) => {
    for (const part of line.maps ?? []) {
      // A segment without a source ends the previous one; a source segment starts a new part.
      if (part.source === "") addMapping(map, { generated: { line: i + 1, column: part.column } });
      else addMapping(map, { generated: { line: i + 1, column: part.column }, source: part.source, original: { line: 1, column: 0 } });
    }
  });
  return { code: lines.map((l) => l.text).join("\n"), map: toEncodedMap(map) as unknown as SourceMapInput };
}
