// Screenshots of the main screens, for design review.
//   node scripts/shoot.mjs <outdir> [prefix]        (prefix: "before" / "after"; default "shot")
// Names: <prefix>-<screen>-<size>.png. System Chrome through playwright-core, own server on :5871 (PORT to override).
// Also checks, at every size, that nothing pokes sideways and that the console stays clean.
//   ONLY=desk,phone  limits the sizes; SCREENS=idle,walk limits the screens.
import { createRequire } from "node:module";
import { mkdirSync, readdirSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { startServer } from "./serve.mjs";

const require = createRequire(import.meta.url);
function findPw() {
  if (process.env.PW) return process.env.PW;
  const npx = path.join(os.homedir(), ".npm/_npx");
  if (existsSync(npx)) for (const d of readdirSync(npx)) { const p = path.join(npx, d, "node_modules/playwright-core"); if (existsSync(p)) return p; }
  return "playwright-core";
}
const { chromium } = require(findPw());

const OUT = process.argv[2] || "shots";
const PREFIX = process.argv[3] || "shot";
const PORT = Number(process.env.PORT || 5871);
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(",")) : null;
const SCREENS = process.env.SCREENS ? new Set(process.env.SCREENS.split(",")) : null;
mkdirSync(OUT, { recursive: true });
const BASE = `http://127.0.0.1:${PORT}`;

const SIZES = [
  { id: "desk", width: 1280, height: 800 },
  { id: "tv", width: 1920, height: 1080 },
  { id: "phone", width: 390, height: 844 },
  { id: "narrow", width: 320, height: 640 },
  { id: "mid", width: 402, height: 874 },
];

const server = await startServer(PORT);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const hard = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 560000);
const errors = [];
const overflow = [];

async function newCtx({ width, height }) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: "dark", reducedMotion: "no-preference", locale: "en-US", deviceScaleFactor: 1 });
  // the hardware SDK is never used by Simulate / replay: keep the page quick and offline-safe
  await ctx.route("**/unpkg.com/brilliantsole**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "/* sdk stub */" }));
  return ctx;
}
async function open(ctx, tag, url) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${tag} error: ${m.text()}`); });
  await page.goto(url);
  await page.waitForTimeout(1800);
  return page;
}
/** The page clips sideways overflow, so scrollWidth hides problems: look for elements that poke past the viewport and are not inside their own scroller. */
async function noHScroll(page, tag) {
  const bad = await page.evaluate(() => {
    const W = window.innerWidth, out = [];
    const scroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
    for (const el of document.querySelectorAll("body *")) {
      const b = el.getBoundingClientRect();
      if (b.width && b.right > W + 1 && getComputedStyle(el).position !== "fixed" && !scroller(el)) out.push(`${el.tagName}.${String(el.className).slice(0, 30)}#${el.id} right=${Math.round(b.right)}`);
    }
    return { sw: document.documentElement.scrollWidth, W, out: out.slice(0, 6) };
  });
  if (bad.sw > bad.W + 1 || bad.out.length) overflow.push(`${tag}: ${bad.sw} vs ${bad.W} ${bad.out.join(" | ")}`);
}
const shot = async (page, name, tag) => { await noHScroll(page, `${tag}/${name}`); await page.screenshot({ path: path.join(OUT, `${PREFIX}-${name}-${tag}.png`), fullPage: true }); };
const want = (s) => !SCREENS || SCREENS.has(s);

try {
  for (const sz of SIZES) {
    if (ONLY && !ONLY.has(sz.id)) continue;
    const ctx = await newCtx(sz);
    const tag = sz.id;
    if (want("idle")) { const p = await open(ctx, `${tag}/idle`, `${BASE}/index.html`); await shot(p, "idle", tag); await p.close(); }
    if (want("walk") || want("risk")) {
      const p = await open(ctx, `${tag}/shift`, `${BASE}/index.html`);
      // the primary action: "Start shift" in the new build, "Simulate" in the old one
      await p.click("#btn-sim");
      await p.waitForTimeout(5200);                 // mid-walk
      if (want("walk")) await shot(p, "walk", tag);
      if (want("risk")) {
        await p.waitForTimeout(11400);              // inside the stooped lift (sim phase 4)
        await shot(p, "risk", tag);
        await p.waitForTimeout(5000);               // back to walking, lift totals settled
        await shot(p, "lifts-done", tag);
      }
      await p.close();
    }
    if (want("replay")) { const p = await open(ctx, `${tag}/replay`, `${BASE}/index.html?rec=we6`); await p.waitForTimeout(2500); await p.evaluate(() => { const v = document.getElementById("cam"); if (v) v.currentTime = 20; }); await p.waitForTimeout(1500); await shot(p, "replay", tag); await p.close(); }
    if (want("focus") && sz.id === "desk") { const p = await open(ctx, `${tag}/focus`, `${BASE}/index.html`); await p.keyboard.press("Tab"); await p.keyboard.press("Tab"); await p.keyboard.press("Tab"); await p.screenshot({ path: path.join(OUT, `${PREFIX}-focus-${tag}.png`), clip: { x: 0, y: 0, width: sz.width, height: 260 } }); await p.close(); }
    if (want("recordings")) { const p = await open(ctx, `${tag}/recordings`, `${BASE}/recordings.html`); await shot(p, "recordings", tag); await p.close(); }
    await ctx.close();
  }
} finally {
  clearTimeout(hard);
  await browser.close();
  server.close();
}
console.log(errors.length ? `CONSOLE ERRORS (${errors.length}):\n${[...new Set(errors)].join("\n")}` : "console: clean");
console.log(overflow.length ? `OVERFLOW:\n${overflow.join("\n")}` : "overflow: none");
process.exit(errors.length || overflow.length ? 1 : 0);
