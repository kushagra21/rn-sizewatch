import type { PlatformMeasurement, SourceKind, SourceSize } from "../core/types.js";

export type NodeKind = SourceKind | "root";

export interface TreeNode {
  name: string;
  bytes: number;
  kind: NodeKind;
  /** With a base: bytes gained (or lost) since it. */
  delta?: number;
  /** With a base: everything under this node is new. */
  isNew?: boolean;
  /** A short line under the name, like a package's version. */
  note?: string;
  children?: TreeNode[];
}

interface Entry {
  path: string;
  bytes: number;
  delta?: number;
  isNew?: boolean;
}

const bySize = (a: TreeNode, b: TreeNode) => b.bytes - a.bytes || a.name.localeCompare(b.name);

/** Nests files by folder; a folder with a single folder in it is shown as one, like src/screens. */
export function fileTree(entries: Entry[], kind: NodeKind): TreeNode[] {
  interface Folder {
    folders: Map<string, Folder>;
    files: TreeNode[];
  }
  const root: Folder = { folders: new Map(), files: [] };
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let folder = root;
    for (const part of parts.slice(0, -1)) {
      if (!folder.folders.has(part)) folder.folders.set(part, { folders: new Map(), files: [] });
      folder = folder.folders.get(part)!;
    }
    folder.files.push({ name: parts.at(-1)!, bytes: entry.bytes, kind, ...(entry.delta !== undefined ? { delta: entry.delta } : {}), ...(entry.isNew ? { isNew: true } : {}) });
  }

  const toNodes = (folder: Folder): TreeNode[] => {
    const nodes = [...folder.files];
    for (const [name, sub] of folder.folders) {
      let label = name;
      let current = sub;
      while (current.files.length === 0 && current.folders.size === 1) {
        const [nextName, next] = [...current.folders][0]!;
        label = `${label}/${nextName}`;
        current = next;
      }
      const children = toNodes(current);
      nodes.push(group(label, kind, children));
    }
    return nodes.sort(bySize);
  };
  return toNodes(root);
}

function group(name: string, kind: NodeKind, children: TreeNode[], note?: string): TreeNode {
  const node: TreeNode = { name, kind, bytes: children.reduce((sum, c) => sum + c.bytes, 0), children };
  if (children.some((c) => c.delta !== undefined)) node.delta = children.reduce((sum, c) => sum + (c.delta ?? 0), 0);
  if (children.length > 0 && children.every((c) => c.isNew)) node.isNew = true;
  if (note) node.note = note;
  return node;
}

/** The JS bundle as a tree: one node per installed package, then your code, your data and Metro's runtime. */
export function bundleTree(m: PlatformMeasurement, base?: PlatformMeasurement): TreeNode {
  const before = base ? new Map(base.sources.map((s) => [s.path, s.bytes])) : undefined;
  const entry = (source: SourceSize, path: string): Entry => {
    if (!before) return { path, bytes: source.bytes };
    const old = before.get(source.path);
    return { path, bytes: source.bytes, delta: source.bytes - (old ?? 0), ...(old === undefined ? { isNew: true } : {}) };
  };

  const copies = new Map<string, number>();
  for (const pkg of m.packages) copies.set(pkg.name, (copies.get(pkg.name) ?? 0) + 1);
  const children: TreeNode[] = m.packages.map((pkg) => {
    const files = m.sources.filter((s) => s.package === pkg.dir).map((s) => entry(s, s.path.slice(pkg.dir.length + 1)));
    const label = (copies.get(pkg.name) ?? 0) > 1 ? `${pkg.name} (${pkg.dir})` : pkg.name;
    // A package whose files all sit in one folder (often dist/ or lib/) opens straight onto them.
    let nodes = fileTree(files, "package");
    if (nodes.length === 1 && nodes[0]!.children) nodes = nodes[0]!.children;
    return group(label, "package", nodes, pkg.version);
  });

  for (const [kind, label] of [["app", "Your code"], ["data", "Your data"], ["runtime", "Metro runtime"]] as const) {
    const files = m.sources.filter((s) => s.kind === kind).map((s) => entry(s, s.path));
    if (files.length) children.push(group(label, kind, fileTree(files, kind)));
  }
  return group("JS bundle", "root", children.sort(bySize));
}
