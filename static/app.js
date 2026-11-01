/* Listening Lab — front end. Plain JS + canvas, no build step. */
"use strict";

const $ = (s) => document.querySelector(s);
const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
const C = {
  line: "#1c1c1c", bar: "#262626", beat: "#0f0f0f", text: "#e8e8e8", dim: "#8a8a8a", faint: "#555",
  tension: "#ff8a3d", sure: "#6fb7ff", rough: "#d8d8d8", arrive: "#7dffb0", disagree: "#ff4d6d",
};
const PC = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"];
const FUNCTIONS = ["tonic", "predominant", "dominant", "chromatic", "other"];
const fmt = (s) => (s == null ? "–" : String(s).replace(/([A-G])b/g, "$1♭").replace(/([A-G])#/g, "$1♯"));
const pct = (x) => Math.round(x * 100) + "%";

// Keys ordered round the circle of fifths, each major followed by its relative minor
const KEY_ROWS = [];
[0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5].forEach((pc) => KEY_ROWS.push(pc, 12 + ((pc + 9) % 12)));

const S = {
  status: null, data: null, source: null, jev: null,
  view: { t0: 0, pps: 40 },
  window: 4, align: "centered", gapMode: "semitones", gapWeighted: true,
  hoverT: null, follow: true,
};

function store(k, v) { try { localStorage.setItem("ll." + k, JSON.stringify(v)); } catch (e) {} }
function load(k, d) { try { const v = localStorage.getItem("ll." + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
Object.assign(S, load("settings", {}));
S.hoverT = null;

// ------------------------------------------------------------------ lanes

const A = () => S.data && S.data.analysis;
const beats = () => (A() ? A().beats : []);
const local = () => A().local_home[S.align][String(S.window)];
const homeKey = () => A().global_home.key;
const keyName = (k) => (S.status ? S.status.keys[k] : "");

function jevArg(dist) {
  let best = null, p = -1;
  for (const k in dist) if (dist[k] > p) { p = dist[k]; best = k; }
  return [best, p];
}

function detAnswer(b, field) {
  if (field === "chord_root") return b.chord.root == null ? null : PC[b.chord.root];
  if (field === "chord_function") return b.function;
  if (field === "local_home") return keyName(local().best[b.i]);
  if (field === "heading") return b.heading.length ? b.heading[0].name : null;
  if (field === "is_arrival") return b.arrival > 0 ? "yes" : "no";
}

const LANES = {
  roll: {
    title: "Piano roll", h: 150,
    desc: "Every note. Height is pitch, brightness is how hard it was played.",
    draw: drawRoll, axis: axisRoll,
  },
  position: {
    title: "Position", h: 56,
    desc: "Where are we: the chord on each beat. Under it, in grey, the detector's own guess (red where it disagrees with your chart).",
    draw: drawPosition,
  },
  heading: {
    title: "Heading", h: 62,
    desc: "Where it wants to go: the two keys this chord pulls toward. Bar length = weight.",
    draw: drawHeading,
  },
  localhome: {
    title: "Local home", h: 24 * 8,
    desc: "Which key the surrounding music sounds like. Brighter = more likely. Orange outline = global home; orange dot = the heading.",
    controls: ctlWindow, draw: drawLocalHome, axis: axisKeys,
  },
  gap: {
    title: "Gap (tension)", h: 96,
    desc: "Distance from where it wants to go to home. 0 = heading home. Grey = the other measure. Green ticks = arrivals at home, grey = arrivals elsewhere.",
    controls: ctlGap, draw: drawGap, axis: (c, w, h) => axisNum(c, w, h, 0, 6, [0, 3, 6]),
  },
  confidence: {
    title: "Confidence", h: 70,
    desc: "How sure the local-home lane is. High = one key stands out; low = lost between keys. Follows the window setting.",
    draw: drawConfidence, axis: (c, w, h) => axisNum(c, w, h, 0, 1, [0, 0.5, 1]),
  },
  roughness: {
    title: "Roughness", h: 70,
    desc: "Sensory friction between the sounding notes (Plomp–Levelt / Sethares, 6 harmonics). The road surface, separate from tension.",
    draw: drawRoughness, axis: axisRough,
  },
  jevstatus: {
    title: "Jev (AI lane)", h: 34, jev: "status",
    desc: "TypeSafe's Jev answering the same questions. Configure in jev_config.json.",
    draw: drawJevStatus,
  },
  jev_root: {
    title: "Jev · chord root", h: 12 * 8, jev: true,
    desc: "Jev's probability for each root. White box = the deterministic root, red when they disagree.",
    draw: (c, w, h) => drawJevHeat(c, w, h, "chord_root", PC), axis: (c, w, h) => axisRows(c, w, h, PC),
  },
  jev_function: {
    title: "Jev · function", h: 5 * 12, jev: true,
    desc: "Jev's tonic / predominant / dominant / chromatic / other, against the rule-based function.",
    draw: (c, w, h) => drawJevHeat(c, w, h, "chord_function", FUNCTIONS),
    axis: (c, w, h) => axisRows(c, w, h, ["T", "PD", "D", "chr", "–"]),
  },
  jev_home: {
    title: "Jev · local home", h: 24 * 8, jev: true,
    desc: "Jev's local key, same rows as the local-home lane. Box = the deterministic answer at the current window size.",
    draw: (c, w, h) => drawJevHeat(c, w, h, "local_home", KEY_ROWS.map(keyName)), axis: axisKeys,
  },
  jev_heading: {
    title: "Jev · heading", h: 24 * 8, jev: true,
    desc: "Where Jev thinks the music wants to go. Box = the rule-based top heading.",
    draw: (c, w, h) => drawJevHeat(c, w, h, "heading", KEY_ROWS.map(keyName)), axis: axisKeys,
  },
  jev_arrival: {
    title: "Jev · arrival", h: 60, jev: true,
    desc: "Jev's probability that this beat is an arrival. Ticks = rule-based arrivals.",
    draw: drawJevArrival, axis: (c, w, h) => axisNum(c, w, h, 0, 1, [0, 1]),
  },
  disagree: {
    title: "Jev vs rules", h: 5 * 12, jev: true,
    desc: "Red = Jev's top answer differs from the deterministic one. Rows: root, function, local home, heading, arrival.",
    draw: drawDisagree, axis: (c, w, h) => axisRows(c, w, h, ["root", "fn", "home", "head", "arr"]),
  },
};
const DEFAULT_ORDER = Object.keys(LANES);
S.order = load("order", DEFAULT_ORDER).filter((k) => LANES[k]);
DEFAULT_ORDER.forEach((k) => { if (!S.order.includes(k)) S.order.push(k); });
S.hidden = new Set(load("hidden", []));

function laneVisible(id) {
  const L = LANES[id];
  if (S.hidden.has(id)) return false;
  const connected = S.jev && S.jev.beats;
  if (L.jev === true) return !!connected;
  if (L.jev === "status") return !connected;
  return true;
}

function buildLanes() {
  const host = $("#lanes");
  host.innerHTML = "";
  for (const id of S.order) {
    if (!laneVisible(id)) continue;
    const L = LANES[id];
    const el = document.createElement("div");
    el.className = "lane";
    el.dataset.id = id;
    el.innerHTML = `
      <div class="lane-label"><div class="lane-text">
        <div class="lane-name"><span>${L.title}</span><span class="tools">
          <button data-act="up" title="Move up">↑</button><button data-act="down" title="Move down">↓</button><button data-act="hide" title="Hide">×</button>
        </span></div>
        <div class="lane-desc">${L.desc}</div>
        <div class="lane-ctl"></div>
      </div></div>
      <div class="lane-axis"><canvas></canvas></div>
      <div class="lane-body"><canvas></canvas></div>`;
    el.querySelector(".lane-body").style.minHeight = L.h + "px";
    if (L.controls) L.controls(el.querySelector(".lane-ctl"));
    else el.querySelector(".lane-ctl").remove();
    el.querySelector(".tools").addEventListener("click", (e) => {
      const act = e.target.dataset.act;
      if (!act) return;
      const i = S.order.indexOf(id);
      if (act === "hide") S.hidden.add(id);
      if (act === "up" || act === "down") {
        // swap with the nearest visible neighbour
        const dir = act === "up" ? -1 : 1;
        let j = i + dir;
        while (j >= 0 && j < S.order.length && !laneVisible(S.order[j])) j += dir;
        if (j >= 0 && j < S.order.length) [S.order[i], S.order[j]] = [S.order[j], S.order[i]];
      }
      store("order", S.order); store("hidden", [...S.hidden]);
      buildLanes(); buildLaneMenu();
    });
    host.appendChild(el);
  }
  render();
}

function buildLaneMenu() {
  const m = $("#lanes-menu");
  m.innerHTML = "";
  for (const id of S.order) {
    const L = LANES[id];
    const lab = document.createElement("label");
    lab.innerHTML = `<input type="checkbox" ${S.hidden.has(id) ? "" : "checked"}> ${L.title}`;
    lab.querySelector("input").addEventListener("change", (e) => {
      e.target.checked ? S.hidden.delete(id) : S.hidden.add(id);
      store("hidden", [...S.hidden]);
      buildLanes();
    });
    m.appendChild(lab);
  }
  const sep = document.createElement("div"); sep.className = "sep"; m.appendChild(sep);
  const reset = document.createElement("label");
  reset.textContent = "Reset order and visibility";
  reset.addEventListener("click", () => {
    S.order = [...DEFAULT_ORDER]; S.hidden = new Set();
    store("order", S.order); store("hidden", []);
    buildLanes(); buildLaneMenu();
  });
  m.appendChild(reset);
}

// lane controls ----------------------------------------------------

function seg(host, options, current, onPick) {
  const s = document.createElement("span");
  s.className = "seg";
  for (const [val, label] of options) {
    const b = document.createElement("button");
    b.textContent = label;
    if (val === current) b.className = "on";
    b.onclick = () => { s.querySelectorAll("button").forEach((x) => x.classList.remove("on")); b.classList.add("on"); onPick(val); };
    s.appendChild(b);
  }
  host.appendChild(s);
}

function saveSettings() {
  store("settings", { window: S.window, align: S.align, gapMode: S.gapMode, gapWeighted: S.gapWeighted, follow: S.follow });
}

function ctlWindow(host) {
  const lab = document.createElement("label");
  lab.innerHTML = `window <input type="range" min="1" max="8" step="1" value="${S.window}"> <b>${S.window}</b> bar${S.window > 1 ? "s" : ""}`;
  const inp = lab.querySelector("input");
  inp.oninput = () => {
    S.window = +inp.value;
    lab.querySelector("b").textContent = S.window;
    saveSettings(); render();
  };
  host.appendChild(lab);
  seg(host, [["centered", "centred"], ["trailing", "trailing"]], S.align, (v) => { S.align = v; saveSettings(); render(); });
}

function ctlGap(host) {
  seg(host, [["fifths", "circle of 5ths"], ["semitones", "half steps"]], S.gapMode, (v) => { S.gapMode = v; saveSettings(); render(); });
  seg(host, [[true, "weighted"], [false, "top only"]], S.gapWeighted, (v) => { S.gapWeighted = v; saveSettings(); render(); });
}

// ------------------------------------------------------------------ drawing

const tx = (t) => (t - S.view.t0) * S.view.pps;

function setupCanvas(canvas) {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
    canvas.width = w * dpr; canvas.height = h * dpr;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return [ctx, w, h];
}

function eachBeat(w, fn) {
  for (const b of beats()) {
    const x0 = tx(b.t0), x1 = tx(b.t1);
    if (x1 < 0 || x0 > w) continue;
    fn(b, x0, x1);
  }
}

function grid(ctx, w, h) {
  ctx.lineWidth = 1;
  eachBeat(w, (b, x0) => {
    ctx.strokeStyle = b.beat === 1 ? C.bar : C.beat;
    ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, 0); ctx.lineTo(Math.round(x0) + 0.5, h); ctx.stroke();
  });
}

function clipText(ctx, text, x, y, maxW) {
  if (maxW < 8) return;
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y - 14, maxW, 20); ctx.clip();
  ctx.fillText(text, x, y);
  ctx.restore();
}

function render() {
  if (!A()) return;
  const r = $("#ruler");
  drawRuler(...setupCanvas(r.querySelector(".lane-body canvas")));
  setupCanvas(r.querySelector(".lane-axis canvas"));
  document.querySelectorAll("#lanes .lane").forEach((el) => {
    const L = LANES[el.dataset.id];
    const [ctx, w, h] = setupCanvas(el.querySelector(".lane-body canvas"));
    if (!L.noGrid) grid(ctx, w, h);
    L.draw(ctx, w, h);
    const [actx, aw, ah] = setupCanvas(el.querySelector(".lane-axis canvas"));
    if (L.axis) L.axis(actx, aw, ah);
  });
  placeLines();
  updateReadout();
}

function drawRuler(ctx, w, h) {
  ctx.font = "10px ui-monospace, Menlo, monospace";
  ctx.textBaseline = "middle";
  eachBeat(w, (b, x0) => {
    const xb = Math.round(x0) + 0.5;
    ctx.strokeStyle = b.beat === 1 ? "#444" : "#222";
    ctx.beginPath(); ctx.moveTo(xb, b.beat === 1 ? 0 : h - 6); ctx.lineTo(xb, h); ctx.stroke();
    if (b.beat === 1) {
      ctx.fillStyle = C.dim;
      ctx.fillText(String(b.bar), xb + 4, h / 2);
    }
  });
}

function drawRoll(ctx, w, h) {
  const notes = S.data.notes;
  if (!notes.length) return;
  let lo = 127, hi = 0;
  for (const n of notes) { lo = Math.min(lo, n[2]); hi = Math.max(hi, n[2]); }
  lo -= 2; hi += 2;
  S.rollRange = [lo, hi];
  const rh = h / (hi - lo + 1);
  ctx.strokeStyle = "#141414";
  for (let p = lo; p <= hi; p++) if (p % 12 === 0) {
    const y = Math.round((hi - p + 1) * rh) + 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
  }
  for (const [s, e, p, v] of notes) {
    const x0 = tx(s), x1 = tx(e);
    if (x1 < 0 || x0 > w) continue;
    ctx.fillStyle = `rgba(255,255,255,${0.25 + 0.75 * v / 127})`;
    ctx.fillRect(x0, (hi - p) * rh + 0.5, Math.max(1, x1 - x0 - 1), Math.max(1, rh - 1));
  }
}

function axisRoll(ctx, w, h) {
  if (!S.rollRange) return;
  const [lo, hi] = S.rollRange, rh = h / (hi - lo + 1);
  ctx.font = "9px ui-monospace, Menlo, monospace"; ctx.fillStyle = C.faint; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let p = lo; p <= hi; p++) if (p % 12 === 0) ctx.fillText("C" + (p / 12 - 1), w - 5, (hi - p + 0.5) * rh);
}

function runs(get) {
  // merge consecutive beats with the same value
  const out = [];
  for (const b of beats()) {
    const v = get(b);
    const last = out[out.length - 1];
    if (last && last.v === v) last.t1 = b.t1;
    else out.push({ v, t0: b.t0, t1: b.t1, b });
  }
  return out;
}

function drawPosition(ctx, w, h) {
  const chart = A().info.chart_used;
  ctx.font = "500 13px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
  ctx.textBaseline = "alphabetic";
  for (const r of runs((b) => b.chord.label + "|" + b.chord.source)) {
    const x0 = tx(r.t0), x1 = tx(r.t1);
    if (x1 < 0 || x0 > w) continue;
    ctx.fillStyle = C.text;
    ctx.globalAlpha = r.b.chord.source === "chart" ? 1 : 0.35 + 0.65 * r.b.chord.conf;
    ctx.fillRect(Math.round(x0) + 1, 6, 1, 18);
    const lx = Math.max(x0, 0);  // keep the label visible when the chord began off-screen
    clipText(ctx, fmt(r.b.chord.label), lx + 6, 21, x1 - lx - 8);
    ctx.globalAlpha = 1;
  }
  if (!chart) return;
  ctx.font = "11px -apple-system, BlinkMacSystemFont, Inter, sans-serif";
  for (const r of runs((b) => b.detected.label)) {
    const x0 = tx(r.t0), x1 = tx(r.t1);
    if (x1 < 0 || x0 > w) continue;
    const agree = r.b.detected.root === r.b.chord.root && r.b.detected.quality === r.b.chord.quality;
    ctx.fillStyle = agree ? C.faint : C.disagree;
    const lx = Math.max(x0, 0);
    clipText(ctx, fmt(r.v) + " " + pct(r.b.detected.conf), lx + 6, 44, x1 - lx - 8);
  }
}

function drawHeading(ctx, w, h) {
  ctx.textBaseline = "alphabetic";
  for (const r of runs((b) => JSON.stringify(b.heading) + b.chord.label)) {
    const x0 = tx(r.t0), x1 = tx(r.t1);
    if (x1 < 0 || x0 > w || !r.b.heading.length) continue;
    const span = x1 - x0 - 3;
    r.b.heading.forEach((c, k) => {
      const y = k === 0 ? 6 : 34, bh = k === 0 ? 22 : 18;
      ctx.fillStyle = k === 0 ? "rgba(255,138,61,.28)" : "rgba(255,138,61,.14)";
      ctx.fillRect(x0 + 2, y, Math.max(1, span * c.w), bh);
      ctx.fillStyle = k === 0 ? C.text : C.dim;
      ctx.font = k === 0 ? "500 12px -apple-system, Inter, sans-serif" : "11px -apple-system, Inter, sans-serif";
      const full = `${fmt(c.name)}  ${pct(c.w)}`;
      const txt = ctx.measureText(full).width <= span - 6 ? full : fmt(c.name);
      const lx = Math.max(x0, 0);
      clipText(ctx, txt, lx + 6, y + bh - 6, x1 - lx - 7);
    });
  }
}

function drawLocalHome(ctx, w, h) {
  const L = local();
  const rh = h / 24;
  const rowOf = {};
  KEY_ROWS.forEach((k, r) => (rowOf[k] = r));
  eachBeat(w, (b, x0, x1) => {
    const p = L.probs[b.i];
    for (let r = 0; r < 24; r++) {
      const a = Math.min(1, p[KEY_ROWS[r]] / 0.35);
      if (a < 0.03) continue;
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.fillRect(x0, r * rh, Math.max(1, x1 - x0 - 0.5), rh - 0.5);
    }
    if (b.heading.length) {
      const r = rowOf[b.heading[0].key];
      ctx.fillStyle = C.tension;
      ctx.beginPath(); ctx.arc((x0 + x1) / 2, (r + 0.5) * rh, Math.min(2.5, rh / 3), 0, 7); ctx.fill();
    }
  });
  const hr = rowOf[homeKey()];
  ctx.strokeStyle = C.tension; ctx.lineWidth = 1;
  ctx.strokeRect(0.5, hr * rh + 0.5, w - 1, rh - 1);
}

function axisKeys(ctx, w, h) {
  const rh = h / 24;
  ctx.font = `${Math.min(9, rh)}px -apple-system, Inter, sans-serif`;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  KEY_ROWS.forEach((k, r) => {
    ctx.fillStyle = k === homeKey() ? C.tension : k < 12 ? C.dim : C.faint;
    ctx.fillText(fmt(keyName(k)), w - 5, (r + 0.5) * rh);
  });
}

function axisRows(ctx, w, h, labels) {
  const rh = h / labels.length;
  ctx.font = `${Math.min(9, rh)}px -apple-system, Inter, sans-serif`;
  ctx.textAlign = "right"; ctx.textBaseline = "middle"; ctx.fillStyle = C.dim;
  labels.forEach((l, r) => ctx.fillText(fmt(l), w - 5, (r + 0.5) * rh));
}

function axisNum(ctx, w, h, lo, hi, ticks, pad = 6) {
  ctx.font = "9px ui-monospace, Menlo, monospace"; ctx.fillStyle = C.faint;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (const t of ticks) ctx.fillText(String(t), w - 5, h - pad - ((t - lo) / (hi - lo)) * (h - 2 * pad));
}

function stepLine(ctx, w, h, get, lo, hi, color, width = 1.25, pad = 6) {
  const y = (v) => h - pad - ((v - lo) / (hi - lo)) * (h - 2 * pad);
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.lineJoin = "round";
  ctx.beginPath();
  let pen = false;
  eachBeat(w, (b, x0, x1) => {
    const v = get(b);
    if (v == null) { pen = false; return; }
    if (!pen) { ctx.moveTo(x0, y(v)); pen = true; } else ctx.lineTo(x0, y(v));
    ctx.lineTo(x1, y(v));
  });
  ctx.stroke();
}

function gapValue(b, mode, weighted) {
  const k = "gap_" + mode + (weighted ? "" : "_top");
  return b[k];
}

function drawGap(ctx, w, h) {
  const other = S.gapMode === "fifths" ? "semitones" : "fifths";
  stepLine(ctx, w, h, (b) => gapValue(b, other, S.gapWeighted), 0, 6, "#3a3a3a", 1);
  stepLine(ctx, w, h, (b) => gapValue(b, S.gapMode, S.gapWeighted), 0, 6, C.tension, 1.5);
  eachBeat(w, (b, x0) => {
    if (!b.arrival) return;
    ctx.strokeStyle = b.home_arrival ? C.arrive : "#777";
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0 + 1, h); ctx.lineTo(x0 + 1, h - 4 - 14 * b.arrival); ctx.stroke();
  });
}

function drawConfidence(ctx, w, h) {
  const L = local();
  stepLine(ctx, w, h, (b) => L.confidence[b.i], 0, 1, C.sure);
}

function roughMax() {
  let m = 0;
  for (const b of beats()) m = Math.max(m, b.roughness);
  return m * 1.1 || 1;
}

function drawRoughness(ctx, w, h) {
  stepLine(ctx, w, h, (b) => b.roughness, 0, roughMax(), C.rough, 1.25);
}

function axisRough(ctx, w, h) {
  const m = roughMax();
  axisNum(ctx, w, h, 0, m, [0, +(m).toFixed(1)]);
}

function drawJevStatus(ctx, w, h) {
  const st = (S.jev && S.jev.status) || (S.status && S.status.jev) || { message: "not connected" };
  ctx.fillStyle = C.faint; ctx.font = "12px -apple-system, Inter, sans-serif"; ctx.textBaseline = "middle";
  ctx.fillText(st.connected ? "connected — press “ask Jev” to fill these lanes" : st.message, 10, h / 2);
}

function drawJevHeat(ctx, w, h, field, rows) {
  const J = S.jev.beats;
  const rh = h / rows.length;
  eachBeat(w, (b, x0, x1) => {
    const d = J[b.i][field];
    rows.forEach((name, r) => {
      const a = Math.min(1, (d[name] || 0) / 0.6);
      if (a < 0.03) return;
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.fillRect(x0, r * rh, Math.max(1, x1 - x0 - 0.5), rh - 0.5);
    });
    const det = detAnswer(b, field);
    const r = rows.indexOf(det);
    if (r >= 0) {
      ctx.strokeStyle = jevArg(d)[0] === det ? "rgba(255,255,255,.9)" : C.disagree;
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x0 + 1, r * rh + 1, Math.max(1, x1 - x0 - 2.5), rh - 2);
    }
  });
}

