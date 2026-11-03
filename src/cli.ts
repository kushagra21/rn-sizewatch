import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Command, Option } from "commander";
import pc from "picocolors";
import { ciPrepareCommand, ciRunCommand } from "./commands/ci.js";
import { checkCommand, compareCommand } from "./commands/compare.js";
import { doctorCommand } from "./commands/doctor.js";
import { DEFAULT_OUT, measureCommand } from "./commands/measure.js";
import { reportCommand } from "./commands/report.js";
import { CONFIG_FILE } from "./core/config.js";
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
    .addOption(new Option("-p, --platform <platform>", "which platform to bundle (default: platforms in sizewatch.config.json, else both)").choices(["ios", "android", "both"]))
    .option("--entry <file>", "entry file, relative to the root (default: package.json main, then index.js/ts)")
    .option("-o, --out <dir>", `folder for the bundles and measure.json (default: ${DEFAULT_OUT})`)
    .option("--hermesc <path>", "the Hermes compiler to use (default: the one shipped with react-native)")
    .option("--no-hermes", "skip compiling to Hermes bytecode")
    .option("--reset-cache", "clear Metro's cache first")
    .option("--json", "print the measurement as JSON")
    .action((options) => measureCommand(options, version));

  program
    .command("compare")
    .description("Show what changed between two measurements and why; exits with 1 when a budget fails")
    .argument("<base>", "measure.json of the base, e.g. main")
    .argument("<head>", "measure.json of the change")
    .option("-C, --cwd <dir>", `folder with ${CONFIG_FILE}`, process.cwd())
    .option("--markdown <file>", "also write the pull request comment to this file")
    .option("--threshold <size>", "smaller changes are listed only with --all (default: 1 KB, or threshold in the config)")
    .option("--all", "list every change, however small")
    .option("--json", "print the comparison as JSON")
    .action((base, head, options) => compareCommand(base, head, options, version));

  program
    .command("check")
    .description("Check a measurement against the budgets in sizewatch.config.json; exits with 1 when one fails")
    .argument("[measure.json]", `default: ${DEFAULT_OUT}/measure.json`)
    .option("-C, --cwd <dir>", `folder with ${CONFIG_FILE}`, process.cwd())
    .option("--base <measure.json>", "a base measurement, for the increase budget")
    .option("--json", "print the results as JSON")
    .action((file, options) => checkCommand(file, options));

  program
    .command("report")
    .description("Write an HTML report: a treemap of the bundle, packages, files, assets and suggestions")
    .argument("[measure.json]", `default: ${DEFAULT_OUT}/measure.json`)
    .option("-C, --cwd <dir>", "folder the paths are relative to", process.cwd())
    .option("--base <measure.json>", "a base measurement, to show what changed")
    .option("-o, --out <file>", `where to write it (default: ${DEFAULT_OUT}/report.html)`)
    .action((file, options) => reportCommand(file, options, version));

  program
    .command("doctor")
    .description("Check that rn-sizewatch can find the project, its bundler, Hermes and git")
    .option("-C, --cwd <dir>", "the app's root folder", process.cwd())
    .action(doctorCommand);

  const ci = program.command("ci").description("The steps of the GitHub Action (run inside GitHub Actions)");
  ci.command("prepare")
    .description("Decide whether to measure a baseline, compare a pull request or skip, and find the base measurement")
    .option("-C, --cwd <dir>", "the app's root folder", process.cwd())
    .option("--name <name>", "which app, when one repository measures several")
    .action(ciPrepareCommand);
  ci.command("run")
    .description("Measure; on a pull request also compare with the base, write the job summary and comment")
    .requiredOption("--mode <mode>", "baseline or pr")
    .requiredOption("--tmp <dir>", "scratch folder for the measurements")
    .option("-C, --cwd <dir>", "the app's root folder", process.cwd())
    .option("--platform <platform>", "ios, android or both")
    .option("--name <name>", "which app, when one repository measures several")
    .option("--base-sha <sha>", "the base commit")
    .option("--base-file <file>", "the base commit's downloaded measure.json")
    .option("--pr <number>", "the pull request")
    .option("--comment <bool>", "comment on the pull request", "true")
    .action((options) => ciRunCommand(options, version));

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
