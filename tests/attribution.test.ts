import { describe, expect, it } from "vitest";
import { attribute, classify, packageOf } from "../src/attribution/packages.js";
import { GENERATED, bytesBySource } from "../src/attribution/sourcemap.js";
import { makeBundle, makeDir } from "./helpers.js";

const ROOT = "/app";
const sum = (totals: Map<string, number>) => [...totals.values()].reduce((a, b) => a + b, 0);

describe("bytesBySource", () => {
  // __d(function(g,r){ … },0,[]);  with the body mapped to a source
  const wrap = (body: string, id: number) => `__d(function(g,r){${body}},${id},[]);`;
  const body = (text: string, source: string, id: number) => ({
    text: wrap(text, id),
    maps: [
      { column: "__d(function(g,r){".length, source },
      { column: "__d(function(g,r){".length + text.length, source: "" },
    ],
  });

  it("gives each module's wrapper and newline to the module, so totals equal the file size", () => {
    const { code, map } = makeBundle(
      [{ text: "var __BUNDLE_START_TIME__=0;" }, body("var a=1;", "/app/a.js", 0), body("var bb=2;", "/app/node_modules/b/index.js", 1), { text: "__r(0);" }],
      ["__prelude__", "/app/a.js", "/app/node_modules/b/index.js"],
    );
    const totals = bytesBySource(code, map);
    expect(sum(totals)).toBe(Buffer.byteLength(code));
    expect(totals.get("/app/a.js")).toBe(wrap("var a=1;", 0).length + 1);
    expect(totals.get("/app/node_modules/b/index.js")).toBe(wrap("var bb=2;", 1).length + 1);
    // The prelude line has no mappings but __prelude__ is first in the list; the startup call has nothing left.
    expect(totals.get("__prelude__")).toBe("var __BUNDLE_START_TIME__=0;".length + 1);
    expect(totals.get(GENERATED)).toBe("__r(0);".length);
  });

  it("finds modules Metro writes without mappings, like JSON, from the order of sources", () => {
    const json = wrap('m.exports={"x":1}', 1);
    const { code, map } = makeBundle(
      [body("var a=1;", "/app/a.js", 0), { text: json }, body("var c=3;", "/app/c.js", 2)],
      ["/app/a.js", "/app/data.json", "/app/c.js"],
    );
    const totals = bytesBySource(code, map);
    expect(totals.get("/app/data.json")).toBe(json.length + 1);
    expect(totals.has(GENERATED)).toBe(false);
  });

  it("splits a line that holds several sources at segment boundaries", () => {
    const { code, map } = makeBundle(
      [{ text: "aaaabbbbbbcc", maps: [{ column: 0, source: "/app/a.js" }, { column: 4, source: "/app/b.js" }, { column: 10, source: "" }] }],
      ["/app/a.js", "/app/b.js"],
    );
    const totals = bytesBySource(code, map);
    expect(totals.get("/app/a.js")).toBe(4);
    // b owns most of the line, so the unmapped tail is b's too.
    expect(totals.get("/app/b.js")).toBe(8);
  });

  it("counts bytes, not characters", () => {
    const { code, map } = makeBundle([{ text: 'x="é→"', maps: [{ column: 0, source: "/app/a.js" }] }], ["/app/a.js"]);
    expect(bytesBySource(code, map).get("/app/a.js")).toBe(Buffer.byteLength('x="é→"'));
  });
});

describe("packageOf", () => {
  it("names plain, scoped and nested packages by their last node_modules", () => {
    expect(packageOf("node_modules/lodash/debounce.js")).toEqual({ name: "lodash", dir: "node_modules/lodash" });
    expect(packageOf("node_modules/@react-native/js-polyfills/console.js")).toEqual({ name: "@react-native/js-polyfills", dir: "node_modules/@react-native/js-polyfills" });
    expect(packageOf("node_modules/a/node_modules/@s/b/x.js")).toEqual({ name: "@s/b", dir: "node_modules/a/node_modules/@s/b" });
    expect(packageOf("../../node_modules/react/index.js")).toEqual({ name: "react", dir: "../../node_modules/react" });
    expect(packageOf("src/App.tsx")).toBeUndefined();
  });
});

describe("classify", () => {
  it("tells your code from your data, packages and Metro's runtime", () => {
    expect(classify("/app/src/App.tsx", ROOT)).toEqual({ path: "src/App.tsx", kind: "app" });
    expect(classify("/app/countries.json", ROOT)).toEqual({ path: "countries.json", kind: "data" });
    expect(classify("/app/logo.png", ROOT)).toEqual({ path: "logo.png", kind: "data" });
    expect(classify("/app/node_modules/lodash/map.js", ROOT)).toEqual({ path: "node_modules/lodash/map.js", kind: "package", package: "node_modules/lodash" });
    expect(classify("__prelude__", ROOT)).toEqual({ path: "__prelude__", kind: "runtime" });
    expect(classify(GENERATED, ROOT)).toEqual({ path: "(Metro runtime)", kind: "runtime" });
  });
});

describe("attribute", () => {
  it("totals packages, keeps duplicate copies apart and reads their versions", () => {
    const root = makeDir({
      "node_modules/lodash/package.json": { version: "4.17.21" },
      "node_modules/a/node_modules/lodash/package.json": { version: "3.10.1" },
    });
    const bytes = new Map([
      [`${root}/node_modules/lodash/map.js`, 300],
      [`${root}/node_modules/lodash/filter.js`, 200],
      [`${root}/node_modules/a/node_modules/lodash/index.js`, 400],
      [`${root}/src/App.tsx`, 50],
      ["__prelude__", 10],
    ]);
    const { packages, breakdown, sources } = attribute(bytes, root);
    expect(packages).toEqual([
      { name: "lodash", dir: "node_modules/lodash", version: "4.17.21", bytes: 500, files: 2 },
      { name: "lodash", dir: "node_modules/a/node_modules/lodash", version: "3.10.1", bytes: 400, files: 1 },
    ]);
    expect(breakdown).toEqual({ app: 50, data: 0, package: 900, runtime: 10 });
    expect(sources[0]).toEqual({ path: "node_modules/a/node_modules/lodash/index.js", kind: "package", package: "node_modules/a/node_modules/lodash", bytes: 400 });
  });
});
