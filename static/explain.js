// Step-by-step explainers behind the ⓘ buttons.
// Each explainer is a list of steps; a step draws into an SVG stage (with
// CSS transitions for movement) and can play a few notes so you hear it too.
(function () {
  const NS = "http://www.w3.org/2000/svg";
  const NAMES = ["C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B"];
  const COL = { home: "#ff8a3d", play: "#6fb7ff", good: "#7dffb0", bad: "#ff4d6d", dim: "#8a8a8a", text: "#e8e8e8", line: "#333" };
  const W = 760, H = 320;

  // ------------------------------------------------------------ tiny helpers
  function el(tag, attrs, parent, text) {
    const e = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    if (text != null) e.textContent = text;
    if (parent) parent.appendChild(e);
    return e;
  }
  let timers = [];
  const later = (ms, fn) => timers.push(setTimeout(fn, ms));
  const clearTimers = () => { timers.forEach(clearTimeout); timers = []; };
  const label = (svg, x, y, t, o = {}) =>
    el("text", { x, y, fill: o.fill || COL.text, "font-size": o.size || 16, "text-anchor": o.anchor || "middle",
      "font-weight": o.weight || 400, "font-family": "-apple-system, Segoe UI, Inter, sans-serif", ...(o.attrs || {}) }, svg, t);
  const fadeIn = (e, delay = 0) => { e.style.opacity = 0; e.style.transition = "opacity .5s"; later(30 + delay, () => (e.style.opacity = 1)); return e; };

  // A piano keyboard from midi lo to hi. Returns {key(midi) -> {rect, cx, top}}.
  function keyboard(svg, x, y, w, lo, hi, h = 110) {
    const isBlack = (m) => [1, 3, 6, 8, 10].includes(m % 12);
    const whites = []; for (let m = lo; m <= hi; m++) if (!isBlack(m)) whites.push(m);
    const ww = w / whites.length, keys = {};
    whites.forEach((m, i) => {
      const r = el("rect", { x: x + i * ww, y, width: ww - 1.5, height: h, rx: 3, fill: "#ddd" }, svg);
      keys[m] = { rect: r, cx: x + i * ww + ww / 2, top: y + h - 18, base: "#ddd" };
    });
    for (let m = lo; m <= hi; m++) if (isBlack(m)) {
      const left = whites.indexOf(m - 1);
      if (left < 0) continue;
      const bx = x + (left + 1) * ww - ww * 0.32;
      const r = el("rect", { x: bx, y, width: ww * 0.64, height: h * 0.62, rx: 2, fill: "#222", stroke: "#000" }, svg);
      keys[m] = { rect: r, cx: bx + ww * 0.32, top: y + h * 0.62 - 14, base: "#222" };
    }
    Object.values(keys).forEach((k) => (k.rect.style.transition = "fill .35s"));
    return keys;
  }
  const lightKey = (keys, m, color, delay = 0) => later(delay, () => keys[m] && keys[m].rect.setAttribute("fill", color));

  // 12 boxes, one per note name. Returns centre x of each.
  function slots(svg, y, opts = {}) {
    const x0 = 80, sw = (W - 160) / 12, cx = [];
    for (let i = 0; i < 12; i++) {
      el("rect", { x: x0 + i * sw + 2, y, width: sw - 4, height: 34, rx: 5, fill: "#111", stroke: COL.line }, svg);
      label(svg, x0 + i * sw + sw / 2, y + 54, NAMES[i], { size: 13, fill: COL.dim });
      cx.push(x0 + i * sw + sw / 2);
    }
    return { cx, sw, y, x0 };
  }

  function chordBox(svg, x, y, text, color = COL.text, w = 120) {
    const g = el("g", {}, svg);
    el("rect", { x: x - w / 2, y: y - 30, width: w, height: 48, rx: 8, fill: "#151515", stroke: color, "stroke-width": 2 }, g);
    label(g, x, y + 2, text, { size: 22, weight: 600, fill: color });
    return g;
  }
  function arrow(svg, x1, y, x2, color = COL.dim) {
    const g = el("g", {}, svg);
    el("line", { x1, y1: y, x2: x2 - 8, y2: y, stroke: color, "stroke-width": 3 }, g);
    el("path", { d: `M${x2} ${y} l-12 -7 v14 z`, fill: color }, g);
    return g;
  }

  // ------------------------------------------------------------ sound
  let ac = null, muted = false;
  async function play(seq) {  // seq: [[time_s, [midi...], dur_s], ...]
    if (muted || !seq) return;
    try {
      ac = ac || new (window.AudioContext || window.webkitAudioContext)();
      if (ac.state !== "running") await ac.resume();  // some browsers start it paused
    } catch (e) { return note("Your browser blocked sound. Click “hear it” again."); }
    if (ac.state !== "running") return note("Your browser blocked sound. Click “hear it” again.");
    const out = ac.createGain(); out.gain.value = 0.9; out.connect(ac.destination);
    const t0 = ac.currentTime + 0.05;
    let end = 0;
    for (const [at, notes, dur] of seq) for (const m of notes) {
      const d = dur || 1.2, f = 440 * Math.pow(2, (m - 69) / 12), v = 0.32 / Math.sqrt(notes.length);
      // two oscillators (warm + bright) with a quick attack and a piano-like fade
      for (const [type, mul, lvl] of [["triangle", 1, 1], ["sine", 2, 0.35]]) {
        const o = ac.createOscillator(), g = ac.createGain();
        o.type = type; o.frequency.value = f * mul;
        g.gain.setValueAtTime(0.0001, t0 + at);
        g.gain.exponentialRampToValueAtTime(v * lvl, t0 + at + 0.012);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + d);
        o.connect(g).connect(out); o.start(t0 + at); o.stop(t0 + at + d + 0.05);
      }
      end = Math.max(end, at + d);
    }
    const hb = document.querySelector("#explain .ex-hear");
    if (hb) { hb.textContent = "♪ playing…"; later(end * 1000, () => (hb.textContent = "▶ hear it")); }
  }
  function note(msg) { const t = document.querySelector("#explain .ex-text"); if (t) t.textContent = msg; }

  // ------------------------------------------------------------ the explainers
  const EbM7 = [39, 51, 54, 58, 61];             // E♭m7 with a low E♭ in the bass
  const Ab7 = [44, 56, 60, 63, 66], Db = [49, 61, 65, 68, 72], Amaj = [45, 57, 61, 64, 68];

  const EXPLAIN = {
    chord: {
      title: "Chord: how it's worked out",
      steps: [
        {
          text: "On every beat, the app looks at which piano keys are being played. Here, five keys are down.",
          sound: [[0, EbM7, 1.6]],
          draw(svg) {
            const k = keyboard(svg, 40, 40, 680, 36, 72);
            EbM7.forEach((m, i) => lightKey(k, m, COL.play, 200 + i * 180));
          },
        },
        {
          text: "The octave doesn't matter: a low E♭ and a high E♭ are both just \"E♭\". So the notes drop into 12 boxes, one per note name.",
          draw(svg) {
            const k = keyboard(svg, 40, 20, 680, 36, 72, 90);
            const s = slots(svg, 220);
            EbM7.forEach((m, i) => {
              k[m].rect.setAttribute("fill", COL.play);
              const c = el("circle", { cx: k[m].cx, cy: k[m].top, r: 9, fill: COL.play }, svg);
              c.style.transition = "transform 1s ease-in-out";
              later(400 + i * 150, () => (c.style.transform = `translate(${s.cx[m % 12] - k[m].cx}px, ${s.y + 17 - k[m].top}px)`));
            });
          },
        },
        {
          text: "Next it tries chord shapes, like stencils, in every position (major, minor, 7th…) and counts how many of the played notes each one covers.",
          draw(svg) {
            const s = slots(svg, 150);
            [3, 6, 10, 1].forEach((pc) => el("circle", { cx: s.cx[pc], cy: s.y + 17, r: 9, fill: COL.play }, svg));
            const tries = [
              { name: "G♭ major", pcs: [6, 10, 1] },
              { name: "C minor", pcs: [0, 3, 7] },
              { name: "B♭ minor", pcs: [10, 1, 5] },
              { name: "E♭ minor 7", pcs: [3, 6, 10, 1] },
            ];
            const g = el("g", {}, svg), title = label(svg, W / 2, 110, "", { size: 20 });
            tries.forEach((t, i) => later(500 + i * 1300, () => {
              g.innerHTML = "";
              const hit = t.pcs.filter((p) => [3, 6, 10, 1].includes(p)).length;
              const best = i === tries.length - 1;
              t.pcs.forEach((p) => el("rect", { x: s.cx[p] - s.sw / 2 + 1, y: s.y - 4, width: s.sw - 2, height: 42, rx: 7,
                fill: "none", stroke: best ? COL.good : COL.home, "stroke-width": 3 }, g));
              title.textContent = `${t.name}: covers ${hit} of 4 played notes`;
              title.setAttribute("fill", best ? COL.good : COL.text);
            }));
          },
        },
        {
          text: "The shape that fits best wins: that's the name in the Chord row. A matching bass note gives a small bonus. Jazz pianists often leave out a chord's bottom note, so the guess can be wrong; a chord chart fixes that.",
          sound: [[0, EbM7, 1.8]],
          draw(svg) {
            fadeIn(label(svg, W / 2, 150, "E♭m7", { size: 64, weight: 700, fill: COL.good }));
            fadeIn(label(svg, W / 2, 200, "E♭ minor 7", { size: 20, fill: COL.dim }), 300);
          },
        },
      ],
    },

    key: {
      title: "Key right now: how it's worked out",
      steps: [
        {
          text: "Every key has a family of 7 notes it uses most. The D♭ key's family: D♭ E♭ F G♭ A♭ B♭ C.",
          sound: [61, 63, 65, 66, 68, 70, 72, 73].map((m, i) => [i * 0.28, [m], 0.5]),
          draw(svg) {
            const k = keyboard(svg, 140, 50, 480, 60, 84, 130);
            [61, 63, 65, 66, 68, 70, 72, 73].forEach((m, i) => lightKey(k, m, COL.home, 100 + i * 280));
          },
        },
        {
          text: "The app counts how much each note name was played over the last few bars.",
          draw(svg) {
            const s = slots(svg, 250);
            COUNTS.forEach((c, i) => {
              const r = el("rect", { x: s.cx[i] - 14, y: s.y - 4, width: 28, height: 0, rx: 3, fill: COL.play }, svg);
              r.style.transition = "all .9s ease-out";
              later(200 + i * 60, () => { r.setAttribute("y", s.y - 4 - c * 20); r.setAttribute("height", c * 20); });
            });
          },
        },
        {
          text: "Then it lays each key's family over those counts. The family that covers the most of what was played is the key right now. (It also gives extra weight to a key's home note.)",
          draw(svg) {
            const s = slots(svg, 250);
            COUNTS.forEach((c, i) => el("rect", { x: s.cx[i] - 14, y: s.y - 4 - c * 20, width: 28, height: c * 20, rx: 3, fill: COL.play }, svg));
            const tries = [["C", 0], ["A♭", 8], ["E", 4], ["D♭", 1]];
            const g = el("g", {}, svg), title = label(svg, W / 2, 34, "", { size: 20 });
            const total = COUNTS.reduce((a, b) => a + b, 0);
            tries.forEach(([name, tonic], i) => later(400 + i * 1300, () => {
              g.innerHTML = "";
              const fam = [0, 2, 4, 5, 7, 9, 11].map((d) => (tonic + d) % 12);
              const fit = Math.round(100 * fam.reduce((a, p) => a + COUNTS[p], 0) / total);
              const best = i === tries.length - 1;
              fam.forEach((p) => el("rect", { x: s.cx[p] - s.sw / 2 + 1, y: 50, width: s.sw - 2, height: s.y - 12, rx: 6,
                fill: "none", stroke: best ? COL.good : COL.home, "stroke-width": 2.5 }, g));
              title.textContent = `${name} family covers ${fit}% of the notes`;
              title.setAttribute("fill", best ? COL.good : COL.text);
            }));
          },
        },
        {
          text: "That window slides along the song beat by beat, so the key can change mid-song. That's the Key right now row.",
          draw(svg) {
            const segs = [["D♭", 0, 0.3], ["E", 0.3, 0.45], ["D♭", 0.45, 0.8], ["A♭", 0.8, 1]];
            const x0 = 60, w = W - 120;
            segs.forEach(([k, a, b]) => {
              el("rect", { x: x0 + a * w + 1, y: 200, width: (b - a) * w - 2, height: 44, rx: 6, fill: k === "D♭" ? "#3a2312" : "#1a1a1a" }, svg);
              label(svg, x0 + (a + b) / 2 * w, 228, k, { size: 18, fill: k === "D♭" ? COL.home : COL.text });
            });
            for (let i = 0; i < 40; i++) el("rect", { x: x0 + i * w / 40 + 2, y: 120, width: w / 40 - 4, height: 30, rx: 3, fill: "#222" }, svg);
            label(svg, x0, 105, "the song, beat by beat", { size: 13, fill: COL.dim, anchor: "start" });
            const win = el("rect", { x: x0, y: 112, width: w * 0.16, height: 46, rx: 6, fill: "none", stroke: COL.play, "stroke-width": 3 }, svg);
            win.style.transition = "transform 4s linear";
            later(300, () => (win.style.transform = `translateX(${w * 0.84}px)`));
          },
        },
      ],
    },

    tension: {
      title: "Tension: how it's worked out",
      steps: [
        {
          text: "Some chords sound like they want to move on. Play A♭7 and your ear expects D♭ next.",
          sound: [[0, Ab7, 1.3], [1.4, Db, 1.8]],
          draw(svg) {
            chordBox(svg, 230, 160, "A♭7", COL.play);
            fadeIn(arrow(svg, 300, 150, 450), 900);
            fadeIn(chordBox(svg, 530, 160, "D♭", COL.home), 1400);
          },
        },
        {
          text: "So for every chord, the app works out where it's pointing, using a few simple rules like these.",
          draw(svg) {
            const rows = [
              ["A♭7", "D♭", "a 7th chord points 5 notes down"],
              ["D7", "D♭", "…or one key down (a jazz swap)"],
              ["E♭m7", "D♭", "a minor 7th points one step down"],
              ["D♭", "D♭", "a plain major chord rests where it is"],
            ];
            rows.forEach(([a, b, why], i) => {
              const g = el("g", {}, svg), y = 60 + i * 66;
              label(g, 120, y, a, { size: 22, weight: 600, fill: COL.play });
              arrow(g, 170, y - 7, 250);
              label(g, 290, y, b, { size: 22, weight: 600, fill: COL.home });
              label(g, 340, y, why, { size: 16, fill: COL.dim, anchor: "start" });
              fadeIn(g, i * 600);
            });
          },
        },
        {
          text: "Tension is how far that destination is from home (D♭), counted in piano keys the short way round. E is 3 keys from D♭, so the tension is 3.",
          draw(svg) {
            const k = keyboard(svg, 140, 60, 480, 60, 72, 140);
            k[61].rect.setAttribute("fill", COL.home); k[64].rect.setAttribute("fill", COL.play);
            label(svg, k[61].cx, 40, "home", { size: 14, fill: COL.home });
            label(svg, k[64].cx, 40, "destination", { size: 14, fill: COL.play });
            [62, 63, 64].forEach((m, i) => later(500 + i * 600, () => {
              el("path", { d: `M${k[m - 1].cx} 220 Q ${(k[m - 1].cx + k[m].cx) / 2} 260 ${k[m].cx} 220`, fill: "none", stroke: COL.text, "stroke-width": 2 }, svg);
              label(svg, (k[m - 1].cx + k[m].cx) / 2, 275, String(i + 1), { size: 18, weight: 600 });
            }));
            fadeIn(label(svg, W / 2, 310, "tension = 3", { size: 20, weight: 600, fill: COL.play }), 2300);
          },
        },
        {
          text: "In \"Ask Me Now\", each pair of chords points one key closer to home, so the tension steps down: 4, 3, 2, 1, 0. Home.",
          sound: [[0, [55, 58, 62, 65], 0.5], [0.5, [48, 52, 55, 58], 0.5], [1.0, [54, 57, 61, 64], 0.5], [1.5, [47, 51, 54, 57], 0.5],
                  [2.0, [53, 56, 60, 63], 0.5], [2.5, [46, 50, 53, 56], 0.5], [3.0, [52, 55, 59, 62], 0.5], [3.5, [45, 49, 52, 55], 0.5],
                  [4.0, [51, 54, 58, 61], 0.5], [4.5, [44, 48, 51, 54], 0.5], [5.0, [49, 53, 56, 60], 1.8]],
          draw(svg) {
            const pairs = [["G-7 C7", "F", 4], ["F♯-7 B7", "E", 3], ["F-7 B♭7", "E♭", 2], ["E-7 A7", "D", 1], ["E♭-7 A♭7", "D♭", 0]];
            pairs.forEach(([ch, dest, g], i) => {
              const x = 110 + i * 135;
              const bar = el("rect", { x: x - 30, y: 250, width: 60, height: 0, rx: 4, fill: g ? COL.home : COL.good }, svg);
              bar.style.transition = "all .5s";
              later(i * 1000, () => { bar.setAttribute("y", 250 - g * 40 - 4); bar.setAttribute("height", g * 40 + 4); });
              fadeIn(label(svg, x, 280, ch, { size: 14 }), i * 1000);
              fadeIn(label(svg, x, 302, "→ " + dest, { size: 14, fill: COL.dim }), i * 1000);
              fadeIn(label(svg, x, 240 - g * 40, String(g), { size: 18, weight: 600 }), i * 1000 + 300);
            });
          },
        },
      ],
    },

    home: {
      title: "Lands home: how it's worked out",
      steps: [
        {
          text: "A♭7 points at D♭, and D♭ is home.",
          sound: [[0, Ab7, 1.5]],
          draw(svg) {
            chordBox(svg, 230, 160, "A♭7", COL.play);
            fadeIn(arrow(svg, 300, 150, 450, COL.home), 400);
            fadeIn(label(svg, 530, 168, "D♭ (home)?", { size: 22, fill: COL.home }), 700);
          },
        },
        {
          text: "If the next chord really is D♭, the music has landed home. That gets a green mark.",
          sound: [[0, Ab7, 1.2], [1.3, Db, 2]],
          draw(svg) {
            chordBox(svg, 230, 160, "A♭7", COL.play);
            arrow(svg, 300, 150, 450);
            fadeIn(chordBox(svg, 530, 160, "D♭", COL.good), 1300);
            fadeIn(label(svg, 530, 230, "✓ landed", { size: 20, weight: 600, fill: COL.good }), 1600);
          },
        },
        {
          text: "If it goes somewhere else instead, that's a surprise move, not a landing. No mark.",
          sound: [[0, Ab7, 1.2], [1.3, Amaj, 2]],
          draw(svg) {
            chordBox(svg, 230, 160, "A♭7", COL.play);
            arrow(svg, 300, 150, 450);
            fadeIn(chordBox(svg, 530, 160, "A", COL.bad), 1300);
            fadeIn(label(svg, 530, 230, "surprise, no mark", { size: 20, fill: COL.bad }), 1600);
          },
        },
        {
          text: "Each green mark in the Lands home row is one landing; taller means clearer. Grey marks are landings in some other key.",
          draw(svg) {
            el("line", { x1: 60, y1: 240, x2: W - 60, y2: 240, stroke: COL.line }, svg);
            [[0.12, 1, 1], [0.3, 0.5, 0], [0.47, 0.8, 1], [0.62, 0.4, 0], [0.8, 1, 1], [0.93, 0.6, 1]].forEach(([p, hgt, home], i) => {
              const x = 60 + p * (W - 120);
              const r = el("rect", { x: x - 5, y: 240, width: 10, height: 0, rx: 2, fill: home ? COL.good : COL.dim }, svg);
              r.style.transition = "all .4s";
              later(200 + i * 300, () => { r.setAttribute("y", 240 - hgt * 120); r.setAttribute("height", hgt * 120); });
            });
            label(svg, 60, 270, "the song →", { size: 13, fill: COL.dim, anchor: "start" });
          },
        },
      ],
    },
  };
  // made-up note counts for a passage in D♭ (C, D♭, D, E♭, E, F, G♭, G, A♭, A, B♭, B)
  const COUNTS = [4, 9, 1, 7, 1, 8, 5, 1, 9, 2, 6, 1];

  // ------------------------------------------------------------ the dialog
  let cur = null, idx = 0;
  function render() {
    clearTimers();
    const box = document.getElementById("explain");
    const ex = EXPLAIN[cur], st = ex.steps[idx];
    box.querySelector(".ex-title").textContent = ex.title;
    box.querySelector(".ex-text").textContent = st.text;
    box.querySelector(".ex-count").textContent = `Step ${idx + 1} of ${ex.steps.length}`;
    box.querySelector(".ex-back").disabled = idx === 0;
    box.querySelector(".ex-next").textContent = idx === ex.steps.length - 1 ? "Done" : "Next →";
    box.querySelector(".ex-hear").hidden = !st.sound;
    box.querySelector(".ex-hear").textContent = "▶ hear it";
    const svg = box.querySelector("svg");
    svg.innerHTML = "";
    st.draw(svg);
    play(st.sound);
  }
  function build() {
    const d = document.createElement("div");
    d.id = "explain"; d.hidden = true;
    d.innerHTML = `
      <div class="ex-card" role="dialog" aria-modal="true">
        <div class="ex-head"><div class="ex-title"></div><button class="ex-x" title="Close">×</button></div>
        <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet"></svg>
        <p class="ex-text"></p>
        <div class="ex-foot">
          <span class="ex-count"></span>
          <span class="ex-btns">
            <button class="btn ex-hear">▶ hear it</button>
            <button class="btn ex-mute"></button>
            <button class="btn ex-replay">↻ replay</button>
            <button class="btn ex-back">← Back</button>
            <button class="btn primary ex-next"></button>
          </span>
        </div>
      </div>`;
    document.body.appendChild(d);
    const close = () => { clearTimers(); d.hidden = true; };
    const muteLabel = () => (d.querySelector(".ex-mute").textContent = muted ? "sound off" : "sound on");
    muteLabel();
    d.addEventListener("click", (e) => { if (e.target === d) close(); });
    d.querySelector(".ex-x").onclick = close;
    d.querySelector(".ex-back").onclick = () => { if (idx > 0) { idx--; render(); } };
    d.querySelector(".ex-next").onclick = () => { if (idx < EXPLAIN[cur].steps.length - 1) { idx++; render(); } else close(); };
    d.querySelector(".ex-replay").onclick = render;
    d.querySelector(".ex-hear").onclick = () => play(EXPLAIN[cur].steps[idx].sound);
    d.querySelector(".ex-mute").onclick = () => { muted = !muted; muteLabel(); };
    document.addEventListener("keydown", (e) => {
      if (d.hidden) return;
      if (e.key === "Escape") close();
      if (e.key === "ArrowRight") d.querySelector(".ex-next").click();
      if (e.key === "ArrowLeft") d.querySelector(".ex-back").click();
      e.stopPropagation();
    }, true);
    return d;
  }
  window.Explain = {
    open(name) {
      if (!EXPLAIN[name]) return;
      const d = document.getElementById("explain") || build();
      cur = name; idx = 0; d.hidden = false; render();
    },
  };
})();