function drawJevArrival(ctx, w, h) {
  const J = S.jev.beats;
  stepLine(ctx, w, h, (b) => J[b.i].is_arrival.yes, 0, 1, C.arrive);
  eachBeat(w, (b, x0) => {
    if (!b.arrival) return;
    ctx.strokeStyle = "#999"; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(x0 + 1, h); ctx.lineTo(x0 + 1, h - 10); ctx.stroke();
  });
}

const DIS_FIELDS = ["chord_root", "chord_function", "local_home", "heading", "is_arrival"];
function drawDisagree(ctx, w, h) {
  const J = S.jev.beats;
  const rh = h / DIS_FIELDS.length;
  eachBeat(w, (b, x0, x1) => {
    DIS_FIELDS.forEach((f, r) => {
      const same = jevArg(J[b.i][f])[0] === detAnswer(b, f);
      ctx.fillStyle = same ? "#151515" : C.disagree;
      ctx.fillRect(x0, r * rh + 1, Math.max(1, x1 - x0 - 1), rh - 2);
    });
  });
}

// ------------------------------------------------------------------ time / playback

function media() { return $("#player video, #player audio"); }
function bodyLeft() {
  const wrap = $("#lanes-wrap").getBoundingClientRect();
  const body = $("#ruler .lane-body").getBoundingClientRect();
  return [body.left - wrap.left, body.width];
}
function currentTime() { const m = media(); return m ? m.currentTime : 0; }

