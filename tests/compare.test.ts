import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkBudgets } from "../src/compare/budgets.js";
import { compare, type Change } from "../src/compare/diff.js";
import { runCompare } from "../src/commands/compare.js";
import { parseConfig, parseSize } from "../src/core/config.js";
import type { Measurement } from "../src/core/types.js";
import { MARKDOWN, describe as describeChange } from "../src/render/describe.js";
import { COMMENT_MARKER, renderMarkdown } from "../src/render/markdown.js";
import { makeDir, measurement } from "./helpers.js";

const RN = { name: "react-native", version: "0.83.6", dir: "node_modules/react-native", bytes: 800_000, via: [] };
const byKind = (changes: Change[], kind: Change["kind"]) => changes.filter((c) => c.kind === kind);

describe("compare", () => {
  it("labels a new package with what pulls it in, and a removed one", () => {
    const base = measurement({ packages: [RN, { name: "moment", version: "2.30.1", dir: "node_modules/moment", bytes: 60_000, via: [] }] });
    const head = measurement({ packages: [RN, { name: "lodash", version: "4.17.21", dir: "node_modules/lodash", bytes: 73_000, via: ["my-utils"] }] });
    const { changes } = compare(base, head);
    expect(changes.map((c) => [c.kind, c.name, c.delta.ios, c.delta.android])).toEqual([
      ["added", "lodash", 73_000, 73_000],
      ["removed", "moment", -60_000, -60_000],
    ]);
    expect(describeChange(changes[0]!, MARKDOWN)).toBe("**lodash** 4.17.21: new, pulled in by `my-utils`");
    expect(describeChange(changes[1]!, MARKDOWN)).toBe("**moment** 2.30.1: removed");
  });

  it("says when a new package is one you added to package.json", () => {
    const head = measurement({ packages: [RN, { name: "zod", version: "4.1.0", dir: "node_modules/zod", bytes: 50_000, via: [] }] });
    expect(describeChange(compare(measurement({ packages: [RN] }), head).changes[0]!, MARKDOWN)).toBe("**zod** 4.1.0: new, in your package.json");
  });

  it("tells upgrades from downgrades, and counts the size change toward them", () => {
    const pkg = (version: string, bytes: number) => ({ name: "react-native-reanimated", version, dir: "node_modules/react-native-reanimated", bytes });
    const up = compare(measurement({ packages: [pkg("3.10.1", 100_000)] }), measurement({ packages: [pkg("3.16.0", 112_000)] })).changes;
    expect(up).toEqual([expect.objectContaining({ kind: "upgraded", from: "3.10.1", to: "3.16.0", delta: { ios: 12_000, android: 12_000 } })]);
    const down = compare(measurement({ packages: [pkg("3.16.0", 112_000)] }), measurement({ packages: [pkg("3.9.0", 100_000)] })).changes;
    expect(down[0]!.kind).toBe("downgraded");
    expect(describeChange(down[0]!, MARKDOWN)).toBe("**react-native-reanimated** 3.16.0 → 3.9.0 (downgrade)");
  });

  it("finds a second installed copy of a package and the dependency behind it", () => {
    const runtime = { name: "@babel/runtime", version: "7.29.10", dir: "node_modules/@babel/runtime", bytes: 9_000, via: [] };
    const nested = { name: "@babel/runtime", version: "7.20.0", dir: "node_modules/x/node_modules/@babel/runtime", bytes: 8_500, via: ["x"] };
    const base = measurement({ packages: [RN, runtime] });
    const head = measurement({ packages: [RN, runtime, nested] });
    const [dup] = compare(base, head).changes;
    expect(dup).toMatchObject({ kind: "duplicate", dirs: [nested.dir], versions: ["7.29.10", "7.20.0"], delta: { ios: 8_500 } });
    expect(describeChange(dup!, MARKDOWN)).toBe(
      "**@babel/runtime**: another copy installed at `node_modules/x/node_modules/@babel/runtime`, pulled in by `x`; versions now 7.29.10, 7.20.0",
    );
    // And the other way round.
    expect(compare(head, base).changes[0]).toMatchObject({ kind: "deduped", dirs: [nested.dir], delta: { ios: -8_500 } });
  });

  it("calls same-version growth 'more of it used', with how many files came in", () => {
    const lodash = (files: Record<string, number>) => ({ name: "lodash", version: "4.17.21", dir: "node_modules/lodash", bytes: Object.values(files).reduce((a, b) => a + b, 0), files });
    const base = measurement({ packages: [lodash({ "debounce.js": 1_000 })] });
    const head = measurement({ packages: [lodash({ "debounce.js": 1_000, "map.js": 2_000, "filter.js": 1_500 })] });
    const [change] = compare(base, head).changes;
    expect(change).toMatchObject({ kind: "grown", name: "lodash", delta: { ios: 3_500 } });
    expect(describeChange(change!, MARKDOWN)).toBe("**lodash** 4.17.21: more of it used (2 more files)");
    expect(compare(head, base).changes[0]!.kind).toBe("shrunk");
  });

  it("puts your code in one row, each data file in its own, and assets apart", () => {
    const base = measurement({ packages: [RN], app: { "src/Checkout.tsx": 3_000, "src/Old.tsx": 500 }, assets: { "img/a.png": 2_000 } });
    const head = measurement({
      packages: [RN],
      app: { "src/Checkout.tsx": 4_800, "src/New.tsx": 300 },
      data: { "src/countries.json": 41_000 },
      assets: { "img/a.png": 2_000, "img/logo.png": 282 },
    });
    const changes = compare(base, head).changes;
    expect(changes.map((c) => c.kind)).toEqual(["data", "app", "assets"]);
    expect(describeChange(byKind(changes, "data")[0]!, MARKDOWN)).toBe("**src/countries.json**: your data, added");
    expect(byKind(changes, "app")[0]).toMatchObject({ delta: { ios: 1_600 } });
    expect(describeChange(byKind(changes, "app")[0]!, MARKDOWN)).toBe("**Your code**: 3 files (`Checkout.tsx` +1.8 KB, `Old.tsx` removed, `New.tsx` +300 B)");
    expect(describeChange(byKind(changes, "assets")[0]!, MARKDOWN)).toBe("**Assets**: 1 added (`logo.png` +282 B)");
  });

  it("compares only the platforms both sides have, and reports nothing for identical builds", () => {
    const iosOnly = measurement({ packages: [RN] }, null);
    const both = measurement({ packages: [RN] });
    const result = compare(iosOnly, both);
    expect(result.platforms).toEqual(["ios"]);
    expect(result.skipped).toEqual(["android"]);
    expect(result.changes).toEqual([]);
    expect(() => compare({} as Measurement, both)).toThrow(/isn't a measure.json/);
  });

  it("keeps platform differences in one row", () => {
    const base = measurement({ packages: [RN] });
    const head = measurement(
      { packages: [RN, { name: "a", version: "1.0.0", dir: "node_modules/a", bytes: 5_000 }] },
      { packages: [RN, { name: "a", version: "1.0.0", dir: "node_modules/a", bytes: 5_200 }] },
    );
    expect(compare(base, head).changes).toEqual([expect.objectContaining({ kind: "added", delta: { ios: 5_000, android: 5_200 } })]);
  });
});

describe("config", () => {
  it("reads sizes the way people write them", () => {
    expect(parseSize("50 KB", "x")).toBe(50_000);
    expect(parseSize("1.5MB", "x")).toBe(1_500_000);
    expect(parseSize("2 KiB", "x")).toBe(2048);
    expect(parseSize(123, "x")).toBe(123);
    expect(() => parseSize("big", "budgets.js")).toThrow(/budgets.js should be a size/);
  });

  it("merges platform overrides over shared budgets and rejects unknown keys", () => {
    const config = parseConfig({ budgets: { hermes: "2 MB", increase: "5%", android: { hermes: "2.2 MB" } }, threshold: "500 B", platforms: ["android"] });
    expect(config.budgets).toEqual({
      ios: { hermes: 2_000_000, increase: { percent: 5 } },
      android: { hermes: 2_200_000, increase: { percent: 5 } },
    });
    expect(config.threshold).toBe(500);
    expect(config.platforms).toEqual(["android"]);
    expect(parseConfig({}).threshold).toBe(1000);
    expect(() => parseConfig({ budget: {} })).toThrow(/unknown option budget/);
    expect(() => parseConfig({ budgets: { size: "1 MB" } })).toThrow(/unknown budget size/);
    expect(() => parseConfig({ platforms: ["web"] })).toThrow(/platforms/);
  });
});

describe("budgets", () => {
  const base = measurement({ packages: [RN], hermes: 1_000_000 });
  const head = measurement({ packages: [RN], hermes: 1_080_000 });

  it("checks absolute sizes and the growth of the shipped size", () => {
    const config = parseConfig({ budgets: { hermes: "1.05 MB", js: "1 MB", increase: "5%", android: { hermes: "2 MB" } } });
    const results = checkBudgets(config, head, base);
    expect(results.map((r) => [r.platform, r.budget, r.pass])).toEqual([
      ["ios", "js", true],
      ["ios", "hermes", false],
      ["ios", "increase", false],
      ["android", "js", true],
      ["android", "hermes", true],
      ["android", "increase", false],
    ]);
    expect(results[2]).toMatchObject({ actual: 80_000, limit: 50_000, limitText: "5% (50 KB)" });
  });

  it("skips the increase budget without a base", () => {
    const results = checkBudgets(parseConfig({ budgets: { increase: "10 KB" } }), head);
    expect(results).toEqual([]);
  });
});

describe("markdown comment", () => {
  const base = measurement({ packages: [RN], hermes: 1_500_000 }, undefined, "1".repeat(40));
  const head = measurement(
    { packages: [RN, { name: "lodash", version: "4.17.21", dir: "node_modules/lodash", bytes: 73_000, via: ["my-utils"] }], app: { "App.tsx": 400 }, assets: { "logo.png": 282 }, hermes: 1_690_000 },
    undefined,
    "2".repeat(40),
  );

  it("shows totals, notable changes first, the rest collapsed, and the commits", () => {
    const comparison = compare(base, head);
    const config = parseConfig({ budgets: { hermes: "1.6 MB" } });
    const md = renderMarkdown(comparison, { threshold: 1000, budgets: checkBudgets(config, head, base), version: "0.1.0" });
    expect(md.startsWith(`${COMMENT_MARKER}\n### 📦 rn-sizewatch`)).toBe(true);
    expect(md).toContain("| | JS bundle | Hermes | Assets | OTA download |");
    expect(md).toContain("| **iOS** | 873 KB **+73 KB** 🔺 | 1.69 MB **+190 KB** 🔺 | 282 B **+282 B** | 563 KB **+63 KB** 🔺 |");
    expect(md).toContain("❌ **Budgets:**\n- iOS Hermes bytecode is 1.69 MB, over the 1.6 MB budget\n- Android Hermes bytecode is 1.69 MB, over the 1.6 MB budget\n");
    const one = parseConfig({ budgets: { ios: { hermes: "1.6 MB" } } });
    expect(renderMarkdown(comparison, { threshold: 1000, budgets: checkBudgets(one, head, base), version: "0" })).toContain("❌ **Budget:** iOS Hermes bytecode is 1.69 MB, over the 1.6 MB budget.");
    expect(md).toContain("| 🆕 | **lodash** 4.17.21: new, pulled in by `my-utils` | +73 KB | +73 KB |");
    // Under the 1 KB threshold: only in the collapsed list.
    const [notable, all] = md.split("<details>");
    expect(notable).not.toContain("Your code");
    expect(all).toContain("**Your code**: 1 file (`App.tsx` +400 B)");
    expect(md).toContain("<sub>base `1111111` (main) · head `2222222` (main) · rn-sizewatch 0.1.0</sub>");
  });

  it("calls an image's module an asset module, and leaves out commits when there's no git", () => {
    const noGit = (m: Measurement) => ({ ...m, git: undefined });
    const head2 = measurement({ packages: [RN], data: { "logo.png": 229 }, hermes: 1_500_000 });
    const md = renderMarkdown(compare(noGit(base), noGit(head2)), { threshold: 100, budgets: [], version: "0.1.0" });
    expect(md).toContain("**logo.png**: asset module, added");
    expect(md).toContain("<sub>rn-sizewatch 0.1.0</sub>");
  });

  it("says so when nothing changed", () => {
    const md = renderMarkdown(compare(base, base), { threshold: 1000, budgets: [], version: "0.1.0" });
    expect(md).toContain("No size changes.");
    expect(md).not.toContain("<details>");
  });

  it("escapes table pipes in names", () => {
    const head2 = measurement({ packages: [RN], data: { "a|b.json": 5_000 }, hermes: 1_500_000 });
    expect(renderMarkdown(compare(base, head2), { threshold: 1000, budgets: [], version: "0" })).toContain("**a\\|b.json**");
  });
});

describe("runCompare", () => {
  it("reads the files and the project's config, and fails on a broken budget", () => {
    const root = makeDir({ "sizewatch.config.json": { budgets: { increase: "10 KB" }, threshold: "2 KB" } });
    writeFileSync(join(root, "base.json"), JSON.stringify(measurement({ packages: [RN], hermes: 1_000_000 })));
    writeFileSync(join(root, "head.json"), JSON.stringify(measurement({ packages: [RN], hermes: 1_020_000 })));
    const result = runCompare("base.json", "head.json", { cwd: root }, "0.1.0");
    expect(result.threshold).toBe(2000);
    expect(result.failed).toBe(true);
    expect(() => runCompare("nope.json", "head.json", { cwd: root }, "0")).toThrow(/doesn't exist/);
  });
});
