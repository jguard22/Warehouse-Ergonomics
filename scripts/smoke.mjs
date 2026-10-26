// Headless smoke test of the dashboard in system Chrome (playwright-core), no console errors allowed.
//   node scripts/smoke.mjs        (own server on :5871, PORT to override; ~45 s because the simulated shift runs in real time)
// Checks: the idle page, a full simulated shift (Start shift -> risky lift -> End shift -> restart),
// a recording replay (open from the gallery link, click the ribbon to seek), the gallery page,
// the loading/error state, reduced motion, and that nothing pokes sideways at 320 / 375 / 402 px.
import { createRequire } from "node:module";
import { readdirSync, existsSync } from "node:fs";
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

const PORT = Number(process.env.PORT || 5871);
const BASE = `http://127.0.0.1:${PORT}`;
const failures = [];
const check = (ok, msg) => { console.log(`${ok ? "ok  " : "FAIL"} ${msg}`); if (!ok) failures.push(msg); };

const server = await startServer(PORT);
const browser = await chromium.launch({ channel: "chrome", headless: true });
const hard = setTimeout(() => { console.error("HARD TIMEOUT"); process.exit(2); }, 300000);
const errors = [];

async function newCtx(opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "dark", locale: "en-US", ...opts });
  await ctx.route("**/unpkg.com/brilliantsole**", (r) => r.fulfill({ status: 200, contentType: "text/javascript", body: "/* sdk stub */" }));
  return ctx;
}
async function open(ctx, tag, url) {
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${tag} pageerror: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error") errors.push(`${tag} error: ${m.text()}`); });
  await page.goto(url);
  await page.waitForTimeout(1200);
  return page;
}
const txt = (page, id) => page.$eval(`#${id}`, (e) => e.textContent.trim());
const mode = (page) => page.evaluate(() => document.body.dataset.mode);
/** The page clips sideways overflow, so scrollWidth hides problems: look for elements that poke past the viewport and are not inside their own scroller. */
async function noHScroll(page, tag) {
  const bad = await page.evaluate(() => {
    const W = window.innerWidth, out = [];
    const scroller = (el) => { for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) { if (/(auto|scroll)/.test(getComputedStyle(p).overflowX)) return true; } return false; };
    for (const el of document.querySelectorAll("body *")) {
      const b = el.getBoundingClientRect();
      if (b.width && b.right > W + 1 && getComputedStyle(el).position !== "fixed" && !scroller(el)) out.push(`${el.tagName}.${String(el.className).slice(0, 30)}#${el.id} right=${Math.round(b.right)}`);
    }
    return { sw: document.documentElement.scrollWidth, W, out: out.slice(0, 5) };
  });
  check(bad.sw <= bad.W + 1 && !bad.out.length, `${tag}: no sideways overflow (${bad.sw} vs ${bad.W}${bad.out.length ? " " + bad.out.join(" | ") : ""})`);
}

