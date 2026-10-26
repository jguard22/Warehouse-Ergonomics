/* Brilliant Wear — Warehouse Ergonomics: shift statistics (pure, no DOM).
   Display-side arithmetic for the shift summary and the shift ribbon. It never
   touches the detection pipeline in app.js (flexion zones, lift open/close, step
   threshold, hinge delta): it only adds up what that pipeline already produced.
   Works live (add one tick at a time) and on a recording (cumulate the frames once,
   then read any playhead position). Loaded as a classic script (window.ShiftStats)
   and as a CommonJS/ESM-importable module for the tests. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.ShiftStats = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Combined insole load (left + right, each 0..1) at or above which someone counts as
  // "on their feet". Walking and standing sit well above it; a pair of insoles on a
  // bench or a person seated with feet up sits below it.
  const ON_FEET_MIN_LOAD = 0.15;
  // A tick longer than this is a gap (tab in the background, scrub jump), not time on feet.
  const MAX_DT_MS = 250;
  // Load asymmetry is not shown until there is this much time on feet to average over.
  const MIN_ASYM_MS = 3000;

  const create = () => ({ onFeetMs: 0, redMs: 0, loadL: 0, loadR: 0 });

  /** Add one tick. zone is "green" | "amber" | "red" (the posture zone at that moment). */
  function add(st, dtMs, loadL, loadR, zone) {
    const dt = Math.max(0, Math.min(MAX_DT_MS, dtMs || 0));
    const l = Math.max(0, loadL || 0), r = Math.max(0, loadR || 0);
    if (l + r >= ON_FEET_MIN_LOAD) { st.onFeetMs += dt; st.loadL += l * dt; st.loadR += r * dt; }
    if (zone === "red") st.redMs += dt;
    return st;
  }

  /** Load asymmetry over the shift so far: |L - R| / (L + R) as a percent, plus the two shares. */
  function asymmetry(st) {
    const tot = st.loadL + st.loadR;
    if (st.onFeetMs < MIN_ASYM_MS || tot <= 0) return null;
    const left = Math.round((100 * st.loadL) / tot);
    return { pct: Math.round((100 * Math.abs(st.loadL - st.loadR)) / tot), left, right: 100 - left };
  }

  /** Cumulative running totals for every frame of a recording: frames carry t (ms), ll, lr, zone. */
  function cumulate(frames) {
    const n = frames.length;
    const out = { onFeet: new Float64Array(n), red: new Float64Array(n), l: new Float64Array(n), r: new Float64Array(n) };
    const st = create();
    for (let i = 0; i < n; i++) {
      const f = frames[i];
      if (i > 0) add(st, f.t - frames[i - 1].t, f.ll, f.lr, f.zone);
      out.onFeet[i] = st.onFeetMs; out.red[i] = st.redMs; out.l[i] = st.loadL; out.r[i] = st.loadR;
    }
    return out;
  }

  /** The running totals at one frame index of a cumulate() result, as a create()-shaped object. */
  function at(cum, idx) {
    const i = Math.max(0, Math.min(cum.onFeet.length - 1, idx | 0));
    if (!cum.onFeet.length) return create();
    return { onFeetMs: cum.onFeet[i], redMs: cum.red[i], loadL: cum.l[i], loadR: cum.r[i] };
  }

  /** Index of the last frame with t <= tMs (0 when tMs is before the first frame). */
  function indexAt(frames, tMs) {
    let lo = 0, hi = frames.length - 1, idx = 0;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (frames[m].t <= tMs) { idx = m; lo = m + 1; } else hi = m - 1; }
    return idx;
  }

  /** m:ss, or h:mm:ss from one hour. */
  function clock(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), ss = s % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(ss)}` : `${m}:${p(ss)}`;
  }

  /** Steps per minute from the last few step timestamps (ms): the live formula the dashboard always used. */
  function cadenceFromStepTimes(times) {
    if (!times || times.length < 4) return null;
    const span = times[times.length - 1] - times[0];
    return span > 0 ? Math.round(((times.length - 1) / (span / 1000)) * 60) : null;
  }

  /** Steps per minute at a playhead, from the cumulative step counter (frame.st) over a trailing window. */
  function cadenceAtFrame(frames, idx, windowMs) {
    const w = windowMs || 8000;
    if (!frames.length) return null;
    const i = Math.max(0, Math.min(frames.length - 1, idx | 0));
    const j = indexAt(frames, frames[i].t - w);
    const steps = frames[i].st - frames[j].st;
    const span = frames[i].t - frames[j].t;
    return steps >= 3 && span >= w * 0.5 ? Math.round((steps / (span / 1000)) * 60) : null;
  }

  /** Walk back from a lift's closing sample to find its peak: the highest flexion before the trace fell below endDeg. */
  function peakBefore(tArr, fxArr, endIdx, endDeg) {
    let k = endIdx, best = -Infinity, bestK = endIdx;
    // skip the closing sample itself (already at or under endDeg), then follow the lift back down to where it opened
    while (k > 0 && fxArr[k] <= endDeg) k--;
    for (; k >= 0 && fxArr[k] > endDeg; k--) if (fxArr[k] > best) { best = fxArr[k]; bestK = k; }
    return best === -Infinity ? { t: tArr[endIdx], peak: fxArr[endIdx] } : { t: tArr[bestK], peak: best };
  }

  /** Lift events of a recording from its frames: li/lg/lb are the running lift counters the pipeline stamped. */
  function liftsFromFrames(frames, endDeg) {
    const t = frames.map((f) => f.t), fx = frames.map((f) => f.fx);
    const out = [];
    for (let i = 1; i < frames.length; i++) {
      const d = frames[i].li - frames[i - 1].li;
      for (let k = 0; k < d; k++) {
        const good = frames[i].lg > frames[i - 1].lg;
        const pk = peakBefore(t, fx, i, endDeg);
        out.push({ n: frames[i].li - d + k + 1, t: pk.t, peak: pk.peak, good });
      }
    }
    return out;
  }

  /** Axis tick step (ms) that gives roughly `target` ticks across spanMs, from round clock values. */
  function tickStep(spanMs, target) {
    const steps = [1000, 2000, 5000, 10000, 15000, 30000, 60000, 120000, 300000, 600000, 1800000, 3600000];
    const want = spanMs / Math.max(1, target);
    for (const s of steps) if (s >= want) return s;
    return steps[steps.length - 1];
  }

  /** Posture zone of a flexion angle, using the dashboard's own two thresholds. */
  const zoneOf = (deg, amberDeg, redDeg) => (deg >= redDeg ? "red" : deg >= amberDeg ? "amber" : "green");

  return { ON_FEET_MIN_LOAD, MAX_DT_MS, MIN_ASYM_MS, create, add, asymmetry, cumulate, at, indexAt, clock, cadenceFromStepTimes, cadenceAtFrame, peakBefore, liftsFromFrames, tickStep, zoneOf };
});
