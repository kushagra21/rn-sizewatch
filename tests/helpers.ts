import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { ToolMissingError, type Exec, type ExecResult } from "../src/core/exec.js";
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

export const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", exitCode: 0 });
export const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1]!;

/** A machine where Metro writes a small bundle with one asset, hermesc writes bytecode, and git may be missing. */
export function fakeExec(options: { git?: boolean; metroFails?: boolean; other?: (file: string, args: string[], cwd?: string) => ExecResult | undefined } = {}): Exec & { calls: string[][] } {
  const calls: string[][] = [];
  const run = (async (file: string, args: string[], execOptions?: { cwd?: string }) => {
    calls.push([file, ...args]);
    const handled = options.other?.(file, args, execOptions?.cwd);
    if (handled) return handled;
    if (file === "git") {
      if (!options.git) throw new ToolMissingError("git");
      return ok(args.includes("--abbrev-ref") ? "feature/x\n" : "abc123\n");
    }
    if (file === process.execPath) {
      if (options.metroFails) return { stdout: "", stderr: "info Writing bundle\nerror Unable to resolve module ./missing", exitCode: 1 };
      const root = dirname(dirname(dirname(args[0]!)));
      const { code, map } = makeBundle(
        [
          { text: "__d(function(){var a=1},0,[]);", maps: [{ column: 15, source: `${root}/index.js` }] },
          { text: "__d(function(){var lodash=1},1,[]);", maps: [{ column: 15, source: `${root}/node_modules/lodash/index.js` }] },
        ],
        [`${root}/index.js`, `${root}/node_modules/lodash/index.js`],
      );
      writeFileSync(argAfter(args, "--bundle-output"), code);
      writeFileSync(argAfter(args, "--sourcemap-output"), JSON.stringify(map));
      mkdirSync(join(argAfter(args, "--assets-dest"), "img"), { recursive: true });
      writeFileSync(join(argAfter(args, "--assets-dest"), "img", "logo.png"), Buffer.alloc(1234));
      return ok();
    }
    if (file === "/fake/hermesc") {
      writeFileSync(argAfter(args, "-out"), Buffer.alloc(5000, 7));
      return ok();
    }
    throw new Error(`unexpected ${file}`);
  }) as Exec & { calls: string[][] };
  run.calls = calls;
  return run;
}

