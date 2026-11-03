import { createHash } from "node:crypto";
import type { ReportData } from "./data.js";
import { squarify } from "./squarify.js";

/** JSON that is safe inside a <script> element. */
const embed = (data: unknown) =>
  JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");

const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const STYLE = `
:root {
  --bg: #f7f7f8; --surface: #ffffff; --text: #18181b; --muted: #63636b; --border: #e2e2e6;
  --accent: #2f6fdf; --grow: #c93a3a; --shrink: #1f8a4c; --new: #a1580c;
  --package: #3d78d8; --app: #7d55c7; --data: #c28a12; --runtime: #7a7f87;
  --cell-text: #ffffff; --focus: #2f6fdf;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #111114; --surface: #1b1b20; --text: #ececf0; --muted: #a0a0aa; --border: #2e2e36;
    --accent: #6d9cf0; --grow: #f07070; --shrink: #4cc283; --new: #e3a04f;
    --package: #3a6cc0; --app: #6b49ad; --data: #a8780f; --runtime: #5f646c;
  }
}
:root[data-theme="dark"] {
  --bg: #111114; --surface: #1b1b20; --text: #ececf0; --muted: #a0a0aa; --border: #2e2e36;
  --accent: #6d9cf0; --grow: #f07070; --shrink: #4cc283; --new: #e3a04f;
  --package: #3a6cc0; --app: #6b49ad; --data: #a8780f; --runtime: #5f646c;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
main { max-width: 1200px; margin: 0 auto; padding: 20px 16px 48px; }
header { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 16px; }
h1 { font-size: 20px; margin: 0; }
h2 { font-size: 15px; margin: 0 0 10px; }
.sub { color: var(--muted); font-size: 13px; }
code { font: 12.5px ui-monospace, SFMono-Regular, Menlo, monospace; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 0 4px; }
.seg { display: inline-flex; border: 1px solid var(--border); border-radius: 8px; overflow: hidden; background: var(--surface); }
.seg button { border: 0; background: none; color: var(--text); padding: 6px 12px; font: inherit; cursor: pointer; }
.seg button[aria-pressed="true"] { background: var(--accent); color: #fff; }
button:focus-visible, input:focus-visible, .cell:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }
.cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px; }
@media (max-width: 640px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } #map { height: 420px; } }
.card, section { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; }
.card { padding: 12px 14px; }
.card .label { color: var(--muted); font-size: 12px; }
.card .value { font-size: 20px; font-weight: 600; margin-top: 2px; }
.card .delta { font-size: 13px; margin-top: 2px; }
.up { color: var(--grow); } .down { color: var(--shrink); } .isnew { color: var(--new); }
section { padding: 14px; margin-bottom: 16px; }
.hints { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.hints li { border-left: 3px solid var(--data); padding: 2px 0 2px 10px; }
.hints .title { font-weight: 600; }
.hints .badge { font-size: 11px; color: var(--new); border: 1px solid var(--new); border-radius: 999px; padding: 0 6px; margin-left: 6px; }
.hints .fix { color: var(--muted); margin-top: 2px; }
.toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 10px; }
.crumbs { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; min-width: 0; margin-bottom: 8px; }
.flush { margin: 0; }
.padded { padding: 16px; }
.crumbs button { border: 0; background: none; color: var(--accent); font: inherit; padding: 2px 4px; cursor: pointer; border-radius: 4px; }
.crumbs button:disabled { color: var(--text); cursor: default; font-weight: 600; }
.crumbs .sep { color: var(--muted); }
#map { position: relative; height: min(62vh, 560px); min-height: 300px; border-radius: 8px; overflow: hidden; background: var(--bg); }
.cell { position: absolute; overflow: hidden; border: 1px solid var(--surface); border-radius: 3px; color: var(--cell-text); cursor: pointer; padding: 3px 5px; font-size: 12px; line-height: 1.25; }
.cell.leaf { cursor: default; }
.cell .name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.cell .size { opacity: .85; white-space: nowrap; }
.cell.newnode { outline: 2px dashed var(--new); outline-offset: -3px; }
.inner { position: absolute; border: 1px solid rgba(255,255,255,.25); border-radius: 2px; pointer-events: none; }
#tip { position: fixed; z-index: 10; pointer-events: none; background: var(--surface); color: var(--text); border: 1px solid var(--border); border-radius: 8px; padding: 8px 10px; font-size: 12.5px; box-shadow: 0 6px 20px rgba(0,0,0,.18); max-width: 320px; display: none; }
#tip .t { font-weight: 600; word-break: break-all; }
.legend { display: flex; flex-wrap: wrap; gap: 12px; color: var(--muted); font-size: 12px; margin-top: 8px; }
.legend i { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 5px; vertical-align: -1px; }
.tabs { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; justify-content: space-between; margin-bottom: 10px; }
input[type=search] { font: inherit; color: var(--text); background: var(--bg); border: 1px solid var(--border); border-radius: 8px; padding: 6px 10px; min-width: 0; width: 220px; max-width: 100%; }
.tablewrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 7px 8px; border-bottom: 1px solid var(--border); white-space: nowrap; }
td.wrap { white-space: normal; word-break: break-word; min-width: 180px; }
th { color: var(--muted); font-weight: 600; cursor: pointer; user-select: none; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
th[aria-sort="descending"]::after { content: " ↓"; } th[aria-sort="ascending"]::after { content: " ↑"; }
.empty { color: var(--muted); padding: 10px 0; }
footer { color: var(--muted); font-size: 12px; text-align: center; }
`;

