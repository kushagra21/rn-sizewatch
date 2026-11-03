import { existsSync } from "node:fs";
import { join } from "node:path";
import { findPackageDir } from "../core/project.js";
import { UserError, tail, type Exec } from "../core/exec.js";

const BINARY: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "osx-bin/hermesc",
  linux: "linux64-bin/hermesc",
  win32: "win64-bin/hermesc.exe",
};

/**
 * The hermesc that ships with the project's React Native: the hermes-compiler package on newer
 * versions, react-native/sdks on older ones. An explicit path wins.
 */
export function findHermesc(root: string, explicit?: string): string | undefined {
  if (explicit) return explicit;
  const binary = BINARY[process.platform];
  if (!binary) return undefined;
  const compiler = findPackageDir(root, "hermes-compiler");
  const reactNative = findPackageDir(root, "react-native");
  const candidates = [compiler && join(compiler, "hermesc", binary), reactNative && join(reactNative, "sdks", "hermesc", binary)];
  return candidates.find((path): path is string => !!path && existsSync(path));
}

/** Compiles a bundle to bytecode the way a release build does (-O). */
export async function compileHermes(exec: Exec, hermesc: string, bundle: string, out: string) {
  const started = performance.now();
  const result = await exec(hermesc, ["-emit-binary", "-O", "-w", "-out", out, bundle], { timeoutMs: 5 * 60_000 });
  if (result.exitCode !== 0) throw new UserError(`hermesc failed:\n${tail(result.stderr || result.stdout)}`);
  return { ms: Math.round(performance.now() - started) };
}
