import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { UserError } from "./exec.js";
import type { Platform, ProjectInfo } from "./types.js";

const readJson = (file: string): Record<string, any> => JSON.parse(readFileSync(file, "utf8"));

/** The folder of a package as Node would find it from `fromDir`, walking up through node_modules. */
export function findPackageDir(fromDir: string, name: string): string | undefined {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return candidate;
    if (dirname(dir) === dir) return undefined;
  }
}

const installedVersion = (root: string, name: string) => {
  const dir = findPackageDir(root, name);
  return dir ? (readJson(join(dir, "package.json")).version as string | undefined) : undefined;
};

const BARE_ENTRIES = ["index.js", "index.ts", "index.tsx", "index.jsx"];

function bareEntry(root: string, main: unknown): string {
  const candidates = [...(typeof main === "string" ? [main] : []), ...BARE_ENTRIES];
  const entry = candidates.find((file) => existsSync(join(root, file)));
  if (!entry) throw new UserError(`Couldn't find the app's entry file (looked for ${candidates.join(", ")}). Pass it with --entry.`);
  return entry;
}

/** Hermes is the default everywhere; this only looks for the documented ways of turning it off. */
function hermesEnabled(root: string, kind: ProjectInfo["kind"]): Record<Platform, boolean> {
  if (kind === "expo") {
    const appJson = join(root, "app.json");
    const expo = existsSync(appJson) ? (readJson(appJson).expo ?? {}) : {};
    const engine = (platform: Platform) => expo[platform]?.jsEngine ?? expo.jsEngine ?? "hermes";
    return { ios: engine("ios") === "hermes", android: engine("android") === "hermes" };
  }
  const read = (file: string) => (existsSync(join(root, file)) ? readFileSync(join(root, file), "utf8") : "");
  return {
    ios: !/:hermes_enabled\s*=>\s*false/.test(read("ios/Podfile")),
    android: !/^\s*hermesEnabled\s*=\s*false/m.test(read("android/gradle.properties")),
  };
}

export function detectProject(root: string, options: { entry?: string } = {}): ProjectInfo {
  const pkgFile = join(root, "package.json");
  if (!existsSync(pkgFile)) throw new UserError(`No package.json in ${root}. Run rn-sizewatch from your app's root folder, or pass --cwd.`);
  const pkg = readJson(pkgFile);
  const declared = { ...pkg.devDependencies, ...pkg.dependencies };

  const reactNative = installedVersion(root, "react-native");
  if (!reactNative) {
    throw new UserError("react-native" in declared ? "react-native isn't installed. Install your dependencies first." : `${pkgFile} doesn't depend on react-native.`);
  }
  const expo = "expo" in declared ? installedVersion(root, "expo") : undefined;
  if ("expo" in declared && !expo) throw new UserError("expo isn't installed. Install your dependencies first.");

  const kind = expo ? "expo" : "bare";
  if (options.entry && !existsSync(join(root, options.entry))) throw new UserError(`Entry file ${options.entry} doesn't exist.`);
  return {
    root,
    kind,
    reactNative,
    ...(expo ? { expo } : {}),
    entry: options.entry ?? (kind === "bare" ? bareEntry(root, pkg.main) : undefined),
    hermes: hermesEnabled(root, kind),
  };
}