/** Runs in the browser; `squarify` is defined next to it from the same source the tests use. */
const SCRIPT = `
var data = JSON.parse(document.getElementById("data").textContent);
var platforms = Object.keys(data.platforms);
var state = { platform: platforms[0], path: [], mode: data.base ? "change" : "size", tab: "packages", sort: { key: "bytes", dir: -1 }, filter: "" };
var LABEL = { ios: "iOS", android: "Android" };
var KIND = { package: "Package", app: "Your code", data: "Your data", runtime: "Metro runtime", root: "" };

function $(id) { return document.getElementById(id); }
function el(tag, attrs, text) {
  var node = document.createElement(tag);
  for (var k in attrs || {}) { if (k === "class") node.className = attrs[k]; else node.setAttribute(k, attrs[k]); }
  if (text !== undefined) node.textContent = text;
  return node;
}
function trim(v, d) { return String(Number(v.toFixed(d))); }
function fmt(b) { var a = Math.abs(b); if (a < 1000) return b + " B"; if (a < 1e6) return trim(b / 1000, a < 1e4 ? 1 : 0) + " KB"; return trim(b / 1e6, 2) + " MB"; }
function signed(b) { return b > 0 ? "+" + fmt(b) : b < 0 ? "\\u2212" + fmt(-b) : "\\u00b10"; }
function pct(part, whole) { return whole ? (part / whole * 100).toFixed(part / whole < 0.1 ? 1 : 0) + "%" : ""; }
function current() { return data.platforms[state.platform]; }

function renderPlatforms() {
  var seg = $("platforms"); seg.textContent = "";
  platforms.forEach(function (p) {
    var b = el("button", { type: "button", "aria-pressed": String(p === state.platform) }, LABEL[p] || p);
    b.onclick = function () { state.platform = p; state.path = []; renderAll(); };
    seg.appendChild(b);
  });
  seg.hidden = platforms.length < 2;
}

function renderCards() {
  var t = current().totals, box = $("cards"); box.textContent = "";
  var cards = [["JS bundle", "js"], ["Hermes bytecode", "hermes"], ["Assets", "assets"], ["OTA download", "ota"]];
  cards.forEach(function (c) {
    var v = t.head[c[1]]; if (v === undefined) return;
    var card = el("div", { class: "card" });
    card.appendChild(el("div", { class: "label" }, c[0]));
    card.appendChild(el("div", { class: "value" }, fmt(v)));
    if (t.base && t.base[c[1]] !== undefined) {
      var d = v - t.base[c[1]];
      card.appendChild(el("div", { class: "delta " + (d > 0 ? "up" : d < 0 ? "down" : "") }, d === 0 ? "no change" : signed(d) + " vs base"));
    }
    box.appendChild(card);
  });
}

function renderHints() {
  var list = $("hints"); list.textContent = "";
  $("hintcount").textContent = data.hints.length ? "(" + data.hints.length + ")" : "";
  if (!data.hints.length) { list.appendChild(el("li", { class: "empty" }, "Nothing stands out: no duplicate copies, whole-library imports, heavy packages with lighter options, dev-only code or oversized data and images.")); return; }
  data.hints.forEach(function (h) {
    var li = el("li");
    var title = el("div", { class: "title" }, h.title + " \\u00b7 " + fmt(h.bytes));
    if (data.introduced.indexOf(h.key) !== -1) title.appendChild(el("span", { class: "badge" }, "new in this change"));
    li.appendChild(title);
    var fix = el("div", { class: "fix" });
    h.fix.split("\`").forEach(function (part, i) { fix.appendChild(i % 2 ? el("code", {}, part) : document.createTextNode(part)); });
    li.appendChild(fix);
    list.appendChild(li);
  });
}

function nodeAt(path) { var n = current().tree; path.forEach(function (i) { n = n.children[i]; }); return n; }

function color(node, maxAbs) {
  if (state.mode === "change" && data.base) {
    var d = node.delta || 0;
    if (d === 0 || !maxAbs) return "var(--runtime)";
    var share = Math.min(1, Math.abs(d) / maxAbs);
    // Square root, so mid-sized changes show clearly while a few bytes stay close to grey.
    return "color-mix(in srgb, " + (d > 0 ? "var(--grow)" : "var(--shrink)") + " " + Math.round(Math.sqrt(share) * 100) + "%, var(--runtime))";
  }
  return "var(--" + (node.kind === "root" ? "package" : node.kind) + ")";
}

function renderMap() {
  var map = $("map"), tip = $("tip"), node = nodeAt(state.path);
  map.textContent = "";
  var crumbs = $("crumbs"); crumbs.textContent = "";
  var trail = [current().tree]; state.path.forEach(function (_, i) { trail.push(nodeAt(state.path.slice(0, i + 1))); });
  trail.forEach(function (n, i) {
    if (i) crumbs.appendChild(el("span", { class: "sep" }, "\\u203a"));
    var b = el("button", { type: "button" }, (i ? n.name : "All") + " \\u00b7 " + fmt(n.bytes));
    b.disabled = i === trail.length - 1;
    b.onclick = function () { state.path = state.path.slice(0, i); renderMap(); };
    crumbs.appendChild(b);
  });

  var kids = (node.children || []).filter(function (c) { return c.bytes > 0; });
  var W = map.clientWidth, H = map.clientHeight;
  var rects = squarify(kids.map(function (c) { return c.bytes; }), 0, 0, W, H);
  var maxAbs = 0; kids.forEach(function (c) { (c.children || [c]).forEach(function (g) { maxAbs = Math.max(maxAbs, Math.abs(g.delta || 0)); }); maxAbs = Math.max(maxAbs, Math.abs(c.delta || 0)); });

  kids.forEach(function (child, i) {
    var r = rects[i]; if (r.w < 1 || r.h < 1) return;
    var hasKids = child.children && child.children.length > 0;
    var cell = el("div", { class: "cell" + (hasKids ? "" : " leaf") + (child.isNew && state.mode === "change" ? " newnode" : ""), role: hasKids ? "button" : "img", tabindex: hasKids ? "0" : "-1", "aria-label": child.name + ", " + fmt(child.bytes) });
    cell.style.cssText = "left:" + r.x + "px;top:" + r.y + "px;width:" + r.w + "px;height:" + r.h + "px;background:" + color(child, maxAbs);
    if (r.w > 54 && r.h > 30) {
      cell.appendChild(el("div", { class: "name" }, child.name));
      var line = fmt(child.bytes) + (state.mode === "change" && child.delta ? " \\u00b7 " + signed(child.delta) : "");
      cell.appendChild(el("div", { class: "size" }, line));
    }
    // One level deeper, drawn inside without labels, to show what each block is made of.
    if (hasKids && r.w > 60 && r.h > 60) {
      var gk = child.children.filter(function (g) { return g.bytes > 0; });
      var top = 34, inner = squarify(gk.map(function (g) { return g.bytes; }), 3, top, r.w - 8, r.h - top - 4);
      gk.forEach(function (g, j) {
        var q = inner[j]; if (q.w < 3 || q.h < 3) return;
        var box = el("div", { class: "inner" });
        box.style.cssText = "left:" + q.x + "px;top:" + q.y + "px;width:" + q.w + "px;height:" + q.h + "px;background:" + (state.mode === "change" && data.base ? color(g, maxAbs) : "rgba(255,255,255," + (0.06 + (j % 3) * 0.05) + ")");
        cell.appendChild(box);
      });
    }
    function zoom() { if (hasKids) { state.path = state.path.concat([node.children.indexOf(child)]); renderMap(); } }
    cell.onclick = zoom;
    cell.onkeydown = function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); zoom(); } };
    cell.onmousemove = function (e) {
      tip.textContent = "";
      tip.appendChild(el("div", { class: "t" }, child.name));
      var bits = [fmt(child.bytes) + " \\u00b7 " + pct(child.bytes, node.bytes) + " of " + (state.path.length ? node.name : "the bundle")];
      if (child.note) bits.push(child.note);
      if (KIND[child.kind] && state.path.length === 0) bits.push(KIND[child.kind]);
      if (data.base) bits.push(child.isNew ? "new" : child.delta ? signed(child.delta) + " vs base" : "unchanged");
      if (hasKids) bits.push("click to open");
      bits.forEach(function (b) { tip.appendChild(el("div", {}, b)); });
      tip.style.display = "block";
      var x = Math.min(e.clientX + 14, window.innerWidth - tip.offsetWidth - 8), y = Math.min(e.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
      tip.style.left = x + "px"; tip.style.top = y + "px";
    };
    cell.onmouseleave = function () { tip.style.display = "none"; };
    map.appendChild(cell);
  });
  if (!kids.length) map.appendChild(el("div", { class: "empty padded" }, "Nothing to show here."));

  var legend = $("legend"); legend.textContent = "";
  var items = state.mode === "change" && data.base ? [["var(--grow)", "grew"], ["var(--shrink)", "shrank"], ["var(--runtime)", "unchanged"]] : [["var(--package)", "packages"], ["var(--app)", "your code"], ["var(--data)", "your data"], ["var(--runtime)", "Metro runtime"]];
  items.forEach(function (it) { var s = el("span"); var i = el("i"); i.style.background = it[0]; s.appendChild(i); s.appendChild(document.createTextNode(it[1])); legend.appendChild(s); });
  if (state.mode === "change" && data.base) { var s = el("span", {}, "dashed outline: new"); legend.appendChild(s); }
}

function renderModes() {
  var seg = $("modes"); seg.textContent = ""; seg.hidden = !data.base;
  [["size", "Size"], ["change", "Change"]].forEach(function (m) {
    var b = el("button", { type: "button", "aria-pressed": String(state.mode === m[0]) }, m[1]);
    b.onclick = function () { state.mode = m[0]; renderMap(); renderModes(); };
    seg.appendChild(b);
  });
}

var COLUMNS = {
  packages: [["name", "Package"], ["version", "Version"], ["bytes", "Size", 1], ["delta", "Change", 1], ["files", "Files", 1], ["via", "Pulled in by"]],
  files: [["path", "File"], ["bytes", "Size", 1], ["delta", "Change", 1], ["kind", "Kind"]],
  assets: [["path", "Asset"], ["bytes", "Size", 1], ["delta", "Change", 1]]
};

function renderTabs() {
  var seg = $("tabs"); seg.textContent = "";
  [["packages", "Packages"], ["files", "Your files"], ["assets", "Assets"]].forEach(function (t) {
    var count = current()[t[0]].filter(function (r) { return r.status !== "removed"; }).length;
    var b = el("button", { type: "button", "aria-pressed": String(state.tab === t[0]) }, t[1] + " (" + count + ")");
    b.onclick = function () { state.tab = t[0]; state.sort = { key: "bytes", dir: -1 }; renderTabs(); renderTable(); };
    seg.appendChild(b);
  });
}

function cellValue(row, key) {
  if (key === "via") return row.via ? (row.via.length ? row.via.join(" \\u203a ") : "your package.json") : "";
  return row[key];
}

function renderTable() {
  var cols = COLUMNS[state.tab].filter(function (c) { return c[0] !== "delta" || data.base; });
  var table = $("table"); table.textContent = "";
  var head = el("tr");
  cols.forEach(function (c) {
    var th = el("th", { class: c[2] ? "num" : "", scope: "col" }, c[1]);
    if (state.sort.key === c[0]) th.setAttribute("aria-sort", state.sort.dir < 0 ? "descending" : "ascending");
    th.onclick = function () { state.sort = { key: c[0], dir: state.sort.key === c[0] ? -state.sort.dir : (c[2] ? -1 : 1) }; renderTable(); };
    head.appendChild(th);
  });
  var thead = el("thead"); thead.appendChild(head); table.appendChild(thead);
  var q = state.filter.toLowerCase();
  var list = current()[state.tab].filter(function (r) { return !q || (r.name || r.path).toLowerCase().indexOf(q) !== -1 || (r.dir || "").toLowerCase().indexOf(q) !== -1; });
  var key = state.sort.key, dir = state.sort.dir;
  list.sort(function (a, b) {
    var x = cellValue(a, key), y = cellValue(b, key);
    if (key === "delta") { x = Math.abs(x || 0); y = Math.abs(y || 0); }
    if (typeof x === "number" || typeof y === "number") return ((x || 0) - (y || 0)) * dir;
    return String(x || "").localeCompare(String(y || "")) * dir;
  });
  var body = el("tbody");
  list.slice(0, 500).forEach(function (r) {
    var tr = el("tr");
    cols.forEach(function (c) {
      var k = c[0], td = el("td", { class: c[2] ? "num" : (k === "path" || k === "via" ? "wrap" : "") });
      if (k === "name") { td.textContent = r.name; if (r.copies > 1) td.appendChild(el("div", { class: "sub" }, r.dir)); }
      else if (k === "bytes") td.textContent = r.status === "removed" ? "\\u2014" : fmt(r.bytes);
      else if (k === "delta") {
        if (r.status === "new") { td.textContent = "new " + signed(r.delta); td.className += " isnew"; }
        else if (r.status === "removed") { td.textContent = "removed " + signed(r.delta); td.className += " down"; }
        else if (r.delta) { td.textContent = signed(r.delta); td.className += r.delta > 0 ? " up" : " down"; }
        else td.textContent = "";
      }
      else if (k === "kind") td.textContent = KIND[r.kind] || r.kind;
      else td.textContent = cellValue(r, k) === undefined ? "" : String(cellValue(r, k));
      tr.appendChild(td);
    });
    body.appendChild(tr);
  });
  table.appendChild(body);
  $("tablenote").textContent = list.length > 500 ? "Showing the first 500 of " + list.length + "; filter to find others." : list.length ? "" : "Nothing matches.";
}

function renderAll() { renderPlatforms(); renderCards(); renderModes(); renderMap(); renderTabs(); renderTable(); }

$("filter").oninput = function (e) { state.filter = e.target.value; renderTable(); };
var resizeTimer;
window.addEventListener("resize", function () { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderMap, 100); });
renderHints();
renderAll();
`;

