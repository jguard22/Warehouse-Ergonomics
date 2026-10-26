import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import SS from "../shift-stats.js";

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

test("add: counts time on feet only above the load gate, and red time by zone", () => {
  const st = SS.create();
  SS.add(st, 100, 0.5, 0.5, "green");      // on feet
  SS.add(st, 100, 0.05, 0.05, "green");    // 0.10 combined: feet up, not on feet
  SS.add(st, 100, 0.6, 0.4, "red");        // on feet and red
  assert.equal(st.onFeetMs, 200);
  assert.equal(st.redMs, 100);
  near(st.loadL, 0.5 * 100 + 0.6 * 100);
  near(st.loadR, 0.5 * 100 + 0.4 * 100);
});

test("add: a gap (background tab, scrub) is clamped, not counted as time", () => {
  const st = SS.create();
  SS.add(st, 60000, 0.5, 0.5, "red");
  assert.equal(st.onFeetMs, SS.MAX_DT_MS);
  assert.equal(st.redMs, SS.MAX_DT_MS);
  SS.add(st, -50, 0.5, 0.5, "green");      // negative dt is ignored
  assert.equal(st.onFeetMs, SS.MAX_DT_MS);
});

test("asymmetry: needs 3 s on feet, then |L-R|/(L+R) with shares that add to 100", () => {
  const st = SS.create();
  for (let i = 0; i < 20; i++) SS.add(st, 100, 0.55, 0.45, "green");   // 2 s
  assert.equal(SS.asymmetry(st), null);
  for (let i = 0; i < 20; i++) SS.add(st, 100, 0.55, 0.45, "green");   // 4 s
  const a = SS.asymmetry(st);
  assert.deepEqual(a, { pct: 10, left: 55, right: 45 });
});

test("asymmetry: a balanced shift reads 0, a one-sided one reads high", () => {
  const even = SS.create(), lean = SS.create();
  for (let i = 0; i < 60; i++) { SS.add(even, 100, 0.5, 0.5, "green"); SS.add(lean, 100, 0.8, 0.2, "green"); }
  assert.equal(SS.asymmetry(even).pct, 0);
  assert.equal(SS.asymmetry(lean).pct, 60);
  assert.equal(SS.asymmetry(lean).left + SS.asymmetry(lean).right, 100);
});

test("cumulate/at agree with adding the same ticks live", () => {
  const frames = [];
  for (let i = 0; i < 80; i++) {
    const t = i * 100;
    const ll = i % 10 < 5 ? 0.9 : 0.2, lr = i % 10 < 5 ? 0.2 : 0.9;
    frames.push({ t, ll, lr, zone: i > 50 && i < 60 ? "red" : "green" });
  }
  frames[40].ll = 0; frames[40].lr = 0;     // one tick with no load
  const live = SS.create();
  const cum = SS.cumulate(frames);
  for (let i = 0; i < frames.length; i++) {
    if (i > 0) SS.add(live, frames[i].t - frames[i - 1].t, frames[i].ll, frames[i].lr, frames[i].zone);
    const got = SS.at(cum, i);
    near(got.onFeetMs, live.onFeetMs); near(got.redMs, live.redMs); near(got.loadL, live.loadL); near(got.loadR, live.loadR);
  }
  assert.equal(SS.at(cum, 9999).onFeetMs, SS.at(cum, frames.length - 1).onFeetMs);   // clamps
  assert.equal(SS.at(SS.cumulate([]), 3).onFeetMs, 0);                                // empty recording
});

test("clock: m:ss and h:mm:ss", () => {
  assert.equal(SS.clock(0), "0:00");
  assert.equal(SS.clock(59999), "0:59");
  assert.equal(SS.clock(61000), "1:01");
  assert.equal(SS.clock(3599000), "59:59");
  assert.equal(SS.clock(3600000), "1:00:00");
  assert.equal(SS.clock(8 * 3600000 + 5 * 60000 + 9000), "8:05:09");
  assert.equal(SS.clock(-5), "0:00");
});

test("cadenceFromStepTimes: the live formula, null below four steps", () => {
  assert.equal(SS.cadenceFromStepTimes([0, 500, 1000]), null);
  assert.equal(SS.cadenceFromStepTimes([0, 500, 1000, 1500]), 120);
  assert.equal(SS.cadenceFromStepTimes([0, 600, 1200, 1800, 2400]), 100);
});

