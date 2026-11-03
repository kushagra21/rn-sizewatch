import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { compare } from "../src/compare/diff.js";
import { hintsFor, introducedHints } from "../src/hints/rules.js";
import { reportData } from "../src/report/data.js";
import { renderReport } from "../src/report/html.js";
import { squarify } from "../src/report/squarify.js";
import { bundleTree, fileTree } from "../src/report/tree.js";
import { renderMarkdown } from "../src/render/markdown.js";
import { measurement, platform } from "./helpers.js";

const RN = { name: "react-native", version: "0.83.6", dir: "node_modules/react-native", bytes: 800_000, via: [] };
const keys = (m: ReturnType<typeof measurement>) => hintsFor(m).map((h) => h.key);

describe("hints", () => {
  it("finds duplicate copies and what removing the extra ones saves", () => {
    const m = measurement({
      packages: [
        { name: "@babel/runtime", version: "7.29.0", dir: "node_modules/@babel/runtime", bytes: 9_000 },
        { name: "@babel/runtime", version: "7.20.0", dir: "node_modules/x/node_modules/@babel/runtime", bytes: 8_000 },
      ],
    });
    const [hint] = hintsFor(m);
    expect(hint).toMatchObject({ key: "duplicate:@babel/runtime", title: "2 copies of @babel/runtime are bundled (7.29.0, 7.20.0)", bytes: 8_000 });
    expect(hint!.fix).toContain("`node_modules/x/node_modules/@babel/runtime`");
  });

  it("flags heavy packages only above their size, and whole-library entry files", () => {
    expect(keys(measurement({ packages: [{ name: "moment", version: "2.30.1", dir: "node_modules/moment", bytes: 60_000 }] }))).toEqual(["heavy:moment"]);
    expect(keys(measurement({ packages: [{ name: "moment", version: "2.30.1", dir: "node_modules/moment", bytes: 5_000 }] }))).toEqual([]);
    const whole = { name: "lodash", version: "4.17.21", dir: "node_modules/lodash", bytes: 70_000, files: { "lodash.js": 70_000 } };
    const perFunction = { name: "lodash", version: "4.17.21", dir: "node_modules/lodash", bytes: 21_000, files: { "debounce.js": 1_000, "cloneDeep.js": 20_000 } };
    expect(keys(measurement({ packages: [whole] }))).toEqual(["whole:lodash"]);
    expect(keys(measurement({ packages: [perFunction] }))).toEqual([]);
  });

  it("flags bundled locales, dev-only packages, large JSON and large images", () => {
    const locales = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`locale/l${i}.js`, 2_000]));
    const m = measurement(
      {
        packages: [
          { name: "moment", version: "2.30.1", dir: "node_modules/moment", bytes: 24_000, files: locales },
          { name: "@storybook/react-native", version: "9.0.0", dir: "node_modules/@storybook/react-native", bytes: 40_000 },
        ],
        data: { "src/big.json": 60_000, "src/small.json": 2_000 },
        assets: { "assets/photo.png": 300_000, "assets/icon.png": 4_000 },
      },
      // Android renames the same image.
      { packages: [RN], assets: { "drawable-mdpi/photo.png": 300_000 } },
    );
    expect(keys(m).sort()).toEqual(["data:src/big.json", "dev:@storybook/react-native", "heavy:moment", "image:photo", "locales:moment"].sort());
    expect(hintsFor(m)[0]!.key).toBe("image:photo");
  });

  it("tells the hints a change brings from ones that were already there", () => {
    const dup = (bytes: number) => [
      { name: "a", version: "1.0.0", dir: "node_modules/a", bytes: 5_000 },
      { name: "a", version: "2.0.0", dir: "node_modules/b/node_modules/a", bytes },
    ];
    const base = measurement({ packages: dup(4_000) });
    const head = measurement({ packages: [...dup(4_500), { name: "moment", version: "2.30.1", dir: "node_modules/moment", bytes: 300_000 }] });
    expect(introducedHints(base, head).map((h) => h.key)).toEqual(["heavy:moment"]);
  });
});