function placeLines() {
  if (!A()) return;
  const [left, width] = bodyLeft();
  const x = tx(currentTime());
  const ph = $("#playhead");
  ph.style.display = x >= 0 && x <= width ? "block" : "none";
  ph.style.left = left + x + "px";
  const hl = $("#hoverline");
  if (S.hoverT != null) {
    const hx = tx(S.hoverT);
    hl.style.display = hx >= 0 && hx <= width ? "block" : "none";
    hl.style.left = left + hx + "px";
  } else hl.style.display = "none";
}

function clampView() {
  const [, width] = bodyLeft();
  const dur = A() ? A().duration : 10;
  const span = width / S.view.pps;
  S.view.t0 = Math.max(-0.02 * span, Math.min(S.view.t0, Math.max(0, dur - span * 0.98)));
}

function fit() {
  const [, width] = bodyLeft();
  S.view.pps = width / (A().duration * 1.01);
  S.view.t0 = 0;
  render();
}

function zoom(factor, atT) {
  const [, width] = bodyLeft();
  if (atT == null) atT = S.view.t0 + width / S.view.pps / 2;
  const fx = (atT - S.view.t0) * S.view.pps;
  S.view.pps = Math.max(2, Math.min(800, S.view.pps * factor));
  S.view.t0 = atT - fx / S.view.pps;
  clampView(); render();
}

