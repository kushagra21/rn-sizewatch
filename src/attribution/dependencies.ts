import { readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { findPackageDir } from "../core/project.js";

type Manifest = Record<string, Record<string, string> | undefined>;

const readManifest = (dir: string): Manifest | undefined => {
  try {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
};

const names = (manifest: Manifest, fields: string[]) => [...new Set(fields.flatMap((field) => Object.keys(manifest[field] ?? {})))];

/**
 * For each installed package reachable from the app's package.json, the shortest chain of package
 * names that brings it in, from one of the app's direct dependencies down to its parent; [] for a
 * direct dependency. Keys are package folders relative to the root through symlinks resolved, the
 * way source map paths are written (so pnpm's .pnpm folders match).
 */
export function dependencyChains(root: string): Map<string, string[]> {
  const chains = new Map<string, string[]>();
  const app = readManifest(root);
  if (!app) return chains;

  const realRoot = realpathSync(root);
  const key = (dir: string) => relative(realRoot, realpathSync(dir)).split(sep).join("/");
  // Breadth first, so the chain found first is the shortest; runtime dependencies before dev ones.
  const queue: { dir: string; chain: string[] }[] = [];
  const visit = (fromDir: string, name: string, chain: string[]) => {
    const dir = findPackageDir(fromDir, name);
    if (!dir) return;
    const id = key(dir);
    if (chains.has(id)) return;
    chains.set(id, chain);
    queue.push({ dir, chain: [...chain, name] });
  };

  for (const name of names(app, ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"])) visit(root, name, []);
  while (queue.length) {
    const { dir, chain } = queue.shift()!;
    const manifest = readManifest(dir);
    if (!manifest) continue;
    // A package's own node_modules comes first in resolution, so start from its folder.
    for (const name of names(manifest, ["dependencies", "optionalDependencies", "peerDependencies"])) visit(dir, name, chain);
  }
  return chains;
}
