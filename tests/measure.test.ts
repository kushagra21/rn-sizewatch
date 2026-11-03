import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runMeasure, summary } from "../src/commands/measure.js";
import { bundleCommand, bundleFiles } from "../src/bundle/metro.js";
import { findHermesc } from "../src/bundle/hermes.js";
import { UserError } from "../src/core/exec.js";
import { detectProject } from "../src/core/project.js";
import { argAfter, bareApp, fakeExec, makeDir } from "./helpers.js";


describe("detectProject", () => {
  it("finds a bare app's entry and keeps Hermes on by default", () => {
    const root = bareApp();
    expect(detectProject(root)).toEqual({ root, name: "app", kind: "bare", reactNative: "0.83.6", entry: "index.js", hermes: { ios: true, android: true } });
  });

  it("prefers package.json main and notices Hermes turned off per platform", () => {
    const root = bareApp({
      "package.json": { main: "src/main.ts", dependencies: { "react-native": "0.83.6" } },
      "src/main.ts": "",
      "android/gradle.properties": "newArchEnabled=true\nhermesEnabled=false\n",
      "ios/Podfile": "use_react_native!(\n  :hermes_enabled => true\n)",
    });
    expect(detectProject(root)).toMatchObject({ entry: "src/main.ts", hermes: { ios: true, android: false } });
  });

  it("reads an Expo app's JS engine from app.json and lets Expo find the entry", () => {
    const root = makeDir({
      "package.json": { dependencies: { expo: "~55.0.0", "react-native": "0.83.6" } },
      "node_modules/react-native/package.json": { version: "0.83.6" },
      "node_modules/expo/package.json": { version: "55.0.3" },
      "app.json": { expo: { jsEngine: "hermes", ios: { jsEngine: "jsc" } } },
    });
    expect(detectProject(root)).toEqual({ root, kind: "expo", reactNative: "0.83.6", expo: "55.0.3", entry: undefined, hermes: { ios: false, android: true } });
  });

  it("explains what's missing", () => {
    expect(() => detectProject(makeDir({}))).toThrow(/No package.json/);
    expect(() => detectProject(makeDir({ "package.json": { dependencies: { "react-native": "0.83.6" } } }))).toThrow(/Install your dependencies/);
    expect(() => detectProject(makeDir({ "package.json": { dependencies: {} } }))).toThrow(/doesn't depend on react-native/);
    expect(() => detectProject(bareApp(), { entry: "nope.js" })).toThrow(UserError);
  });
});

describe("bundleCommand", () => {
  it("runs the project's own CLI with release flags", () => {
    const root = bareApp();
    const files = bundleFiles("/out/ios", "ios");
    const args = bundleCommand(detectProject(root), "ios", files, { resetCache: true });
    expect(args[0]).toBe(join(root, "node_modules/react-native/cli.js"));
    expect(args.slice(1)).toEqual([
      "bundle", "--platform", "ios", "--dev", "false", "--minify", "true",
      "--bundle-output", "/out/ios/main.jsbundle", "--sourcemap-output", "/out/ios/bundle.map", "--assets-dest", "/out/ios/assets",
      "--entry-file", "index.js", "--reset-cache",
    ]);
  });

  it("uses expo export:embed for Expo apps", () => {
    const root = makeDir({
      "package.json": { dependencies: { expo: "55", "react-native": "0.83.6" } },
      "node_modules/react-native/package.json": { version: "0.83.6" },
      "node_modules/expo/package.json": { version: "55.0.3" },
    });
    const args = bundleCommand(detectProject(root), "android", bundleFiles("/out/android", "android"));
    expect(args.slice(0, 2)).toEqual([join(root, "node_modules/expo/bin/cli"), "export:embed"]);
    expect(args).not.toContain("--entry-file");
    expect(argAfter(args, "--bundle-output")).toBe("/out/android/index.android.bundle");
  });
});

describe("findHermesc", () => {
  it("prefers the hermes-compiler package, then react-native/sdks", () => {
    const binary = { darwin: "osx-bin/hermesc", linux: "linux64-bin/hermesc", win32: "win64-bin/hermesc.exe" }[process.platform as string];
    if (!binary) return;
    const old = bareApp({ [`node_modules/react-native/sdks/hermesc/${binary}`]: "" });
    expect(findHermesc(old)).toBe(join(old, "node_modules/react-native/sdks/hermesc", binary));
    const current = bareApp({ [`node_modules/react-native/sdks/hermesc/${binary}`]: "", [`node_modules/hermes-compiler/hermesc/${binary}`]: "", "node_modules/hermes-compiler/package.json": {} });
    expect(findHermesc(current)).toBe(join(current, "node_modules/hermes-compiler/hermesc", binary));
    expect(findHermesc(bareApp())).toBeUndefined();
    expect(findHermesc(bareApp(), "/usr/bin/hermesc")).toBe("/usr/bin/hermesc");
  });
});

describe("runMeasure", () => {
  const app = () => bareApp({ "node_modules/lodash/package.json": { version: "4.17.21" } });

  it("measures both platforms, writes measure.json and leaves the bundles next to it", async () => {
    const root = app();
    const exec = fakeExec({ git: true });
    const { measurement, file } = await runMeasure({ cwd: root, platform: "both", hermesc: "/fake/hermesc" }, { version: "0.0.0", exec });

    expect(file).toBe(join(root, ".sizewatch/measure.json"));
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(measurement);
    expect(existsSync(join(root, ".sizewatch/ios/main.jsbundle"))).toBe(true);
    expect(existsSync(join(root, ".sizewatch/android/bundle.hbc"))).toBe(true);
    expect(measurement.git).toEqual({ commit: "abc123", branch: process.env.GITHUB_HEAD_REF || process.env.GITHUB_REF_NAME || "feature/x" });
    expect(measurement.project).toEqual({ name: "app", kind: "bare", reactNative: "0.83.6", entry: "index.js", hermes: { ios: true, android: true } });
    expect(JSON.stringify(measurement)).not.toContain(root);

    const ios = measurement.platforms.ios!;
    expect(ios.js.raw).toBe(readFileSync(join(root, ".sizewatch/ios/main.jsbundle")).length);
    expect(ios.hermes?.raw).toBe(5000);
    expect(ios.hermes!.gzip).toBeLessThan(5000);
    expect(ios.assets).toEqual({ bytes: 1234, count: 1, files: [{ path: "img/logo.png", bytes: 1234 }] });
    expect(ios.packages).toEqual([{ name: "lodash", version: "4.17.21", dir: "node_modules/lodash", bytes: 35, files: 1 }]);
    expect(ios.breakdown).toEqual({ app: 31, data: 0, package: 35, runtime: 0 });

    // Bundles run one after the other, never two Metro processes at once.
    expect(exec.calls.filter((c) => c[0] === process.execPath).map((c) => argAfter(c, "--platform"))).toEqual(["ios", "android"]);
    expect(summary(measurement)).toContain("lodash");
  });

  it("works without git and skips Hermes when asked", async () => {
    const { measurement } = await runMeasure({ cwd: app(), platform: "android", hermes: false }, { version: "0.0.0", exec: fakeExec() });
    expect(measurement.git).toBeUndefined();
    expect(Object.keys(measurement.platforms)).toEqual(["android"]);
    expect(measurement.platforms.android!.hermes).toBeUndefined();
  });

  it("warns and carries on when Hermes is on but hermesc can't be found", async () => {
    const warnings: string[] = [];
    const { measurement } = await runMeasure({ cwd: app(), platform: "ios" }, { version: "0.0.0", exec: fakeExec(), warn: (m) => warnings.push(m) });
    expect(measurement.platforms.ios!.hermes).toBeUndefined();
    expect(warnings[0]).toMatch(/hermesc wasn't found/);
  });

  it("shows the end of Metro's output when bundling fails", async () => {
    await expect(runMeasure({ cwd: app(), platform: "ios" }, { version: "0.0.0", exec: fakeExec({ metroFails: true }) })).rejects.toThrow(
      /react-native bundle failed for ios:[\s\S]*Unable to resolve module/,
    );
  });
});