test("cadenceAtFrame: steps in a trailing window, null when too few", () => {
  const frames = [];
  for (let i = 0; i <= 200; i++) frames.push({ t: i * 100, st: Math.floor(i / 5) });   // 2 steps/s = 120 spm
  assert.equal(SS.cadenceAtFrame(frames, 200), 120);
  const still = frames.map((f) => ({ ...f, st: 4 }));
  assert.equal(SS.cadenceAtFrame(still, 200), null);
  assert.equal(SS.cadenceAtFrame(frames, 10), null);       // not enough elapsed time yet
  assert.equal(SS.cadenceAtFrame([], 0), null);
});

// build frames for a trunk-flexion trace: peaks[] = [{at: ms, peak, pelvisGood}]
function framesFor(peaks, durationMs = 20000) {
  const frames = []; let li = 0, lg = 0, lb = 0, open = false;
  for (let t = 0; t <= durationMs; t += 100) {
    let fx = 3;
    for (const p of peaks) { const d = (t - p.at) / 1500; if (Math.abs(d) < 1) fx = Math.max(fx, p.peak * (1 - d * d)); }
    if (!open && fx >= 45) open = true;
    else if (open && fx <= 20) {
      open = false; li++;
      const p = peaks.find((q) => Math.abs(t - q.at) < 2000);
      if (p.good) lg++; else lb++;
    }
    frames.push({ t, fx, li, lg, lb });
  }
  return frames;
}

test("liftsFromFrames: one event per closed lift, scored from the counters, placed at the peak", () => {
  const frames = framesFor([{ at: 5000, peak: 55, good: true }, { at: 13000, peak: 76, good: false }]);
  const lifts = SS.liftsFromFrames(frames, 20);
  assert.equal(lifts.length, 2);
  assert.deepEqual(lifts.map((l) => [l.n, l.good]), [[1, true], [2, false]]);
  assert.ok(Math.abs(lifts[0].t - 5000) <= 200 && Math.abs(lifts[0].peak - 55) <= 1);
  assert.ok(Math.abs(lifts[1].t - 13000) <= 200 && Math.abs(lifts[1].peak - 76) <= 1);
});

test("liftsFromFrames: no lifts, no events; a recording that never lifted stays empty", () => {
  assert.deepEqual(SS.liftsFromFrames(framesFor([]), 20), []);
  assert.deepEqual(SS.liftsFromFrames([], 20), []);
});

test("peakBefore falls back to the closing sample when there is no lift to follow", () => {
  assert.deepEqual(SS.peakBefore([0, 100], [5, 6], 1, 20), { t: 100, peak: 6 });
});

test("indexAt: last frame at or before the time", () => {
  const f = [{ t: 0 }, { t: 100 }, { t: 200 }];
  assert.equal(SS.indexAt(f, -5), 0);
  assert.equal(SS.indexAt(f, 100), 1);
  assert.equal(SS.indexAt(f, 150), 1);
  assert.equal(SS.indexAt(f, 9999), 2);
});

test("tickStep and zoneOf", () => {
  assert.equal(SS.tickStep(60000, 4), 15000);
  assert.equal(SS.tickStep(36000, 6), 10000);
  assert.equal(SS.tickStep(500, 6), 1000);
  assert.equal(SS.tickStep(8 * 3600000, 6), 3600000);
  assert.equal(SS.zoneOf(19.9, 20, 45), "green");
  assert.equal(SS.zoneOf(20, 20, 45), "amber");
  assert.equal(SS.zoneOf(44.9, 20, 45), "amber");
  assert.equal(SS.zoneOf(45, 20, 45), "red");
});

// Guard: this polish pass is design + UX only. If someone changes a detection threshold, this fails loudly.
test("detection constants in app.js are untouched", () => {
  const src = readFileSync(new URL("../app.js", import.meta.url), "utf8");
  const cfg = src.match(/const CFG = \{([\s\S]*?)\n  \};/)[1];
  const val = (k) => Number(cfg.match(new RegExp(`${k}:\\s*([0-9.]+)`))[1]);
  assert.equal(val("flexionAmber"), 20);
  assert.equal(val("flexionRed"), 45);
  assert.equal(val("liftStartDeg"), 45);
  assert.equal(val("liftEndDeg"), 20);
  assert.equal(val("stoopPeakDeg"), 60);
  assert.equal(val("hingeGoodDelta"), 25);
  assert.equal(val("stepThreshold"), 0.55);
  assert.equal(val("stepRefractoryMs"), 300);
  assert.equal(val("hapticCooldownMs"), 2000);
  assert.match(src, /const MAP = \{ strideM: 0\.62, lateralM: 0\.13, windowMs: 10000 \};/);
  assert.match(src, /const VISION_MIN_CONF = 0\.6;/);
  assert.match(src, /const GAIT_ALTERNATION_MS = 1600;/);
});