function tick() {
  const m = media();
  if (m && !m.paused && S.follow && A()) {
    const [, width] = bodyLeft();
    const x = tx(m.currentTime);
    if (x > width * 0.85 || x < 0) {
      S.view.t0 = m.currentTime - (width * 0.15) / S.view.pps;
      clampView(); render();
    }
  }
  placeLines();
  if (m && !m.paused) updateReadout();
  requestAnimationFrame(tick);
}

function beatAt(t) {
  const bs = beats();
  let lo = 0, hi = bs.length - 1;
  if (!bs.length) return null;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bs[mid].t0 <= t) lo = mid; else hi = mid - 1; }
  return bs[lo];
}

function updateReadout() {
  if (!A()) return;
  const t = S.hoverT != null ? S.hoverT : currentTime();
  const b = beatAt(t);
  if (!b) return;
  const L = local();
  const lk = L.best[b.i];
  const h = b.heading.map((c) => `${fmt(c.name)} ${pct(c.w)}`).join(" / ") || "–";
  const det = b.chord.source === "chart" ? ` <span>(detector: ${fmt(b.detected.label)} ${pct(b.detected.conf)})</span>` : ` ${pct(b.chord.conf)}`;
  let jv = "";
  if (S.jev && S.jev.beats) {
    const J = S.jev.beats[b.i];
    const [jr, jp] = jevArg(J.chord_root), [jh, jhp] = jevArg(J.heading);
    jv = ` · Jev: <b>${fmt(jr)}</b> ${pct(jp)}, heading <b>${fmt(jh)}</b> ${pct(jhp)}`;
  }
  $("#readout").innerHTML =
    `${t.toFixed(2)}s · bar <b>${b.bar}.${b.beat}</b> · <b>${fmt(b.chord.label)}</b>${det} · ${b.function} · heading <b>${h}</b>` +
    ` · gap ½-steps <b>${b.gap_semitones ?? "–"}</b> 5ths <b>${b.gap_fifths ?? "–"}</b>` +
    ` · local home (${S.window} bar) <b>${fmt(keyName(lk))}</b> ${pct(L.probs[b.i][lk])} · confidence <b>${L.confidence[b.i].toFixed(2)}</b>` +
    ` · roughness <b>${b.roughness.toFixed(2)}</b>${b.arrival ? ` · <b style="color:${b.home_arrival ? C.arrive : C.text}">arrival ${pct(b.arrival)}</b>` : ""}${jv}`;
}