try {
  // ---- idle page ----
  {
    const ctx = await newCtx();
    const page = await open(ctx, "idle", `${BASE}/index.html`);
    check((await page.title()).includes("Warehouse ergonomics"), "title names the page");
    check((await page.$eval("h1", (e) => e.textContent)) === "Warehouse ergonomics", "h1 is the page title");
    check((await txt(page, "btn-sim-label")) === "Start shift", "primary action reads Start shift");
    check((await page.$eval("#btn-sim", (e) => e.classList.contains("primary"))), "Start shift is the primary button");
    check((await mode(page)) === "idle", "mode starts idle");
    check((await txt(page, "kpi-risky")) === "0" && (await txt(page, "kpi-feet")) === "0:00", "idle readings are zero");
    check((await page.$("#video-card") && !(await page.$eval("#video-card", (e) => getComputedStyle(e).display !== "none"))), "recording panel hidden until a recording is open");
    const stance = await page.waitForSelector("#stance3d canvas", { timeout: 20000 }).then(() => true, () => false);
    check(stance, "3D stance renders a canvas");
    await ctx.close();
  }

  // ---- a full simulated shift ----
  {
    const ctx = await newCtx();
    const page = await open(ctx, "shift", `${BASE}/index.html`);
    await page.click("#btn-sim");
    check((await txt(page, "btn-sim-label")) === "End shift" && (await mode(page)) === "live", "Start shift -> live, button becomes End shift");
    check((await page.$eval("#btn-sim", (e) => !e.classList.contains("primary"))), "End shift is not the primary button");
    await page.waitForTimeout(3500);
    check(Number(await txt(page, "kpi-steps")) >= 3, "steps count up while walking");
    const feet = await txt(page, "kpi-feet");
    check(/^0:0[2-5]$/.test(feet), `time on feet follows the clock (${feet} after ~3.5 s)`);
    check((await txt(page, "shift-chip-text")).includes("live"), "chip says the shift is live and simulated");
    // run through the good lift (~10 s) and the stooped lift (~19 s)
    await page.waitForFunction(() => document.getElementById("kpi-risky-of").textContent.includes("of 2"), null, { timeout: 30000, polling: 200 });
    check((await txt(page, "kpi-risky")) === "1", "the stooped lift is the one risky lift of two");
    check((await page.$eval("#kpi-risk", (e) => e.dataset.state)) === "risk", "risky tile enters its risk state");
    check((await page.$$eval("#lift-pips .pip", (e) => e.map((x) => x.className.includes("bad") ? "b" : "g").join(""))) === "gb", "pips show one good lift then one risky");
    const ink = await page.$eval("#ribbon", (cv) => { const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++; return n; });
    check(ink > 5000, `ribbon is drawn (${ink} painted pixels)`);
    const asym = await txt(page, "kpi-asym");
    check(/^\d+$/.test(asym) && Number(asym) < 15, `load asymmetry reads a small number for the symmetric simulator (${asym}%)`);
    await noHScroll(page, "live 1280");
    // end the shift: the summary must stay, and the clock must stop
    await page.click("#btn-sim");
    check((await mode(page)) === "ended" && (await txt(page, "btn-sim-label")) === "Start shift", "End shift -> ended, button returns to Start shift");
    const f1 = await txt(page, "kpi-feet"); await page.waitForTimeout(1500); const f2 = await txt(page, "kpi-feet");
    check(f1 === f2 && (await txt(page, "kpi-risky")) === "1", "summary stays after the shift ends and the clock stops");
    // restart: everything resets
    await page.click("#btn-sim");
    await page.waitForTimeout(700);
    check((await txt(page, "kpi-risky")) === "0" && (await txt(page, "kpi-risky-of")) === "of 0 lifts" && Number((await txt(page, "kpi-feet")).split(":")[1]) <= 1, "restarting a shift resets the summary");
    check((await page.$$eval("#lift-pips .pip", (e) => e.length)) === 0, "restart clears the lift pips");
    await page.click("#btn-sim");
    await ctx.close();
  }

  // ---- recording replay ----
  {
    const ctx = await newCtx();
    const page = await open(ctx, "replay", `${BASE}/index.html?rec=we6`);
    await page.waitForFunction(() => document.body.dataset.mode === "replay", null, { timeout: 30000 });
    await page.waitForFunction(() => { const v = document.getElementById("cam"); return v.readyState >= 2 && !v.seeking; }, null, { timeout: 20000 });
    await page.waitForTimeout(1200);
    check((await txt(page, "rec-title")).startsWith("WE 6"), "recording title shown");
    check((await txt(page, "rec-note")).length > 20, "recording note shown");
    check(await page.$eval("#video-card", (e) => getComputedStyle(e).display !== "none"), "recording panel visible in replay");
    check(!(await page.$eval("#btn-json", (e) => e.disabled)), "raw JSON export enabled for a recording");
    await page.$eval("#ribbon", (e) => e.scrollIntoView({ block: "center" }));
    const box = await page.$eval("#ribbon", (e) => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
    await page.mouse.click(box.x + box.w * 0.5, box.y + box.h * 0.5);
    await page.waitForTimeout(1200);
    const t = await page.$eval("#cam", (v) => v.currentTime);
    check(t > 12 && t < 26, `clicking the ribbon seeks the video (${t.toFixed(1)} s of 36)`);
    const feetAt = await txt(page, "kpi-feet");
    check(/^0:(1[0-9]|2[0-9])$/.test(feetAt), `time on feet follows the playhead (${feetAt})`);
    await noHScroll(page, "replay 1280");
    await page.setViewportSize({ width: 320, height: 640 }); await page.waitForTimeout(600);
    await noHScroll(page, "replay 320");
    await ctx.close();
  }

  // ---- loading + error state ----
  {
    const ctx = await newCtx();
    const page = await open(ctx, "error", `${BASE}/index.html?rec=no-such-take`);
    await page.waitForFunction(() => document.body.dataset.mode === "error", null, { timeout: 15000 });
    check((await txt(page, "shift-chip-text")).includes("Could not open"), "an unknown recording shows a plain error state");
    await page.click("#btn-sim");
    check((await mode(page)) === "live", "Start shift still works after a failed open");
    await ctx.close();
  }

  // ---- gallery ----
  {
    const ctx = await newCtx();
    const page = await open(ctx, "gallery", `${BASE}/recordings.html`);
    check((await page.$$eval(".rec", (e) => e.length)) === 3, "gallery lists three recordings");
    check((await page.$$eval(".rec .btn.primary", (e) => e.every((a) => /index\.html\?rec=we\d/.test(a.getAttribute("href"))))), "every row has a replay link");
    check((await page.$eval("h1", (e) => e.textContent)) === "Recordings", "gallery has a title");
    await ctx.close();
  }

  // ---- reduced motion ----
  {
    const ctx = await newCtx({ reducedMotion: "reduce" });
    const page = await open(ctx, "reduced", `${BASE}/index.html`);
    const anim = await page.$eval("#btn-sim", (e) => getComputedStyle(e).animationName);
    check(anim === "none", `idle call-out ring is off under reduced motion (${anim})`);
    await ctx.close();
  }

  // ---- no sideways panning at the three phone widths, idle and mid-shift ----
  for (const w of [320, 375, 402]) {
    const ctx = await newCtx({ viewport: { width: w, height: 800 } });
    const page = await open(ctx, `phone${w}`, `${BASE}/index.html`);
    await noHScroll(page, `idle ${w}`);
    await page.click("#btn-sim"); await page.waitForTimeout(2500);
    await noHScroll(page, `live ${w}`);
    await ctx.close();
  }
  const gctx = await newCtx({ viewport: { width: 320, height: 800 } });
  const gp = await open(gctx, "gallery320", `${BASE}/recordings.html`);
  await noHScroll(gp, "gallery 320");
  await gctx.close();
} finally {
  clearTimeout(hard);
  await browser.close();
  server.close();
}
check(errors.length === 0, `zero console errors${errors.length ? ":\n  " + [...new Set(errors)].join("\n  ") : ""}`);
console.log(failures.length ? `\n${failures.length} FAILED` : "\nall ok");
process.exit(failures.length ? 1 : 0);