describe("squarify", () => {
  const area = (r: { w: number; h: number }) => r.w * r.h;

  it("gives each value an area in proportion, inside the rectangle", () => {
    const values = [500, 300, 120, 50, 20, 10];
    const rects = squarify(values, 10, 20, 400, 300);
    const total = values.reduce((a, b) => a + b);
    rects.forEach((r, i) => {
      expect(area(r)).toBeCloseTo((values[i]! / total) * 400 * 300, 6);
      expect(r.x).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(r.y).toBeGreaterThanOrEqual(20 - 1e-9);
      expect(r.x + r.w).toBeLessThanOrEqual(410 + 1e-9);
      expect(r.y + r.h).toBeLessThanOrEqual(320 + 1e-9);
    });
    expect(rects.reduce((sum, r) => sum + area(r), 0)).toBeCloseTo(400 * 300, 6);
  });

  it("keeps shapes close to square and skips empty values", () => {
    const rects = squarify([1, 1, 1, 1], 0, 0, 100, 100);
    for (const r of rects) expect(Math.max(r.w / r.h, r.h / r.w)).toBeCloseTo(1, 6);
    const withZero = squarify([10, 0, 5], 0, 0, 30, 10);
    expect(area(withZero[1]!)).toBe(0);
    expect(area(withZero[0]!) + area(withZero[2]!)).toBeCloseTo(300, 6);
    expect(squarify([], 0, 0, 10, 10)).toEqual([]);
  });
});

describe("tree", () => {
  it("nests files by folder and joins folders that hold only one folder", () => {
    const [src] = fileTree([{ path: "src/screens/Home.tsx", bytes: 300 }, { path: "src/screens/Cart.tsx", bytes: 200 }], "app");
    expect(src).toMatchObject({ name: "src/screens", bytes: 500, children: [{ name: "Home.tsx" }, { name: "Cart.tsx" }] });
  });

  it("opens a package straight onto its files, and marks what's new against a base", () => {
    const pkg = { name: "tiny", version: "1.0.0", dir: "node_modules/tiny", bytes: 300, files: { "dist/a.js": 200, "dist/b.js": 100 } };
    const tree = bundleTree(platform({ packages: [pkg], app: { "App.tsx": 50 } }), platform({ app: { "App.tsx": 40 } }));
    expect(tree.children!.map((c) => [c.name, c.bytes, c.delta, c.isNew ?? false])).toEqual([
      ["tiny", 300, 300, true],
      ["Your code", 50, 10, false],
    ]);
    expect(tree.children![0]!.children!.map((c) => c.name)).toEqual(["a.js", "b.js"]);
    expect(tree.children![0]!.note).toBe("1.0.0");
  });
});

describe("HTML report", () => {
  it("embeds the data so names can't close the script, and runs on its own", () => {
    const evil = "</script><img src=x onerror=alert(1)>";
    const head = measurement({ packages: [RN], app: { [`src/${evil}.tsx`]: 500 } });
    const html = renderReport(reportData(head, undefined, "0.1.0"));
    expect(html).not.toContain(evil);
    expect(html).toContain("\\u003c/script>");
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
    expect(html).toContain("var squarify = (function squarify(");
  });

  it("pins its only script and stylesheet with a content security policy that allows nothing else", () => {
    const html = renderReport(reportData(measurement({ packages: [RN] }), undefined, "0.1.0"));
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]!;
    const hash = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;
    const script = html.slice(html.lastIndexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(csp).toBe(`default-src 'none'; script-src ${hash(script)}; style-src ${hash(style)}; img-src data:; base-uri 'none'; form-action 'none'; object-src 'none'`);
    expect(html).not.toMatch(/\sstyle="/);
    expect(html).toContain('<meta name="referrer" content="no-referrer">');
  });

  it("lists packages, files and assets with their change, including what was removed", () => {
    const base = measurement({ packages: [RN, { name: "old", version: "1.0.0", dir: "node_modules/old", bytes: 3_000 }], assets: { "a.png": 100 } });
    const head = measurement({ packages: [{ ...RN, bytes: 801_000 }], assets: { "a.png": 100, "b.png": 50 } });
    const data = reportData(head, base, "0.1.0").platforms.ios!;
    expect(data.packages.map((p) => [p.name, p.status, p.delta])).toEqual([
      ["react-native", "changed", 1_000],
      ["old", "removed", -3_000],
    ]);
    expect(data.assets.map((a) => [a.path, a.status])).toEqual([["a.png", "same"], ["b.png", "new"]]);
    expect(data.totals.base?.js).toBe(803_000);
  });
});

describe("comment hints and report link", () => {
  it("lists up to three new hints and links the full report", () => {
    const base = measurement({ packages: [RN] });
    const head = measurement({ packages: [RN, { name: "moment", version: "2.30.1", dir: "node_modules/moment", bytes: 300_000 }] });
    const md = renderMarkdown(compare(base, head), { threshold: 1000, budgets: [], version: "0.1.0", hints: introducedHints(base, head), reportUrl: "https://github.com/me/app/actions/runs/1#artifacts" });
    expect(md).toContain("💡 **Worth a look** <sub>(new in this change)</sub>");
    expect(md).toContain("- **moment is in the bundle** (300 KB): `dayjs` has the same API");
    expect(md).toContain("[full report](https://github.com/me/app/actions/runs/1#artifacts)");
  });
});