// ------------------------------------------------------------------ data in

function busy(on, text) {
  $("#busy").hidden = !on;
  if (text) $("#busy-text").textContent = text;
}
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 9000);
}

async function api(path, body, raw, extraHeaders) {
  const opts = body === undefined ? {} : {
    method: "POST",
    headers: raw ? { "X-Filename": encodeURIComponent(raw), ...(extraHeaders || {}) } : { "Content-Type": "application/json" },
    body: raw ? body : JSON.stringify(body),
  };
  const r = await fetch(path, opts);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}

function params(extra) {
  const v = (id) => $(id).value.trim();
  return Object.assign({}, S.source, {
    chart: v("#chart"), tempo: v("#tempo") || null, beats_per_bar: +v("#bpb") || 4,
    chart_start: +v("#chart-start") || 0, chart_repeat: $("#chart-repeat").checked,
    beat_source: v("#beat-source"), home_override: v("#home") === "auto" ? null : +v("#home"),
  }, extra || {});
}

async function analyze(extra, busyText) {
  if (!S.source) return toast("Load a test or a file first.");
  busy(true, busyText || "Analysing…");
  try {
    const d = await api("/api/analyze", params(extra));
    const first = !S.data || S.data.session !== d.session;
    S.data = d;
    S.jev = d.jev && d.jev.beats ? d.jev : null;
    if (extra && extra.first_load && d.defaults) {
      if (d.defaults.chart != null) $("#chart").value = d.defaults.chart;
      if (d.defaults.tempo != null) $("#tempo").value = d.defaults.tempo;
    }
    showData(first);
  } catch (e) {
    toast(e.message);
  } finally { busy(false); }
}

