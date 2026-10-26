import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
const strip = (s) => s.split("\n").filter((l) => !/data:image|theme-color/.test(l)).join("\n");

test("theme tokens only: no colour literals outside theme.css (CSS, HTML pages, the ribbon)", () => {
  for (const f of ["dashboard.css", "gallery.css", "index.html", "recordings.html", "shift-view.js"]) {
    const src = strip(read(f));
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b(?![\w-])/, `${f} has a hex colour literal`);
    assert.doesNotMatch(src, /\brgba?\(\s*\d/, `${f} has an rgb() literal`);
  }
});

test("the theme file defines the roles the pages rely on", () => {
  const css = read("theme.css");
  for (const t of ["--teal", "--red", "--amber", "--peri", "--ground-1", "--text", "--text-2", "--text-3", "--font-num", "--font-mono", "--dur-1", "--dur-3"]) assert.match(css, new RegExp(`${t}:`), t);
  assert.match(css, /--teal:\s*#00d4aa/i, "brand teal");
});

test("no sideways panning: the clip rules are in the theme", () => {
  const css = read("theme.css");
  assert.match(css, /html\s*\{[^}]*overflow-x:\s*clip[^}]*overscroll-behavior-x:\s*none/);
  assert.match(css, /body\s*\{[^}]*overflow-x:\s*clip/);
  for (const f of ["dashboard.css", "gallery.css"]) assert.doesNotMatch(read(f), /repeat\(\d+,\s*1fr\)/, `${f}: use minmax(0, 1fr)`);
});

test("numbers are tabular, motion is 150-300 ms and honours reduced motion", () => {
  assert.match(read("dashboard.css"), /\.kpi-value[^}]*tabular-nums/);
  assert.match(read("theme.css"), /prefers-reduced-motion: reduce/);
  for (const m of read("theme.css").matchAll(/--dur-(\d):\s*(\d+)ms/g)) assert.ok(+m[2] >= 150 && +m[2] <= 300, `--dur-${m[1]} = ${m[2]} ms`);
});

test("every page has a title, one h1 and a main landmark", () => {
  for (const f of ["index.html", "recordings.html"]) {
    const src = read(f);
    assert.match(src, /<title>[^<]{8,}<\/title>/, f);
    assert.equal((src.match(/<h1[ >]/g) || []).length, 1, `${f}: one h1`);
    assert.match(src, /<main[ >]/, f);
  }
});

test("no icon glyphs or emoji in the markup: icons are drawn SVG", () => {
  for (const f of ["index.html", "recordings.html", "shift-view.js"]) {
    assert.doesNotMatch(read(f), /[\u25B6\u23F8\u2630\u2913\u2B07\u26A0\u2299\u25CE\u2B24\u{1F300}-\u{1FAFF}]/u, `${f} has an icon glyph`);
  }
});

test("repo rules: no permission-mechanism wording, no iCloud duplicates", () => {
  for (const f of ["index.html", "recordings.html", "app.js", "shift-view.js", "shift-stats.js", "stance3d.js", "README.md"]) assert.doesNotMatch(read(f), /GHAPS/i, f);
  const all = (dir) => readdirSync(new URL(`../${dir}`, import.meta.url), { withFileTypes: true }).flatMap((e) => (e.name === ".git" || e.name === "node_modules" ? [] : e.isDirectory() ? all(`${dir}/${e.name}`) : [`${dir}/${e.name}`]));
  assert.deepEqual(all(".").filter((f) => / 2\.[a-z0-9]+$/i.test(f)), []);
});

test("the dashboard never claims a live hardware link it does not make", () => {
  const html = read("index.html");
  assert.doesNotMatch(html, /Web Bluetooth/i);
  assert.match(html, /simulated or replayed/i);
});