const short = (commit?: string) => (commit ? commit.slice(0, 7) : "");

const sha256 = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

/**
 * The report runs only its own script and stylesheet, pinned by hash: no other scripts, no network
 * requests, no forms, no plugins, no <base>. It's safe to open from an artifact or to host as a page.
 */
function contentSecurityPolicy(script: string, style: string) {
  return [
    "default-src 'none'",
    `script-src ${sha256(script)}`,
    `style-src ${sha256(style)}`,
    "img-src data:",
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join("; ");
}

export function renderReport(data: ReportData): string {
  const script = `\nvar squarify = (${squarify.toString()});\n${SCRIPT}\n`;
  const ref = (side?: { commit?: string; branch?: string }) => (side?.commit ? `${short(side.commit)}${side.branch ? ` (${side.branch})` : ""}` : side?.branch ?? "");
  const subtitle = data.base ? `${escapeHtml(ref(data.head) || "this build")} compared with ${escapeHtml(ref(data.base) || "the base")}` : escapeHtml(ref(data.head) || "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(script, STYLE)}">
<meta name="referrer" content="no-referrer">
<title>Bundle size · ${escapeHtml(data.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
  <header>
    <div>
      <h1>📦 ${escapeHtml(data.title)}</h1>
      <div class="sub">${subtitle}</div>
    </div>
    <div class="seg" id="platforms" role="group" aria-label="Platform"></div>
  </header>
  <div class="cards" id="cards"></div>
  <section aria-labelledby="hints-title">
    <h2 id="hints-title">💡 Suggestions <span class="sub" id="hintcount"></span></h2>
    <ul class="hints" id="hints"></ul>
  </section>
  <section aria-labelledby="map-title">
    <div class="toolbar">
      <h2 id="map-title" class="flush">What's in the JS bundle</h2>
      <div class="seg" id="modes" role="group" aria-label="Colour by"></div>
    </div>
    <nav class="crumbs" id="crumbs" aria-label="Treemap path"></nav>
    <div id="map"></div>
    <div class="legend" id="legend"></div>
  </section>
  <section aria-label="Details">
    <div class="tabs">
      <div class="seg" id="tabs" role="group" aria-label="Table"></div>
      <input type="search" id="filter" placeholder="Filter" aria-label="Filter the table">
    </div>
    <div class="tablewrap"><table id="table"></table></div>
    <div class="sub" id="tablenote"></div>
  </section>
  <footer>Made by rn-sizewatch ${escapeHtml(data.version)} · measured ${escapeHtml(data.createdAt.slice(0, 10))} · sizes are of the minified JS unless noted; 1 KB = 1000 bytes</footer>
</main>
<div id="tip" role="tooltip"></div>
<script type="application/json" id="data">${embed(data)}</script>
<script>${script}</script>
</body>
</html>
`;
}
