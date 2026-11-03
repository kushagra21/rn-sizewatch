import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import pc from "picocolors";
import { DEFAULT_OUT, measureCommand } from "./commands/measure.js";
import { UserError } from "./core/exec.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("rn-sizewatch")
    .description("Measure a React Native app's release JS bundle, Hermes bytecode and assets, and where the bytes come from.")
    .version(version);

  program
    .command("measure")
    .description("Build the release bundle for each platform and measure it, by package and by file")
    .option("-C, --cwd <dir>", "the app's root folder", process.cwd())
    .addOption(new Option("-p, --platform <platform>", "which platform to bundle").choices(["ios", "android", "both"]).default("both"))
    .option("--entry <file>", "entry file, relative to the root (default: package.json main, then index.js/ts)")
    .option("-o, --out <dir>", `folder for the bundles and measure.json (default: ${DEFAULT_OUT})`)
    .option("--hermesc <path>", "the Hermes compiler to use (default: the one shipped with react-native)")
    .option("--no-hermes", "skip compiling to Hermes bytecode")
    .option("--reset-cache", "clear Metro's cache first")
    .option("--json", "print the measurement as JSON")
    .action((options) => measureCommand(options, version));

  return program;
}

const isMain = (() => {
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1] ?? "")).href;
  } catch {
    return false;
  }
})();

if (isMain) {
  buildProgram()
    .parseAsync()
    .catch((error: unknown) => {
      console.error(pc.red(error instanceof UserError ? error.message : String((error as Error)?.stack ?? error)));
      process.exitCode = 2;
    });
}