function showData(first) {
  const d = S.data, a = d.analysis;
  $("#title").textContent = d.title;
  if (first) {
    const p = $("#player");
    p.innerHTML = "";
    const m = document.createElement(d.media.kind === "video" ? "video" : "audio");
    m.controls = true; m.preload = "auto"; m.src = d.media.url;
    m.addEventListener("seeked", () => { placeLines(); updateReadout(); });
    p.appendChild(m);
  }
  const ex = $("#expect");
  ex.hidden = !d.expect;
  if (d.expect) ex.innerHTML = `<b>Expected:</b> ${fmt(d.expect)}`;
  // home selector
  const sel = $("#home"), cur = sel.value;
  sel.innerHTML = `<option value="auto">auto (${fmt(a.global_home.auto_name)})</option>` +
    S.status.keys.map((k, i) => `<option value="${i}">${fmt(k)}</option>`).join("");
  sel.value = a.global_home.overridden ? String(a.global_home.key) : (cur && cur !== "auto" && !first ? cur : "auto");
  const info = a.info;
  $("#chip-trans").textContent = `${info.note_count} notes · ${info.beat_source} beats · ${info.tempo_bpm} BPM` +
    (info.transcriber ? ` · ${info.transcriber}` : "") + ` · home ${fmt(a.global_home.name)}`;
  $("#export-csv").href = `/api/export/${d.session}.csv`;
  $("#export-json").href = `/api/export/${d.session}.json`;
  $("#export-csv").classList.remove("disabled"); $("#export-json").classList.remove("disabled");
  updateJevChip();
  buildLanes();
  if (first) fit(); else render();
}

