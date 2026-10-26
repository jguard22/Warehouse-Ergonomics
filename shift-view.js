/* Brilliant Wear — Warehouse Ergonomics: the shift summary and the shift ribbon.
   Reads the dashboard's own state (window.WH, from app.js) once per frame and renders
   - the four summary readings (risky lifts, time on feet, load asymmetry, steps),
   - the shift ribbon: trunk flexion across the shift with every lift marked,
   - time in red, the shift chip.
   Live (Simulate) it adds up the ticks; on a recording it reads the playhead from
   cumulative totals built once from the recording's frames (shift-stats.js). It does
   not touch detection: flexion zones, lifts and steps come from app.js unchanged. */
(() => {
  "use strict";
  const WH = window.WH, SS = window.ShiftStats;
  if (!WH || !SS) return;
  const { S, CFG, Session, TOK, fitCanvas, rgba, seekReplay, REDUCED_MOTION } = WH;
  const $ = (id) => document.getElementById(id);

  const LIVE_WINDOW_MS = 60000;      // the ribbon shows the last minute of a live shift
  const KEEP_MS = 5 * LIVE_WINDOW_MS; // history kept behind it
  const SAMPLE_MS = 100;              // one trace sample per 100 ms, same as a recording's frames
  const MAX_DEG = 90;
  const PIPS_SHOWN = 14;

  const mode = () => document.body.dataset.mode || "idle";

  // ---------- live shift ----------
  const live = { st: SS.create(), ms: 0, t: [], fx: [], lifts: [], seenLifts: 0, seenBad: 0, since: 0 };
  function resetLive() {
    Object.assign(live, { st: SS.create(), ms: 0, t: [], fx: [], lifts: [], seenLifts: 0, seenBad: 0, since: 0 });
  }
  function tickLive(dt) {
    live.ms += dt;
    SS.add(live.st, dt, S.sideLoad.left, S.sideLoad.right, SS.zoneOf(S.flexion, CFG.flexionAmber, CFG.flexionRed));
    live.since += dt;
    if (live.since >= SAMPLE_MS || !live.t.length) {
      live.since = 0;
      live.t.push(live.ms); live.fx.push(S.flexion);
      while (live.t.length && live.t[0] < live.ms - KEEP_MS) { live.t.shift(); live.fx.shift(); }
    }
    // a lift closed: app.js bumped its counters; score it from them and place it at its peak
    while (S.lifts > live.seenLifts) {
      live.seenLifts++;
      const good = S.liftsBad === live.seenBad;
      if (!good) live.seenBad = S.liftsBad;
      const pk = SS.peakBefore(live.t, live.fx, live.t.length - 1, CFG.liftEndDeg);
      const lift = { n: live.seenLifts, t: pk.t, peak: S.liftPeak || pk.peak, good, born: performance.now() };
      live.lifts.push(lift);
      announce(`Lift ${lift.n} recorded: ${good ? "good form" : "risky form, stooped back"}, peak ${Math.round(lift.peak)} degrees.`);
    }
  }

  // ---------- recording ----------
  let rep = null;
  function syncRecording() {
    const F = Session.frames;
    if (!F || !F.length) { rep = null; return; }
    if (rep && rep.forFrames === F) return;
    rep = { forFrames: F, T: F.map((f) => f.t), FX: F.map((f) => f.fx), cum: SS.cumulate(F), lifts: SS.liftsFromFrames(F, CFG.liftEndDeg), end: F[F.length - 1].t };
  }

  // ---------- DOM helpers ----------
  const _cache = new Map();
  function setT(id, str) {
    if (_cache.get(id) === str) return false;
    _cache.set(id, str);
    $(id).textContent = str;
    return true;
  }
  let _announced = "";
  function announce(msg) { if (msg !== _announced) { _announced = msg; $("ribbon-sr").textContent = msg; } }

  let pipSig = null, pipCount = 0;
  function renderPips(lifts) {
    const sig = lifts.map((l) => (l.good ? "g" : "b")).join("");
    if (sig === pipSig) return;
    const grew = lifts.length === pipCount + 1 && pipSig !== null;   // one new lift: let it pop in
    pipSig = sig; pipCount = lifts.length;
    const host = $("lift-pips");
    const shown = lifts.slice(-PIPS_SHOWN);
    host.innerHTML = (lifts.length > PIPS_SHOWN ? `<span class="pip-more">+${lifts.length - PIPS_SHOWN}</span>` : "")
      + shown.map((l, i) => `<i class="pip ${l.good ? "good" : "bad"}${grew && i === shown.length - 1 ? " fresh" : ""}"></i>`).join("");
  }

  // ---------- summary + readouts ----------
  let lastRisky = -1;
  function renderSummary(m, d) {
    // d: { lifts, good, bad, st (totals), steps, cadence, walkingNow, liftList }
    const { lifts, good, bad, st } = d;
    if (setT("kpi-risky", String(bad)) && lastRisky >= 0 && bad > lastRisky && !REDUCED_MOTION.matches) {
      const el = $("kpi-risky"); el.classList.remove("tick"); void el.offsetWidth; el.classList.add("tick");
    }
    lastRisky = bad;
    setT("kpi-risky-of", `of ${lifts} ${lifts === 1 ? "lift" : "lifts"}`);
    const tile = $("kpi-risk");
    const state = !lifts ? "none" : bad ? "risk" : "ok";
    if (tile.dataset.state !== state) tile.dataset.state = state;
    setT("kpi-risky-sub", !lifts ? "No lifts yet" : bad ? "Stooped back, hips did not hinge with the trunk" : lifts === 1 ? "Good form" : "Every lift used good form");
    renderPips(d.liftList);

    setT("kpi-feet", SS.clock(st.onFeetMs));

    const a = SS.asymmetry(st);
    setT("kpi-asym", a ? String(a.pct) : "—");
    setT("kpi-asym-unit", a ? "%" : "");
    setT("kpi-asym-sub", !a ? "Needs a few seconds on your feet" : a.pct < 3 ? "Even between the two feet" : `More load on the ${a.left > a.right ? "left" : "right"} foot`);
    const sl = a ? a.left : 50;
    if (_cache.get("split-l:w") !== sl) { _cache.set("split-l:w", sl); $("split-l").style.width = `${sl}%`; }
    setT("split-l-pct", a ? `${a.left}%` : "—");
    setT("split-r-pct", a ? `${a.right}%` : "—");

    setT("kpi-steps", String(d.steps));
    setT("kpi-cadence", d.cadence != null ? `Cadence ${d.cadence} steps per minute` : d.steps ? "Not walking right now" : "Cadence appears once walking");

    setT("redtime", `${(st.redMs / 1000).toFixed(1)} s`);
  }

  const CHIPS = {
    idle: ["idle", "No shift running"],
    live: ["live", "Simulated shift, live"],
    ended: ["sim", "Simulated shift, ended"],
    replay: ["rec", "Recorded shift"],
    loading: ["idle", "Opening recording…"],
    error: ["err", "Could not open the recording"],
  };
  function renderChip(m) {
    const [kind, text] = CHIPS[m] || CHIPS.idle;
    const chip = $("shift-chip");
    if (chip.dataset.kind !== kind) chip.dataset.kind = kind;
    setT("shift-chip-text", text);
  }

  // ---------- ribbon ----------
  const ribCv = $("ribbon");
  let lastSig = "";
  let hoverT = null;                 // recorded shift: the moment under the pointer (ms on the sensor clock)
  function ribbonSource(m) {
    if (m === "replay" && rep) {
      const idx = SS.indexAt(rep.forFrames, S.clockT == null ? 0 : S.clockT);
      return { t: rep.T, fx: rep.FX, lifts: rep.lifts.slice(0, rep.forFrames[idx].li), x0: 0, x1: Math.max(1000, rep.end), play: rep.T[idx], idx, replay: true };
    }
    if (m === "live" || m === "ended") {
      const x1 = live.ms, x0 = x1 > LIVE_WINDOW_MS ? x1 - LIVE_WINDOW_MS : 0;
      return { t: live.t, fx: live.fx, lifts: live.lifts, x0, x1: x1 > LIVE_WINDOW_MS ? x1 : LIVE_WINDOW_MS, now: m === "live" ? live.ms : null, idx: live.t.length };
    }
    return { t: [], fx: [], lifts: [], x0: 0, x1: LIVE_WINDOW_MS, idx: 0 };
  }

  function drawRibbon(m) {
    const src = ribbonSource(m);
    const { ctx, w, h, u } = fitCanvas(ribCv);
    const sig = `${m}|${Math.round(w)}x${Math.round(h)}|${m === "live" ? "live" : src.idx}|${src.lifts.length}|${hoverT == null ? "" : Math.round(hoverT / 40)}`;
    if (m !== "live" && sig === lastSig) return;     // nothing moved: leave the pixels alone
    lastSig = sig;
    ctx.clearRect(0, 0, w, h);

    const padL = 14 * u, padR = 14 * u, padT = 26 * u, padB = 30 * u;
    const px = padL, py = padT, pw = w - padL - padR, ph = h - padT - padB;
    const X = (t) => px + ((t - src.x0) / (src.x1 - src.x0)) * pw;
    const Y = (deg) => py + ph * (1 - Math.min(MAX_DEG, Math.max(0, deg)) / MAX_DEG);
    const amber = CFG.flexionAmber, red = CFG.flexionRed;

    // zone bands (the thresholds the pipeline uses), labelled directly
    ctx.fillStyle = rgba(TOK.teal, 0.05); ctx.fillRect(px, Y(amber), pw, Y(0) - Y(amber));
    ctx.fillStyle = rgba(TOK.amber, 0.08); ctx.fillRect(px, Y(red), pw, Y(amber) - Y(red));
    ctx.fillStyle = rgba(TOK.red, 0.11); ctx.fillRect(px, Y(MAX_DEG), pw, Y(red) - Y(MAX_DEG));
    ctx.strokeStyle = rgba(TOK["text-3"], 0.45); ctx.lineWidth = 1;
    for (const d of [amber, red]) { ctx.beginPath(); ctx.moveTo(px, Math.round(Y(d)) + 0.5); ctx.lineTo(px + pw, Math.round(Y(d)) + 0.5); ctx.stroke(); }

    // time axis: round clock ticks
    const step = SS.tickStep(src.x1 - src.x0, Math.max(3, Math.floor(pw / (150 * u))));
    ctx.font = `500 ${12.5 * u}px ${TOK.fontMono}`; ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
    for (let t = Math.ceil(src.x0 / step) * step; t <= src.x1 + 1; t += step) {
      const x = X(t);
      ctx.strokeStyle = rgba(TOK["text-3"], 0.18); ctx.beginPath(); ctx.moveTo(Math.round(x) + 0.5, py); ctx.lineTo(Math.round(x) + 0.5, py + ph + 5 * u); ctx.stroke();
      ctx.fillStyle = TOK["text-3"];
      ctx.textAlign = x < px + 14 * u ? "left" : x > px + pw - 14 * u ? "right" : "center";
      ctx.fillText(SS.clock(t), x, py + ph + 20 * u);
    }
    // band names, top-left of each band
    ctx.textAlign = "left"; ctx.fillStyle = TOK["text-3"]; ctx.font = `500 ${12 * u}px ${TOK.fontMono}`;
    ctx.fillText(`RISKY  ≥ ${red}°`, px + 8 * u, Y(MAX_DEG) + 16 * u);
    ctx.fillText(`CAUTION  ${amber}–${red}°`, px + 8 * u, Y(red) + 16 * u);
    ctx.fillText(`SAFE  < ${amber}°`, px + 8 * u, Y(amber) + 16 * u);

    if (!src.t.length) {
      const msg = m === "loading" ? "Opening the recording…" : m === "error" ? "The recording could not be opened. Check the file and try again." : "Start a shift to draw trunk flexion here";
      let fs = 16 * u;
      ctx.font = `500 ${fs}px ${TOK.fontUi}`;
      const mw = ctx.measureText(msg).width, room = pw - 32 * u;
      if (mw > room) { fs *= room / mw; ctx.font = `500 ${fs}px ${TOK.fontUi}`; }   // narrow phones: shrink to fit, never clip
      const tw2 = ctx.measureText(msg).width, bh = fs * 2.2;
      ctx.fillStyle = rgba(TOK.well, 0.88);
      ctx.beginPath(); ctx.roundRect(px + pw / 2 - tw2 / 2 - fs, py + ph / 2 - bh / 2, tw2 + fs * 2, bh, bh / 2); ctx.fill();
      ctx.fillStyle = TOK["text-2"]; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(msg, px + pw / 2, py + ph / 2 + 1);
      ctx.textBaseline = "alphabetic";
      return;
    }

    // trace, coloured by the zone it is in (clip the same path to each band)
    const pts = [];
    const stride = Math.max(1, Math.floor(src.t.length / (pw * 1.5)));
    for (let i = 0; i < src.t.length; i += stride) {
      if (src.t[i] < src.x0 - 1000) continue;
      if (src.t[i] > src.x1 + 1000) break;
      pts.push([X(src.t[i]), Y(src.fx[i])]);
    }
    if (pts.length) {
      const bands = [[0, amber, TOK.teal], [amber, red, TOK.amber], [red, MAX_DEG, TOK.red]];
      for (const [a, b, color] of bands) {
        ctx.save();
        ctx.beginPath(); ctx.rect(px, Y(b), pw, Y(a) - Y(b)); ctx.clip();
        ctx.strokeStyle = color; ctx.lineWidth = 2.5 * u; ctx.lineJoin = "round"; ctx.lineCap = "round";
        ctx.beginPath(); pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke();
        ctx.restore();
      }
    }

    // recorded shift: dim what has not been played yet, then the playhead
    if (src.replay) {
      const xp = X(src.play);
      ctx.fillStyle = rgba(TOK.well, 0.55); ctx.fillRect(xp, py - 2, px + pw - xp, ph + 2);
    }

    // lifts: ring = good form, filled diamond = risky; the label says which and how deep
    ctx.font = `600 ${13.5 * u}px ${TOK.fontMono}`;
    let lastRight = -Infinity;
    const nowMs = performance.now();
    for (const l of src.lifts) {
      if (l.t < src.x0 || l.t > src.x1) continue;
      const x = X(l.t), y = Y(l.peak);
      const pop = (REDUCED_MOTION.matches || !l.born) ? 1 : Math.min(1, (nowMs - l.born) / 240);
      const k = 0.35 + 0.65 * (1 - Math.pow(1 - pop, 3));
      const color = l.good ? TOK.teal : TOK.red;
      ctx.save(); ctx.translate(x, y); ctx.scale(k, k);
      if (l.good) {
        ctx.fillStyle = TOK.well; ctx.strokeStyle = color; ctx.lineWidth = 2.5 * u;
        ctx.beginPath(); ctx.arc(0, 0, 6.5 * u, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
      } else {
        ctx.fillStyle = color; ctx.strokeStyle = TOK.well; ctx.lineWidth = 1.5 * u;
        ctx.beginPath(); ctx.moveTo(0, -9 * u); ctx.lineTo(8 * u, 0); ctx.lineTo(0, 9 * u); ctx.lineTo(-8 * u, 0); ctx.closePath(); ctx.fill(); ctx.stroke();
      }
      ctx.restore();
      const label = `#${l.n} ${l.good ? "GOOD" : "RISKY"} ${Math.round(l.peak)}°`;
      const tw = ctx.measureText(label).width;
      if (x - tw / 2 > lastRight + 6 * u && x - tw / 2 > px && x + tw / 2 < px + pw) {
        const above = y - 20 * u > py - 6 * u;
        const ly = above ? y - 16 * u : y + 24 * u;
        ctx.textAlign = "center"; ctx.lineWidth = 4 * u; ctx.strokeStyle = TOK.well; ctx.lineJoin = "round";
        ctx.globalAlpha = pop; ctx.strokeText(label, x, ly); ctx.fillStyle = color; ctx.fillText(label, x, ly); ctx.globalAlpha = 1;
        lastRight = x + tw / 2;
      }
    }

    if (src.replay && hoverT != null) {
      // where a click would land: a hairline and the time
      const xh = X(Math.min(src.x1, Math.max(src.x0, hoverT)));
      ctx.strokeStyle = rgba(TOK.text, 0.45); ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(Math.round(xh) + 0.5, py); ctx.lineTo(Math.round(xh) + 0.5, py + ph); ctx.stroke();
      const lab = SS.clock(hoverT);
      ctx.font = `600 ${12.5 * u}px ${TOK.fontMono}`;
      const lw = ctx.measureText(lab).width + 12 * u;
      const lx = Math.min(px + pw - lw, Math.max(px, xh - lw / 2));
      ctx.fillStyle = TOK.text; ctx.beginPath(); ctx.roundRect(lx, py + ph + 4 * u, lw, 22 * u, 3 * u); ctx.fill();
      ctx.fillStyle = TOK.well; ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.fillText(lab, lx + lw / 2, py + ph + 15 * u); ctx.textBaseline = "alphabetic";
    }

    if (src.replay) {
      const xp = X(src.play);
      ctx.strokeStyle = TOK.text; ctx.lineWidth = 1.5 * u;
      ctx.beginPath(); ctx.moveTo(xp, py - 6 * u); ctx.lineTo(xp, py + ph); ctx.stroke();
      ctx.fillStyle = TOK.text; ctx.beginPath(); ctx.arc(xp, py - 6 * u, 3.5 * u, 0, Math.PI * 2); ctx.fill();
    } else if (src.now != null && src.t.length) {
      // live head: a dot with a slow ring
      const i = src.t.length - 1, x = X(src.t[i]), y = Y(src.fx[i]);
      const ph2 = REDUCED_MOTION.matches ? 0 : ((nowMs % 1400) / 1400);
      ctx.strokeStyle = rgba(TOK.text, 0.5 * (1 - ph2)); ctx.lineWidth = 1.5 * u;
      ctx.beginPath(); ctx.arc(x, y, (5 + 9 * ph2) * u, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = TOK.text; ctx.beginPath(); ctx.arc(x, y, 4 * u, 0, Math.PI * 2); ctx.fill();
    }
  }

  // click / drag the ribbon to seek a recording
  (function wireSeek() {
    let down = false;
    const toT = (ev) => {
      const r = ribCv.getBoundingClientRect(), u = TOK.rem / 16;
      const padL = 14 * u, pw = r.width - 28 * u;
      const f = Math.min(1, Math.max(0, (ev.clientX - r.left - padL) / pw));
      return f * (rep ? Math.max(1000, rep.end) : 0);
    };
    ribCv.addEventListener("pointerdown", (ev) => { if (mode() !== "replay" || !rep) return; down = true; ribCv.setPointerCapture(ev.pointerId); seekReplay(toT(ev)); });
    ribCv.addEventListener("pointermove", (ev) => {
      if (down) seekReplay(toT(ev));
      hoverT = (mode() === "replay" && rep && ev.pointerType === "mouse") ? toT(ev) : null;
    });
    const up = () => { down = false; };
    ribCv.addEventListener("pointerup", up); ribCv.addEventListener("pointercancel", up);
    ribCv.addEventListener("pointerleave", () => { hoverT = null; });
  })();

  // the canvas text is drawn with the web fonts: repaint once they have loaded
  if (document.fonts) { document.fonts.ready.then(() => { lastSig = ""; }); document.fonts.addEventListener("loadingdone", () => { lastSig = ""; }); }

  // ---------- frame loop ----------
  let prevMode = null, lastTs = performance.now(), lastLabel = "";
  function frame(ts) {
    const m = mode();
    const dt = Math.min(Math.max(0, ts - lastTs), 100);   // same clamp as the simulator, so both clocks agree
    lastTs = ts;
    if (m !== prevMode) {
      if (m === "live") { resetLive(); lastRisky = -1; }
      pipSig = null;
      lastSig = "";
      prevMode = m;
    }
    syncRecording();
    renderChip(m);

    let d;
    if (m === "idle" || m === "loading" || m === "error") {
      d = { lifts: 0, good: 0, bad: 0, st: SS.create(), steps: 0, cadence: null, liftList: [] };
    } else if (m === "replay" && rep) {
      const idx = SS.indexAt(rep.forFrames, S.clockT == null ? 0 : S.clockT);
      const fr = rep.forFrames[idx];
      const cad = SS.cadenceAtFrame(rep.forFrames, idx);
      d = { lifts: fr.li, good: fr.lg, bad: fr.lb, st: SS.at(rep.cum, idx), steps: fr.st, cadence: cad, liftList: rep.lifts.slice(0, fr.li) };
    } else {
      if (m === "live") tickLive(dt);
      const recent = S.stepTimes.length && performance.now() - S.stepTimes[S.stepTimes.length - 1] < 3000;
      d = { lifts: S.lifts, good: S.liftsGood, bad: S.liftsBad, st: live.st, steps: S.steps, cadence: recent ? SS.cadenceFromStepTimes(S.stepTimes) : null, liftList: live.lifts };
    }
    renderSummary(m, d);
    drawRibbon(m);

    const label = `Trunk flexion over the shift. ${d.lifts} ${d.lifts === 1 ? "lift" : "lifts"}, ${d.bad} risky.`;
    if (label !== lastLabel) { lastLabel = label; ribCv.setAttribute("aria-label", label); }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.ShiftView = { live, get rep() { return rep; } };
})();