function updateJevChip() {
  const st = (S.jev && S.jev.status) || S.status.jev;
  const c = $("#chip-jev");
  c.textContent = "Jev: " + st.message;
  c.className = "chip" + (st.mock ? " mock" : st.connected ? " on" : "");
  $("#ask-jev").disabled = !st.connected || !S.data;
}

async function upload(files) {
  // One file, or a recording plus a MIDI of the same performance: then the
  // recording is what you hear and the MIDI's notes are what gets analysed.
  files = [...files];
  const midiOf = (f) => /\.midi?$/i.test(f.name);
  const media = files.find((f) => !midiOf(f));
  const pairMidi = media && files.find(midiOf);
  const file = media || files[0];
  $("#file-name").textContent = files.map((f) => f.name).join(" + ");
  const isMidi = midiOf(file) || !!pairMidi;
  busy(true, `Uploading ${file.name}…`);
  try {
    const up = await api("/api/upload", file, file.name);
    if (pairMidi) await api("/api/upload", pairMidi, pairMidi.name, { "X-Pair-With": up.upload });
    S.source = { upload: up.upload };
    $("#beat-source").value = "auto";
    await analyze({ first_load: true }, isMidi ? "Reading MIDI…" :
      "Extracting audio and transcribing to notes… with Transkun this takes a few minutes for a full tune (it's cached afterwards).");
  } catch (e) { toast(e.message); busy(false); }
}

async function askJev() {
  if (!S.data) return;
  busy(true, "Asking Jev…");
  try {
    const j = await api("/api/jev", { session: S.data.session });
    if (!j.beats) toast("Jev: " + j.status.message);
    S.jev = j.beats ? j : null;
    if (j.status) S.status.jev = j.status;
    updateJevChip(); buildLanes();
  } catch (e) { toast(e.message); } finally { busy(false); }
}

// ------------------------------------------------------------------ wiring

async function init() {
  S.status = await api("/api/status");
  const tb = $("#test-buttons");
  for (const [name, t] of Object.entries(S.status.tests)) {
    const b = document.createElement("button");
    b.className = "btn"; b.textContent = t.title.replace(/^Test \d+ · /, "Test " + (tb.children.length + 1) + " · ");
    b.onclick = () => { S.source = { test: name }; $("#beat-source").value = "auto"; $("#chart-start").value = 0; $("#home").value = "auto"; analyze({ first_load: true, home_override: null }); };
    tb.appendChild(b);
  }
  $("#chip-trans").textContent = S.status.transcriber ? `transcriber: ${S.status.transcriber}` : "no transcriber (tests + MIDI work)";
  $("#home").innerHTML = `<option value="auto">auto</option>`;
  $("#export-csv").classList.add("disabled"); $("#export-json").classList.add("disabled");
  updateJevChip();
  $("#follow").checked = S.follow;
  buildLaneMenu();

  $("#file").addEventListener("change", (e) => e.target.files.length && upload(e.target.files));
  $("#analyze").onclick = () => analyze();
  $("#home").onchange = () => S.data && analyze();
  $("#zoom-in").onclick = () => zoom(1.5);
  $("#zoom-out").onclick = () => zoom(1 / 1.5);
  $("#zoom-fit").onclick = () => A() && fit();
  $("#follow").onchange = (e) => { S.follow = e.target.checked; saveSettings(); };
  $("#ask-jev").onclick = askJev;
  $("#lanes-btn").onclick = (e) => { e.stopPropagation(); $("#lanes-menu").hidden = !$("#lanes-menu").hidden; };
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) $("#lanes-menu").hidden = true; });

  const wrap = $("#lanes-wrap");
  const tAt = (e) => {
    const [left] = bodyLeft();
    const x = e.clientX - wrap.getBoundingClientRect().left - left;
    return x < 0 ? null : S.view.t0 + x / S.view.pps;
  };
  wrap.addEventListener("click", (e) => {
    if (!A() || !e.target.closest(".lane-body")) return;
    const t = tAt(e), m = media();
    if (t != null && m) { m.currentTime = Math.max(0, t); placeLines(); }
  });
  wrap.addEventListener("mousemove", (e) => {
    if (!A()) return;
    S.hoverT = e.target.closest(".lane-body") ? tAt(e) : null;
    placeLines(); updateReadout();
  });
  wrap.addEventListener("mouseleave", () => { S.hoverT = null; placeLines(); updateReadout(); });
  wrap.addEventListener("wheel", (e) => {
    if (!A() || !e.target.closest(".lane-body")) return;
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      zoom(Math.exp(-e.deltaY * 0.01), tAt(e));
    } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) || e.shiftKey) {
      e.preventDefault();
      const d = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      S.view.t0 += d / S.view.pps;
      clampView(); render();
    }
  }, { passive: false });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, textarea, select")) return;
    const m = media();
    if (!m) return;
    if (e.code === "Space") { e.preventDefault(); m.paused ? m.play() : m.pause(); }
    if (e.code === "ArrowRight" || e.code === "ArrowLeft") {
      e.preventDefault();
      const b = beatAt(m.currentTime + 1e-3);
      if (!b) return;
      const bs = beats(), step = e.shiftKey ? A().beats_per_bar : 1;
      const i = Math.max(0, Math.min(bs.length - 1, b.i + (e.code === "ArrowRight" ? step : -step)));
      m.currentTime = bs[i].t0;
    }
  });
  window.addEventListener("resize", () => render());
  requestAnimationFrame(tick);

  // ?test=name or ?upload=id in the URL loads it straight away (handy for
  // screenshots); add &jev=1 to ask Jev too.
  const q = new URLSearchParams(location.search);
  if (q.get("test") || q.get("upload")) {
    S.source = q.get("test") ? { test: q.get("test") } : { upload: q.get("upload") };
    await analyze({ first_load: true, home_override: q.get("home") ? +q.get("home") : null });
    if (q.get("jev") || q.get("mockjev")) await askJev();
  }
}

init().catch((e) => toast("Couldn't start: " + e.message));
