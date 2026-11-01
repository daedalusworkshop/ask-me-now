// Listening Lab · 3D stage
//
// The whole piece as one "space-time box":
//   x = pitch (left = low notes, right = high notes, lined up with the keys in the video)
//   y = the video's up/down (the keys sit at y = 0 … KD, the player's hands come from below)
//   z = time (every second of music is ZS units further along)
//
// The video is a thin slice of that box that slides along z as the music plays.
// Everything already played sits behind the slice (solid coloured notes, hand trails),
// everything still to come sits in front of it (white outlines). The camera flies around it.
//
// Sections below, in the order they matter:
//   1 load the piece        2 keyboard map + calibration     3 the layers in the box
//   4 camera director       5 tools (calibrate, track hands, labels, record)

import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

const $ = (s) => document.querySelector(s);
const KW = 24; // keyboard width, world units
const KD = 3; // key depth (front edge to where keys go under the lid), world units
const RANGES = { 88: [21, 108], 76: [28, 103], 61: [36, 96], 49: [36, 84] };
const HAND_BONES = [
  [0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11],
  [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [0, 17], [17, 18], [18, 19], [19, 20],
];
const SIDE_RGB = [[0.25, 0.47, 0.95], [0.98, 0.32, 0.68]]; // left hand blue, right hand pink
const MP_VER = "0.10.14";
const MP_URL = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VER}`;
const HAND_MODEL =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const lerp = (a, b, k) => a + (b - a) * k;
const ease = (k) => k * k * (3 - 2 * k);
const mmss = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, "0")}`;
const PC = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];

// ============================================================ 1 · load the piece

const sid = new URLSearchParams(location.search).get("s");
const S = {
  piece: null, notes: [], dur: 1, media: null, isVideo: false,
  stage: { calib: null, range: "88", labels: [], zs: null, glow: 1, show: {} },
  hands: null, // [{t, h:[{l, s, p:[x0,y0,…x20,y20]}]}] in video coords (0–1, y down)
  layout: null, H: null, Hinv: null, ext: null,
  cam: "auto", endedAt: null, rec: null,
};

function toast(msg) {
  const t = $("#toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 8000);
}
function busy(text, frac, onCancel) {
  $("#busy").hidden = text == null;
  if (text == null) return;
  $("#busy-text").textContent = text;
  $("#busy-fill").style.width = `${Math.round((frac || 0) * 100)}%`;
  $("#busy-cancel").hidden = !onCancel;
  $("#busy-cancel").onclick = onCancel || null;
}
async function saveStage() {
  await fetch(`/api/stage/${sid}`, { method: "POST", body: JSON.stringify(S.stage) });
}

// ============================================================ 2 · keyboard map + calibration

const isBlack = (p) => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);

// Where each key is across the keyboard, as u = 0 (left edge of the lowest key) … 1 (right edge
// of the highest). White keys are equal slices; a black key sits on the line between two whites.
function keyLayout(range) {
  const [lo, hi] = RANGES[range] || RANGES[88];
  let n = 0;
  for (let p = lo; p <= hi; p++) if (!isBlack(p)) n++;
  const map = new Map();
  let wi = -1;
  for (let p = lo; p <= hi; p++) {
    if (!isBlack(p)) { wi++; map.set(p, { u: (wi + 0.5) / n, w: 1 / n, black: false }); }
    else map.set(p, { u: (wi + 1) / n, w: 0.6 / n, black: true });
  }
  const key = (p) => {
    if (map.has(p)) return map.get(p);
    const edge = p < lo ? lo : hi; // off the keyboard: carry on at ~7/12 of a white key per semitone
    const k = map.get(edge);
    return { u: k.u + ((p - edge) * 7) / 12 / n, w: (isBlack(p) ? 0.6 : 1) / n, black: isBlack(p) };
  };
  return { lo, hi, n, key };
}

// A homography is a 3×3 matrix that maps one flat 4-sided shape onto another, perspective
// included. We use it to map "keyboard coordinates" (u across, v from front edge 0 to back edge 1)
// onto the video (x, y from 0–1). Four clicked corners are exactly enough to pin it down.
function homography(src, dst) {
  const A = [], b = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = src[i], [X, Y] = dst[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X]); b.push(X);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y]); b.push(Y);
  }
  const h = solve(A, b);
  return [...h, 1];
}
function solve(A, b) {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let piv = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[piv][c])) piv = r;
    [M[c], M[piv]] = [M[piv], M[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = M[r][c] / M[c][c];
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((r, i) => r[n] / r[i]);
}
function applyH(H, x, y) {
  const w = H[6] * x + H[7] * y + H[8];
  return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w, w];
}
function invert3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d]
    .map((v) => v / det);
}

// Keyboard corners in u,v, in the order you click them.
const KB_CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const DEFAULT_CALIB = [[0.03, 0.8], [0.97, 0.8], [0.97, 0.62], [0.03, 0.62]]; // a guess until you click

function setupMapping() {
  S.layout = keyLayout(S.stage.range);
  if (S.isVideo) {
    S.H = homography(KB_CORNERS, S.stage.calib || DEFAULT_CALIB);
  } else {
    S.H = [1, 0, 0, 0, -1, 1, 0, 0, 1]; // drawn keyboard: u → x, v → 1 − y
  }
  S.Hinv = invert3(S.H);
  // How much of the video, in keyboard units, fits on the slice
  if (S.isVideo) {
    let u0 = 0, u1 = 1, v0 = 0, v1 = 1;
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]]) {
      const [u, v, w] = applyH(S.Hinv, x, y);
      if (w <= 0 || !isFinite(u)) continue;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    S.ext = { u0: Math.max(u0, -0.35), u1: Math.min(u1, 1.35), v0: Math.max(v0, -5), v1: Math.min(v1, 6) };
  } else {
    S.ext = { u0: 0, u1: 1, v0: 0, v1: 1 };
  }
}
// video (0–1, y down) → world x, y on the slice
function videoToWorld(x, y) {
  const [u, v] = applyH(S.Hinv, x, y);
  return [u * KW, v * KD];
}
const noteX = (p) => S.layout.key(p).u * KW;
const noteW = (p) => S.layout.key(p).w * KW * 0.82;
const NOTE_Y = KD * 0.55;
const NOTE_H = 0.26;

// colour per pitch class: a rainbow round the octave
function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}
const pcRGB = (p) => hsl(((((p % 12) + 12) % 12) / 12) * 0.92, 0.85, 0.58);

// ============================================================ 3 · the layers in the box

const canvas = $("#gl");
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setClearColor(0x000000, 1);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.enabled = false;

const U = {
  // shared uniforms: every layer reads the same clock
  uNow: { value: 0 }, uZS: { value: 1 }, uMinLen: { value: 0.1 },
  uFog: { value: new THREE.Vector2(KW * 2.5, KW * 9) },
};
const layers = {}; // name → Object3D, so "look" checkboxes can hide them

// ---- 3a · the video slice (or a drawn keyboard when there's no video)
const kbCanvas = document.createElement("canvas");
kbCanvas.width = 2048; kbCanvas.height = 256;
const videoU = {
  uTex: { value: null }, uH: { value: new THREE.Matrix3() },
  uMin: { value: new THREE.Vector2() }, uMax: { value: new THREE.Vector2() },
  uHand0: { value: new THREE.Vector3() }, uHand1: { value: new THREE.Vector3() },
  uC0: { value: new THREE.Vector3(...SIDE_RGB[0]) }, uC1: { value: new THREE.Vector3(...SIDE_RGB[1]) },
  uKW: { value: KW }, uKD: { value: KD }, uKeepColor: { value: 0 },
};
const sliceMesh = new THREE.Mesh(
  new THREE.PlaneGeometry(1, 1),
  new THREE.ShaderMaterial({
    uniforms: videoU, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    vertexShader: /* glsl */ `
      uniform vec2 uMin, uMax; uniform float uKW, uKD;
      varying vec2 vKB; varying vec2 vW;
      void main() {
        vKB = mix(uMin, uMax, position.xy + 0.5);       // keyboard coords u, v
        vW = vec2(vKB.x * uKW, vKB.y * uKD);              // world x, y
        gl_Position = projectionMatrix * modelViewMatrix * vec4(vW, 0.0, 1.0);
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uTex; uniform mat3 uH;
      uniform vec3 uHand0, uHand1, uC0, uC1; uniform float uKeepColor;
      varying vec2 vKB; varying vec2 vW;
      void main() {
        vec3 q = uH * vec3(vKB, 1.0);                      // keyboard → video, via the homography
        vec2 st = q.xy / q.z;
        if (q.z <= 0.0 || st.x < 0.0 || st.x > 1.0 || st.y < 0.0 || st.y > 1.0) discard;
        vec3 c = texture2D(uTex, vec2(st.x, 1.0 - st.y)).rgb;
        float l = dot(c, vec3(0.299, 0.587, 0.114));        // black & white
        l = pow(smoothstep(0.03, 0.9, l), 1.1);              // a little extra contrast
        vec3 col = mix(vec3(l * 0.86), c, uKeepColor);       // the drawn keyboard keeps its colours
        // tint the picture near each hand with that hand's colour
        float r2 = 2.4 * 2.4;
        vec2 d0 = vW - uHand0.xy, d1 = vW - uHand1.xy;
        float g0 = uHand0.z * exp(-dot(d0, d0) / r2), g1 = uHand1.z * exp(-dot(d1, d1) / r2);
        col = mix(col, col * uC0 * 1.9 + uC0 * 0.07, g0 * 0.85);
        col = mix(col, col * uC1 * 1.9 + uC1 * 0.07, g1 * 0.85);
        // dark parts of the picture turn see-through, so the notes behind show through them
        bool onKeys = vKB.x > 0.0 && vKB.x < 1.0 && vKB.y > 0.0 && vKB.y < 1.0;
        float a = smoothstep(0.015, 0.14, l);
        if (onKeys) a = max(a, 0.82);
        float edge = smoothstep(0.0, 0.012, min(min(st.x, 1.0 - st.x), min(st.y, 1.0 - st.y)));
        gl_FragColor = vec4(col, a * edge * 0.96);
      }`,
  }),
);
sliceMesh.frustumCulled = false;
sliceMesh.renderOrder = 1;
scene.add(sliceMesh);
layers.slice = sliceMesh;

function drawKeyboardCanvas(sounding) {
  // no video: draw the keys and light up the ones sounding
  const g = kbCanvas.getContext("2d"), W = kbCanvas.width, Hh = kbCanvas.height;
  const L = S.layout;
  g.fillStyle = "#000"; g.fillRect(0, 0, W, Hh);
  for (let p = L.lo; p <= L.hi; p++) {
    const k = L.key(p);
    if (k.black) continue;
    const x0 = (k.u - k.w / 2) * W;
    const on = sounding.get(p);
    g.fillStyle = on ? rgbCss(pcRGB(p), 0.55 + 0.45 * on) : "#bdbdbd";
    g.fillRect(x0 + 1.5, 0, k.w * W - 3, Hh);
  }
  for (let p = L.lo; p <= L.hi; p++) {
    const k = L.key(p);
    if (!k.black) continue;
    const on = sounding.get(p);
    g.fillStyle = on ? rgbCss(pcRGB(p), 0.9) : "#0b0b0b";
    g.fillRect((k.u - k.w / 2) * W, 0, k.w * W, Hh * 0.62);
  }
  videoU.uTex.value.needsUpdate = true;
}
const rgbCss = (c, k = 1) => `rgb(${c.map((v) => Math.round(clamp(v * k, 0, 1) * 255)).join(",")})`;

// ---- 3b · notes: solid once played (they grow while held), white outlines while still to come
const noteMat = new THREE.ShaderMaterial({
  uniforms: U,
  vertexShader: /* glsl */ `
    attribute vec4 iA;  // x, y, width, height
    attribute vec4 iT;  // start, end, velocity 0-1
    attribute vec3 iC;  // colour
    uniform float uNow, uZS, uMinLen; uniform vec2 uFog;
    varying vec3 vC; varying vec3 vN; varying float vOn; varying float vFog;
    void main() {
      float s = iT.x, e = iT.y;
      if (s > uNow) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }  // not played yet
      float on = step(uNow, e);                    // still sounding
      float pop = on * exp(-(uNow - s) * 7.0);     // flash right at the attack
      float z0 = s * uZS;
      float z1 = max(min(e, uNow) * uZS, z0 + uMinLen);
      vec3 size = vec3(iA.z * (1.0 + 0.7 * pop), iA.w * (1.0 + 1.6 * pop + 0.4 * on), z1 - z0);
      vec4 mv = modelViewMatrix * vec4(position * size + vec3(iA.x, iA.y, 0.5 * (z0 + z1)), 1.0);
      gl_Position = projectionMatrix * mv;
      vN = normal; vOn = 0.6 * on + pop; vC = iC * (0.72 + 0.28 * iT.z);
      vFog = smoothstep(uFog.x, uFog.y, -mv.z);
    }`,
  fragmentShader: /* glsl */ `
    varying vec3 vC; varying vec3 vN; varying float vOn; varying float vFog;
    void main() {
      float light = 0.55 + 0.45 * max(dot(normalize(vN), normalize(vec3(0.35, 1.0, 0.6))), 0.0);
      vec3 c = vC * light * (1.0 + vOn) + 0.15 * vOn;
      gl_FragColor = vec4(mix(c, vec3(0.0), vFog * 0.6), 1.0);
    }`,
});
const wireMat = new THREE.ShaderMaterial({
  uniforms: { ...U, uAhead: { value: 6 } }, transparent: true, depthWrite: false,
  vertexShader: /* glsl */ `
    attribute vec4 iA; attribute vec4 iT;
    uniform float uNow, uZS, uMinLen, uAhead; uniform vec2 uFog;
    varying float vA;
    void main() {
      float s = iT.x, e = iT.y;
      if (e <= uNow) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }  // already played
      float z0 = max(s, uNow) * uZS;
      float z1 = max(e * uZS, z0 + uMinLen);
      vec4 mv = modelViewMatrix * vec4(position * vec3(iA.z, iA.w, z1 - z0) + vec3(iA.x, iA.y, 0.5 * (z0 + z1)), 1.0);
      gl_Position = projectionMatrix * mv;
      vA = (0.1 + 0.45 * exp(-max(s - uNow, 0.0) / uAhead)) * (1.0 - 0.7 * smoothstep(uFog.x, uFog.y, -mv.z));
    }`,
  fragmentShader: /* glsl */ `
    varying float vA;
    void main() { gl_FragColor = vec4(vec3(0.92), vA); }`,
});

function buildNotes() {
  for (const k of ["notes", "future"]) if (layers[k]) { scene.remove(layers[k]); layers[k].geometry.dispose(); }
  const n = S.notes.length;
  const iA = new Float32Array(n * 4), iT = new Float32Array(n * 4), iC = new Float32Array(n * 3);
  S.notes.forEach(([s, e, p, v], i) => {
    iA.set([noteX(p), NOTE_Y + (isBlack(p) ? 0.12 : 0), noteW(p) * (isBlack(p) ? 0.85 : 1), NOTE_H], i * 4);
    iT.set([s, e, v / 127, 0], i * 4);
    iC.set(pcRGB(p), i * 3);
  });
  const make = (base) => {
    const g = new THREE.InstancedBufferGeometry();
    g.index = base.index;
    g.setAttribute("position", base.getAttribute("position"));
    if (base.getAttribute("normal")) g.setAttribute("normal", base.getAttribute("normal"));
    g.setAttribute("iA", new THREE.InstancedBufferAttribute(iA, 4));
    g.setAttribute("iT", new THREE.InstancedBufferAttribute(iT, 4));
    g.setAttribute("iC", new THREE.InstancedBufferAttribute(iC, 3));
    g.instanceCount = n;
    return g;
  };
  const box = new THREE.BoxGeometry(1, 1, 1);
  const solid = new THREE.Mesh(make(box), noteMat);
  const wire = new THREE.LineSegments(make(new THREE.EdgesGeometry(box)), wireMat);
  for (const o of [solid, wire]) { o.frustumCulled = false; scene.add(o); }
  wire.renderOrder = 2;
  layers.notes = solid; layers.future = wire;
}

// ---- 3c · hand trails: each bone of each hand, joined frame to frame, makes a thin ribbon
// through time. Thousands of faint ribbons added together look like coloured smoke.
const trailMat = new THREE.ShaderMaterial({
  uniforms: { ...U, uGlow: { value: 1 }, uC0: videoU.uC0, uC1: videoU.uC1 },
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  vertexShader: /* glsl */ `
    attribute float aT; attribute float aW; attribute float aSide;
    uniform float uZS; uniform vec3 uC0, uC1;
    varying float vT; varying float vW; varying vec3 vC;
    void main() {
      vT = aT; vW = aW; vC = aSide < 0.5 ? uC0 : uC1;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position.xy, aT * uZS, 1.0);
    }`,
  fragmentShader: /* glsl */ `
    uniform float uNow, uGlow;
    varying float vT; varying float vW; varying vec3 vC;
    void main() {
      if (vT > uNow) discard;                              // only what's been played
      float strand = 0.35 + 0.65 * sin(3.14159 * clamp(vW, 0.0, 1.0));
      float fresh = 1.0 + 2.5 * exp(-(uNow - vT) * 2.0);   // brighter right behind the slice
      gl_FragColor = vec4(vC * 0.07 * uGlow * strand * fresh, 1.0);
    }`,
});

function assignSides() {
  // Which hand is which: with two hands, the lower one on the keyboard is the left hand.
  // With one, it's whichever hand was last seen nearest to it.
  const last = [null, null];
  for (const f of S.hands) {
    for (const h of f.h) {
      h.w = new Float32Array(42);
      for (let j = 0; j < 21; j++) {
        const [x, y] = videoToWorld(h.p[2 * j], h.p[2 * j + 1]);
        h.w[2 * j] = x; h.w[2 * j + 1] = y;
      }
      h.cx = (h.w[0] + h.w[18] + h.w[34]) / 3; // wrist, middle knuckle, pinky knuckle
    }
    const hs = f.h.slice().sort((a, b) => b.s - a.s).slice(0, 2);
    if (hs.length === 2) {
      hs.sort((a, b) => a.cx - b.cx);
      hs[0].side = 0; hs[1].side = 1;
    } else if (hs.length === 1) {
      const h = hs[0];
      const near = [0, 1].map((s) => (last[s] && f.t - last[s].t < 1.5 ? Math.abs(last[s].x - h.cx) : Infinity));
      h.side = near[0] === near[1] ? (h.cx < KW / 2 ? 0 : 1) : near[0] < near[1] ? 0 : 1;
    }
    f.h = hs;
    for (const h of hs) last[h.side] = { t: f.t, x: h.cx };
  }
}

function buildTrails() {
  if (layers.trails) { scene.remove(layers.trails); layers.trails.geometry.dispose(); delete layers.trails; }
  if (!S.hands || !S.hands.length) return;
  assignSides();
  const pos = [], aT = [], aW = [], aSide = [], idx = [];
  for (const side of [0, 1]) {
    let prev = null;
    for (const f of S.hands) {
      const h = f.h.find((x) => x.side === side);
      if (!h) { prev = null; continue; }
      if (prev && f.t - prev.t < 0.25) {
        for (const [a, b] of HAND_BONES) {
          const base = pos.length / 3;
          const P = [[prev.w, a, prev.t, 0], [prev.w, b, prev.t, 1], [h.w, b, f.t, 1], [h.w, a, f.t, 0]];
          for (const [w, j, t, ww] of P) { pos.push(w[2 * j], w[2 * j + 1], 0); aT.push(t); aW.push(ww); aSide.push(side); }
          idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
      }
      prev = { t: f.t, w: h.w };
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute("aT", new THREE.Float32BufferAttribute(aT, 1));
  g.setAttribute("aW", new THREE.Float32BufferAttribute(aW, 1));
  g.setAttribute("aSide", new THREE.Float32BufferAttribute(aSide, 1));
  g.setIndex(pos.length / 3 > 65535 ? new THREE.Uint32BufferAttribute(idx, 1) : new THREE.Uint16BufferAttribute(idx, 1));
  const m = new THREE.Mesh(g, trailMat);
  m.frustumCulled = false; m.renderOrder = 3;
  scene.add(m);
  layers.trails = m;
}

// ---- 3d · the live hand lines drawn on the slice
const skelPos = new Float32Array(2 * HAND_BONES.length * 2 * 3);
const skelCol = new Float32Array(skelPos.length);
const skelGeo = new THREE.BufferGeometry();
skelGeo.setAttribute("position", new THREE.BufferAttribute(skelPos, 3));
skelGeo.setAttribute("color", new THREE.BufferAttribute(skelCol, 3));
const skeleton = new THREE.LineSegments(skelGeo, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95 }));
skeleton.frustumCulled = false; skeleton.renderOrder = 4;
scene.add(skeleton);
layers.skeleton = skeleton;

function handsAt(t) {
  // the two hands at time t, blended between the tracked frames either side
  const out = [null, null], F = S.hands;
  if (!F || !F.length) return out;
  let lo = 0, hi = F.length - 1;
  if (t < F[0].t || t > F[hi].t + 0.15) return out;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (F[m].t <= t) lo = m; else hi = m; }
  const a = F[lo], b = F[hi];
  for (const side of [0, 1]) {
    const ha = a.h.find((h) => h.side === side), hb = b.h.find((h) => h.side === side);
    if (ha && hb && b.t - a.t < 0.25 && b.t > a.t) {
      const k = clamp((t - a.t) / (b.t - a.t), 0, 1);
      out[side] = ha.w.map((v, i) => lerp(v, hb.w[i], k));
    } else if (ha && t - a.t < 0.12) out[side] = ha.w;
    else if (hb && b.t - t < 0.12) out[side] = hb.w;
  }
  return out;
}

function updateHands(t, z) {
  const hs = handsAt(t);
  let i = 0;
  hs.forEach((w, side) => {
    const u = side ? videoU.uHand1 : videoU.uHand0;
    if (!w) { u.value.z = Math.max(0, u.value.z - 0.08); return; }
    u.value.set((w[0] + w[18]) / 2, (w[1] + w[19]) / 2, 1);
    for (const [a, b] of HAND_BONES) {
      skelPos.set([w[2 * a], w[2 * a + 1], z + 0.02, w[2 * b], w[2 * b + 1], z + 0.02], i * 6);
      skelCol.set([...SIDE_RGB[side], ...SIDE_RGB[side]], i * 6);
      i++;
    }
  });
  skelGeo.setDrawRange(0, i * 2);
  skelGeo.attributes.position.needsUpdate = true;
  skelGeo.attributes.color.needsUpdate = true;
}

// ---- 3e · the box, the floor grid, time ticks, the note-name ruler and your labels
function textSprite(text, { h = 0.016, color = "#fff", weight = 400, anchor = [0, 0.5] } = {}) {
  const c = document.createElement("canvas"), g = c.getContext("2d"), px = 44;
  const font = `${weight} ${px}px ui-monospace, Menlo, Consolas, monospace`;
  g.font = font;
  c.width = Math.ceil(g.measureText(text).width) + 12; c.height = Math.ceil(px * 1.35);
  g.font = font; g.fillStyle = color; g.textBaseline = "middle"; g.fillText(text, 6, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.minFilter = THREE.LinearFilter;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false, sizeAttenuation: false }));
  sp.scale.set((h * c.width) / c.height, h, 1);
  sp.center.set(...anchor);
  sp.renderOrder = 10;
  return sp;
}
function lines(pts, opacity, color = 0xffffff) {
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  l.frustumCulled = false;
  return l;
}
function disposeGroup(name) {
  const g = layers[name];
  if (!g) return;
  scene.remove(g);
  g.traverse((o) => { o.geometry?.dispose(); o.material?.map?.dispose(); o.material?.dispose(); });
  delete layers[name];
}

function boxBounds() {
  const e = S.ext, zs = U.uZS.value;
  return {
    x0: Math.min(e.u0 * KW, -0.04 * KW), x1: Math.max(e.u1 * KW, 1.04 * KW),
    y0: Math.min(e.v0 * KD, -KD * 0.8) - 0.4, y1: Math.max(e.v1 * KD, KD * 2) + 0.4,
    z0: 0, z1: S.dur * zs,
  };
}

function buildBox() {
  disposeGroup("box"); disposeGroup("labels");
  const b = boxBounds(), zs = U.uZS.value;
  const box = new THREE.Group();
  // the outline of the whole piece
  const c = [[b.x0, b.y0], [b.x1, b.y0], [b.x1, b.y1], [b.x0, b.y1]];
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = c[i], [x2, y2] = c[(i + 1) % 4];
    pts.push(x, y, b.z0, x2, y2, b.z0, x, y, b.z1, x2, y2, b.z1, x, y, b.z0, x, y, b.z1);
  }
  box.add(lines(pts, 0.32));
  // floor grid: a line along time for every C, a line across every few seconds
  const g = [], step = tickStep();
  for (let p = S.layout.lo; p <= S.layout.hi; p++) if (p % 12 === 0) g.push(noteX(p), b.y0, b.z0, noteX(p), b.y0, b.z1);
  for (let t = step; t < S.dur; t += step) g.push(b.x0, b.y0, t * zs, b.x1, b.y0, t * zs);
  box.add(lines(g, 0.1));
  scene.add(box);
  layers.box = box;

  const lab = new THREE.Group();
  // time ticks along the bottom-left edge
  for (let t = 0; t <= S.dur; t += step) {
    const sp = textSprite(mmss(t), { h: 0.013, color: "#9a9a9a", anchor: [1, 0.5] });
    sp.position.set(b.x0 - 0.3, b.y0, t * zs);
    lab.add(sp);
  }
  const end = textSprite(mmss(S.dur), { h: 0.014, color: "#cfcfcf", anchor: [1, 0.5] });
  end.position.set(b.x0 - 0.3, b.y0, b.z1);
  lab.add(end);
  // your section labels: a leader line up from the top edge, text on top
  const lp = [];
  S.stage.labels.forEach((L, i) => {
    const z = L.t * zs, y = b.y1 + 1.2 + (i % 3) * 1.4;
    lp.push(b.x0, b.y1, z, b.x0, y, z);
    const sp = textSprite(L.text, { h: 0.017, color: "#fff", anchor: [0, 0] });
    sp.position.set(b.x0, y, z);
    lab.add(sp);
  });
  if (lp.length) lab.add(lines(lp, 0.55));
  scene.add(lab);
  layers.labels = lab;
  buildRuler();
}
const tickStep = () => (S.dur <= 90 ? 10 : S.dur <= 300 ? 20 : 60);

// The note names, lying on the note sheet a little behind the slice, read from the front.
function buildRuler() {
  disposeGroup("ruler");
  const c = document.createElement("canvas"), g = c.getContext("2d");
  c.width = 4096; c.height = 160;
  const L = S.layout;
  g.textAlign = "center"; g.textBaseline = "middle";
  for (let p = L.lo; p <= L.hi; p++) {
    const x = L.key(p).u * c.width, isC = p % 12 === 0;
    g.font = `${isC ? 700 : 400} ${isC ? 54 : 30}px ui-monospace, Menlo, monospace`;
    g.fillStyle = isC ? "#ffffff" : "#8a8a8a";
    g.fillText(isC ? `C${p / 12 - 1}` : PC[p % 12], x, isC ? 48 : 112);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  const h = (KW * c.height) / c.width;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(KW, h), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, opacity: 0.9 }));
  m.rotation.x = -Math.PI / 2; // lie flat
  m.position.set(KW / 2, NOTE_Y + 0.02, 0);
  m.renderOrder = 5;
  const grp = new THREE.Group();
  grp.add(m);
  scene.add(grp);
  layers.ruler = grp;
}

// the slice's frame, and the clock that rides along with it
const sliceFrame = lines(new Array(24).fill(0), 0.55);
scene.add(sliceFrame);
let clockSprite = null, clockText = "";
function updateSliceFrame() {
  const e = S.ext, quad = [];
  if (S.isVideo) {
    for (const [x, y] of [[0, 0], [1, 0], [1, 1], [0, 1]]) {
      const [u, v, w] = applyH(S.Hinv, x, y);
      quad.push(w > 0 ? [clamp(u, e.u0, e.u1) * KW, clamp(v, e.v0, e.v1) * KD] : null);
    }
  }
  const q = quad.length === 4 && quad.every(Boolean) ? quad : [[e.u0 * KW, e.v0 * KD], [e.u1 * KW, e.v0 * KD], [e.u1 * KW, e.v1 * KD], [e.u0 * KW, e.v1 * KD]];
  const p = sliceFrame.geometry.attributes.position;
  for (let i = 0; i < 4; i++) {
    p.setXYZ(2 * i, q[i][0], q[i][1], 0);
    p.setXYZ(2 * i + 1, q[(i + 1) % 4][0], q[(i + 1) % 4][1], 0);
  }
  p.needsUpdate = true;
  sliceFrame.geometry.setDrawRange(0, 8);
  S.frameCorner = q[0];
}
function updateClock(t, z) {
  const s = mmss(t);
  if (s !== clockText) {
    if (clockSprite) { scene.remove(clockSprite); clockSprite.material.map.dispose(); clockSprite.material.dispose(); }
    clockSprite = textSprite(s, { h: 0.016, weight: 700, anchor: [1, 1] });
    scene.add(clockSprite);
    clockText = s;
  }
  clockSprite.position.set(S.frameCorner[0] - 0.2, S.frameCorner[1] - 0.2, z);
  clockSprite.visible = S.stage.show.labels !== false;
}

// ============================================================ 4 · camera director

// Each shot: where the camera sits around the playhead (az = swing left/right in degrees,
// el = height in degrees, d = distance in keyboard widths, dz = look ahead (+) / behind (−)).
const SHOTS = [
  { az: -32, el: 34, d: 1.5, dz: 0.35 }, // wide, the future laid out ahead
  { az: -18, el: 28, d: 0.85, dz: 0 },
  { az: -68, el: 16, d: 0.95, dz: -0.3 }, // along the keyboard, looking back at what's been played
  { az: 8, el: 62, d: 1.05, dz: -0.15 }, // from above
  { az: -112, el: 24, d: 1.25, dz: -0.55 }, // from the side, trails stretched out behind
  { az: 32, el: 22, d: 0.8, dz: 0 },
  { az: -12, el: 8, d: 0.72, dz: 0 }, // low and nearly head-on
  { az: -150, el: 42, d: 1.35, dz: -0.6 }, // from behind, over the past
];
const SHOT_LEN = 9, BLEND = 3.5;
const DEG = Math.PI / 180;

function placeFromShot(sh, target) {
  const az = sh.az * DEG, el = sh.el * DEG, d = sh.d * KW;
  const t = new THREE.Vector3(target.x, target.y, target.z + sh.dz * KW);
  const p = t.clone().add(new THREE.Vector3(Math.sin(az) * Math.cos(el), Math.sin(el), Math.cos(az) * Math.cos(el)).multiplyScalar(d));
  return { p, t };
}
function autoCamera(now) {
  const head = new THREE.Vector3(KW / 2, KD * 0.5, now * U.uZS.value);
  const i = Math.floor(now / SHOT_LEN), f = now - i * SHOT_LEN;
  const a = SHOTS[(i - 1 + SHOTS.length) % SHOTS.length], b = SHOTS[i % SHOTS.length];
  const k = i === 0 ? 1 : ease(clamp(f / BLEND, 0, 1));
  const sh = {
    az: lerp(a.az, b.az, k) + 5 * Math.sin(now * 0.13), el: lerp(a.el, b.el, k) + 2 * Math.sin(now * 0.09),
    d: lerp(a.d, b.d, k), dz: lerp(a.dz, b.dz, k),
  };
  let { p, t } = placeFromShot(sh, head);
  // the ending: pull back to see the whole piece at once, slowly turning
  const hold = S.endedAt ? (performance.now() - S.endedAt) / 1000 : 0;
  const e = Math.max(ease(clamp((now - (S.dur - 5)) / 4.5, 0, 1)), hold > 0 ? 1 : 0);
  if (e > 0) {
    const b2 = boxBounds(), len = b2.z1 - b2.z0;
    const ov = placeFromShot({ az: -58 + hold * 5, el: 52, d: Math.max(len, KW * 1.4) / KW * 0.95, dz: 0 }, new THREE.Vector3(KW / 2, KD, len / 2));
    p.lerp(ov.p, e); t.lerp(ov.t, e);
  }
  camera.position.copy(p);
  camera.lookAt(t);
  controls.target.copy(t);
}
let lastHeadZ = 0;
function freeCamera(z) {
  // you're driving: the camera rides along with the playhead, you orbit around it
  const dz = z - lastHeadZ;
  camera.position.z += dz; controls.target.z += dz;
  controls.update();
}
function setCam(mode) {
  S.cam = mode;
  controls.enabled = mode === "free";
  $("#btn-cam").textContent = `camera: ${mode}`;
}

// ============================================================ the frame loop

const sounding = new Map();
function soundingAt(t) {
  sounding.clear();
  const N = S.notes;
  let lo = 0, hi = N.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (N[m][0] <= t) lo = m + 1; else hi = m; }
  for (let i = lo - 1; i >= 0 && N[i][0] >= t - S.maxDur; i--) {
    if (N[i][1] >= t) sounding.set(N[i][2], Math.max(sounding.get(N[i][2]) || 0, 1 - clamp((t - N[i][0]) * 2, 0, 0.6)));
  }
  return sounding;
}

function frame() {
  requestAnimationFrame(frame);
  if (!S.piece) return;
  const now = S.media ? S.media.currentTime : 0;
  const z = now * U.uZS.value;
  U.uNow.value = now;
  sliceMesh.position.z = z;
  sliceFrame.position.z = z;
  if (layers.ruler) layers.ruler.position.z = Math.max(0, z - 0.45 * KW);
  if (!S.isVideo) drawKeyboardCanvas(soundingAt(now));
  updateHands(now, z);
  updateClock(now, z);
  if (S.cam === "auto") autoCamera(now); else freeCamera(z);
  lastHeadZ = z;
  renderer.render(scene, camera);
  // recording: stop a few seconds after the end, once the camera has pulled back
  if (S.rec && S.endedAt && performance.now() - S.endedAt > 6000) stopRecording();
  updateBar(now);
}

function resize() {
  if (S.rec) return;
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  canvas.style.width = `${w}px`; canvas.style.height = `${h}px`;
  camera.aspect = w / h; camera.updateProjectionMatrix();
}
addEventListener("resize", resize);

// ============================================================ 5 · tools

// ---- 5a · keyboard corners: four clicks pin the keyboard down in the video
const CALIB_HELP = [
  "Click the <b>front-left</b> corner of the keys: the front edge of the <b>lowest</b> key (nearest the player).",
  "Now the <b>front-right</b> corner: the front edge of the <b>highest</b> key.",
  "Now the <b>back-right</b> corner: where the highest key disappears under the lid.",
  "Last one: the <b>back-left</b> corner, where the lowest key disappears under the lid.",
];
let calibPts = [], dragIdx = -1;
function openCalib() {
  if (!S.isVideo) return toast("This piece has no video, so there's no keyboard to line up. The drawn keyboard is used instead.");
  S.media.pause();
  calibPts = (S.stage.calib || []).map((p) => p.slice());
  $("#calib").hidden = false;
  drawCalib();
}
function calibCanvasSize() {
  const v = S.media, c = $("#calib-canvas");
  const ar = v.videoWidth / v.videoHeight || 16 / 9;
  const w = Math.min(innerWidth * 0.94, innerHeight * 0.76 * ar);
  c.width = Math.round(w * devicePixelRatio); c.height = Math.round((w / ar) * devicePixelRatio);
  c.style.width = `${w}px`; c.style.height = `${w / ar}px`;
}
function drawCalib() {
  if ($("#calib").hidden) return;
  requestAnimationFrame(drawCalib);
  const c = $("#calib-canvas"), g = c.getContext("2d"), v = S.media;
  if (c.width < 10 || Math.abs(c.width / c.height - v.videoWidth / v.videoHeight) > 0.01) calibCanvasSize();
  const W = c.width, H = c.height, s = devicePixelRatio;
  g.drawImage(v, 0, 0, W, H);
  g.lineWidth = 1.5 * s;
  if (calibPts.length === 4) {
    // show where every white key and every C would be, so you can see if it lines up
    const Hm = homography(KB_CORNERS, calibPts), L = keyLayout(S.stage.range);
    g.strokeStyle = "rgba(255,255,255,.55)"; g.lineWidth = 1 * s;
    for (let i = 0; i <= L.n; i++) {
      const [x0, y0] = applyH(Hm, i / L.n, 0), [x1, y1] = applyH(Hm, i / L.n, 1);
      g.beginPath(); g.moveTo(x0 * W, y0 * H); g.lineTo(x1 * W, y1 * H); g.stroke();
    }
    g.fillStyle = "#ff4fb4"; g.font = `${12 * s}px ui-monospace, monospace`; g.textAlign = "center";
    for (let p = L.lo; p <= L.hi; p++) {
      if (p % 12) continue;
      const [x, y] = applyH(Hm, L.key(p).u, -0.08);
      g.fillText(`C${p / 12 - 1}`, x * W, y * H + 10 * s);
    }
  }
  g.strokeStyle = "#ff4fb4"; g.lineWidth = 2 * s;
  g.beginPath();
  calibPts.forEach(([x, y], i) => (i ? g.lineTo(x * W, y * H) : g.moveTo(x * W, y * H)));
  if (calibPts.length === 4) g.closePath();
  g.stroke();
  calibPts.forEach(([x, y], i) => {
    g.fillStyle = "#ff4fb4"; g.beginPath(); g.arc(x * W, y * H, 6 * s, 0, 7); g.fill();
    g.fillStyle = "#000"; g.font = `bold ${10 * s}px ui-monospace, monospace`; g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText(String(i + 1), x * W, y * H);
  });
  $("#calib-help").innerHTML = calibPts.length < 4 ? CALIB_HELP[calibPts.length]
    : `Drag any corner to adjust. The thin lines should sit on the gaps between the white keys, and the pink C's under the C keys.
       Lines bunched up or spread out? Change the keyboard size in <i>look</i>. Then press <b>done</b>.`;
}
function calibXY(e) {
  const r = $("#calib-canvas").getBoundingClientRect();
  return [clamp((e.clientX - r.left) / r.width, 0, 1), clamp((e.clientY - r.top) / r.height, 0, 1)];
}
$("#calib-canvas").addEventListener("pointerdown", (e) => {
  const [x, y] = calibXY(e), r = $("#calib-canvas").getBoundingClientRect();
  dragIdx = calibPts.findIndex(([px, py]) => Math.hypot((px - x) * r.width, (py - y) * r.height) < 14);
  if (dragIdx < 0 && calibPts.length < 4) calibPts.push([x, y]);
  e.target.setPointerCapture(e.pointerId);
});
$("#calib-canvas").addEventListener("pointermove", (e) => { if (dragIdx >= 0) calibPts[dragIdx] = calibXY(e); });
$("#calib-canvas").addEventListener("pointerup", () => (dragIdx = -1));
$("#calib-reset").onclick = () => (calibPts = []);
$("#calib-done").onclick = async () => {
  $("#calib").hidden = true;
  if (calibPts.length !== 4) return;
  S.stage.calib = calibPts;
  await saveStage();
  rebuildAll();
};

// ---- 5b · hand tracking: MediaPipe finds 21 points on each hand in every video frame
let trackStop = false;
async function trackHands() {
  if (!S.isVideo) return toast("Hand tracking needs a video.");
  trackStop = false;
  busy("Loading the hand tracker (MediaPipe)…", 0, () => (trackStop = true));
  let vision, lm;
  try {
    vision = await import(`${MP_URL}/vision_bundle.mjs`);
    const files = await vision.FilesetResolver.forVisionTasks(`${MP_URL}/wasm`);
    for (const delegate of ["GPU", "CPU"]) {
      try {
        lm = await vision.HandLandmarker.createFromOptions(files, {
          baseOptions: { modelAssetPath: HAND_MODEL, delegate }, runningMode: "VIDEO", numHands: 2,
          minHandDetectionConfidence: 0.35, minHandPresenceConfidence: 0.35, minTrackingConfidence: 0.35,
        });
        break;
      } catch (e) { if (delegate === "CPU") throw e; }
    }
  } catch (e) {
    busy(null);
    return toast("Couldn't load the hand tracker (it needs an internet connection the first time): " + e.message);
  }
  S.media.pause();
  // A second, silent copy of the video plays through once while we read the hands off it.
  const v = document.createElement("video");
  v.src = S.piece.media.url; v.muted = true; v.playsInline = true; v.preload = "auto";
  $("#media-host").appendChild(v);
  await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
  const frames = [];
  let lastTs = -1, cost = 0.03;
  const detect = (t) => {
    let ts = Math.round(t * 1000);
    if (ts <= lastTs) ts = lastTs + 1;
    lastTs = ts;
    const t0 = performance.now();
    const r = lm.detectForVideo(v, ts);
    // play only as fast as this computer can read hands: aim for ~24 looks per second of video
    cost = 0.8 * cost + 0.2 * ((performance.now() - t0) / 1000 + 0.004);
    v.playbackRate = clamp(1 / (cost * 24), 0.1, 2);
    const hand = r.handedness || r.handednesses || [];
    frames.push({
      t: +t.toFixed(3),
      h: r.landmarks.map((L, i) => ({
        l: hand[i]?.[0]?.categoryName || "", s: +(hand[i]?.[0]?.score || 0).toFixed(2),
        p: L.flatMap((q) => [+q.x.toFixed(4), +q.y.toFixed(4)]),
      })),
    });
    if (frames.length % 10 === 0) {
      const withHands = frames.filter((f) => f.h.length).length;
      busy(`Tracking hands… ${mmss(t)} / ${mmss(v.duration)} · hands found in ${withHands} of ${frames.length} frames`, t / v.duration, () => (trackStop = true));
    }
  };
  if ("requestVideoFrameCallback" in v) {
    // play it through and look at every frame the browser shows
    await new Promise((resolve) => {
      const onFrame = (_, meta) => {
        if (trackStop || v.ended) return resolve();
        detect(meta.mediaTime);
        v.requestVideoFrameCallback(onFrame);
      };
      v.addEventListener("ended", resolve, { once: true });
      v.requestVideoFrameCallback(onFrame);
      v.playbackRate = 2;
      v.play().catch(resolve);
    });
  } else {
    // older browsers: step through the video 15 times a second
    for (let t = 0; t < v.duration && !trackStop; t += 1 / 15) {
      v.currentTime = t;
      await new Promise((r) => v.addEventListener("seeked", r, { once: true }));
      detect(t);
    }
  }
  v.pause(); v.remove(); lm.close();
  if (frames.length < 10) { busy(null); return toast("No hands found."); }
  busy("Saving…", 1);
  S.hands = frames;
  await fetch(`/api/hands/${sid}`, { method: "POST", body: JSON.stringify(frames) });
  buildTrails();
  busy(null);
  refreshSteps();
  toast(`Tracked ${frames.filter((f) => f.h.length).length} frames with hands.`);
}

// ---- 5c · section labels
function addLabel() {
  const t = S.media.currentTime;
  const text = prompt(`Label at ${mmss(t)} (e.g. "A section begins"):`);
  if (!text || !text.trim()) return;
  S.stage.labels.push({ t: +t.toFixed(2), text: text.trim() });
  S.stage.labels.sort((a, b) => a.t - b.t);
  saveStage(); buildBox(); applyShow(); renderLabelList();
}
function renderLabelList() {
  const host = $("#labels-list");
  host.innerHTML = "";
  S.stage.labels.forEach((L, i) => {
    const row = document.createElement("div");
    row.className = "lab";
    row.innerHTML = `<span>${mmss(L.t)}</span><span class="t"></span><button title="delete">×</button>`;
    row.querySelector(".t").textContent = L.text;
    row.onclick = (e) => {
      if (e.target.tagName === "BUTTON") {
        S.stage.labels.splice(i, 1); saveStage(); buildBox(); applyShow(); renderLabelList();
      } else S.media.currentTime = L.t;
    };
    host.appendChild(row);
  });
  const marks = $("#bar-marks");
  marks.innerHTML = S.stage.labels.map((L) => `<i style="left:${(L.t / S.dur) * 100}%"></i>`).join("");
}

// ---- 5d · record: the canvas plus the sound, straight to a video file
let audioCtx = null, audioDest = null;
function ensureAudio() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
    const src = audioCtx.createMediaElementSource(S.media);
    audioDest = audioCtx.createMediaStreamDestination();
    src.connect(audioCtx.destination); src.connect(audioDest);
  }
  return audioCtx.resume();
}
async function startRecording() {
  const [w, h] = $("#rec-size").value.split("x").map(Number);
  await ensureAudio();
  document.body.classList.add("recording");
  renderer.setPixelRatio(1);
  renderer.setSize(w, h, false);
  const k = Math.min(innerWidth / w, innerHeight / h);
  canvas.style.width = `${w * k}px`; canvas.style.height = `${h * k}px`;
  camera.aspect = w / h; camera.updateProjectionMatrix();
  const stream = canvas.captureStream(30);
  audioDest.stream.getAudioTracks().forEach((t) => stream.addTrack(t));
  const mime = ["video/mp4;codecs=avc1.640028,mp4a.40.2", "video/mp4", "video/webm;codecs=vp9,opus", "video/webm"]
    .find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 16e6 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: rec.mimeType });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${(S.piece.title || "piece").replace(/\.[^.]+$/, "").replace(/[^\w-]+/g, "_")}_3d.${rec.mimeType.includes("mp4") ? "mp4" : "webm"}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  };
  S.media.pause();
  S.media.currentTime = 0;
  await new Promise((r) => S.media.addEventListener("seeked", r, { once: true }));
  S.endedAt = null;
  setCam("auto");
  $("#ui").classList.add("hidden");
  S.rec = rec;
  rec.start(1000);
  $("#btn-rec").textContent = "■ stop"; $("#btn-rec").classList.add("rec-on");
  S.media.play();
}
function stopRecording() {
  if (!S.rec) return;
  S.rec.stop(); S.rec = null;
  S.media.pause();
  document.body.classList.remove("recording");
  $("#ui").classList.remove("hidden");
  $("#btn-rec").textContent = "● record"; $("#btn-rec").classList.remove("rec-on");
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  resize();
  toast("Recording saved to your downloads.");
}

// ============================================================ wiring

function applyShow() {
  const sh = S.stage.show;
  document.querySelectorAll("[data-show]").forEach((el) => (el.checked = sh[el.dataset.show] !== false));
  const vis = (k) => sh[k] !== false;
  if (layers.notes) layers.notes.visible = vis("notes");
  if (layers.future) layers.future.visible = vis("future");
  if (layers.trails) layers.trails.visible = vis("trails");
  skeleton.visible = vis("skeleton");
  if (layers.labels) layers.labels.visible = vis("labels");
  if (layers.box) layers.box.visible = vis("box");
  if (layers.ruler) layers.ruler.visible = vis("box");
  sliceFrame.visible = vis("box");
}

function rebuildAll() {
  setupMapping();
  videoU.uH.value.set(...S.H);
  videoU.uMin.value.set(S.ext.u0, S.ext.v0);
  videoU.uMax.value.set(S.ext.u1, S.ext.v1);
  buildNotes();
  buildTrails();
  buildBox();
  updateSliceFrame();
  applyShow();
  refreshSteps();
}

function refreshSteps() {
  const c = $("#btn-calib"), t = $("#btn-track");
  c.classList.toggle("done", !!S.stage.calib); t.classList.toggle("done", !!S.hands);
  c.hidden = t.hidden = !S.isVideo;
  let msg = "";
  if (!S.isVideo) msg = "No video in this piece, so a drawn keyboard stands in for it.";
  else if (!S.stage.calib) msg = "<b>Step 1:</b> show it where the keyboard is in the video, so the notes line up with the keys.";
  else if (!S.hands) msg = "<b>Step 2 (optional):</b> track the hands to get the coloured trails.";
  else msg = "Ready. Press space, or ● record.";
  $("#steps").innerHTML = msg;
}

function updateBar(now) {
  $("#bar-fill").style.width = `${(now / S.dur) * 100}%`;
  const s = `${mmss(now)} / ${mmss(S.dur)}`;
  if ($("#bar-time").textContent !== s) $("#bar-time").textContent = s;
}

function wire() {
  if (window.parent !== window) {
    // shown as a tab inside the lanes page: "← lanes" switches tabs instead of navigating
    $(".row.head a").onclick = (e) => { e.preventDefault(); window.parent.postMessage("show-lanes", location.origin); };
  }
  $("#btn-calib").onclick = openCalib;
  $("#btn-track").onclick = trackHands;
  $("#btn-label").onclick = addLabel;
  $("#btn-cam").onclick = () => setCam(S.cam === "auto" ? "free" : "auto");
  $("#btn-rec").onclick = () => (S.rec ? stopRecording() : startRecording());
  canvas.addEventListener("pointerdown", () => S.cam === "auto" && !S.rec && setCam("free"));
  document.querySelectorAll("[data-show]").forEach((el) => (el.onchange = () => {
    S.stage.show[el.dataset.show] = el.checked; applyShow(); saveStage();
  }));
  $("#zs").value = U.uZS.value;
  $("#zs").oninput = (e) => { U.uZS.value = +e.target.value; S.stage.zs = U.uZS.value; buildBox(); applyShow(); };
  $("#zs").onchange = saveStage;
  $("#glow").value = S.stage.glow;
  $("#glow").oninput = (e) => { trailMat.uniforms.uGlow.value = S.stage.glow = +e.target.value; };
  $("#glow").onchange = saveStage;
  $("#range").value = S.stage.range;
  $("#range").onchange = (e) => { S.stage.range = e.target.value; saveStage(); rebuildAll(); };
  const bar = $("#bar");
  const seek = (e) => {
    const r = bar.getBoundingClientRect();
    S.media.currentTime = clamp((e.clientX - r.left) / r.width, 0, 1) * S.dur;
  };
  bar.addEventListener("pointerdown", (e) => { seek(e); bar.setPointerCapture(e.pointerId); bar.onpointermove = seek; });
  bar.addEventListener("pointerup", () => (bar.onpointermove = null));
  S.media.addEventListener("ended", () => (S.endedAt = performance.now()));
  S.media.addEventListener("play", () => (S.endedAt = null));
  S.media.addEventListener("seeking", () => { if (!S.media.ended) S.endedAt = null; });
  document.addEventListener("keydown", (e) => {
    if (e.target.closest("input, select, textarea") || !$("#calib").hidden) return;
    if (e.code === "Space") { e.preventDefault(); S.media.paused ? S.media.play() : S.media.pause(); }
    else if (e.code === "ArrowRight") S.media.currentTime = Math.min(S.dur, S.media.currentTime + 5);
    else if (e.code === "ArrowLeft") S.media.currentTime = Math.max(0, S.media.currentTime - 5);
    else if (e.key === "l" || e.key === "L") addLabel();
    else if (e.key === "c" || e.key === "C") setCam(S.cam === "auto" ? "free" : "auto");
    else if (e.key === "h" || e.key === "H") $("#ui").classList.toggle("hidden");
    else if (e.key === "Escape" && S.rec) stopRecording();
  });
}

async function init() {
  if (!sid) throw new Error("Open this page from the main page's “3D stage” button.");
  const r = await fetch(`/api/piece/${sid}`);
  const piece = await r.json();
  if (!r.ok || piece.error) throw new Error(piece.error || r.statusText);
  S.piece = piece;
  S.notes = piece.notes.slice().sort((a, b) => a[0] - b[0]);
  S.maxDur = Math.max(0.1, ...S.notes.map((n) => n[1] - n[0]));
  Object.assign(S.stage, piece.stage || {});
  S.stage.show = S.stage.show || {};
  S.isVideo = piece.media.kind === "video";
  document.title = `${piece.title} · 3D stage`;
  $("#title").textContent = piece.title;

  const m = document.createElement(S.isVideo ? "video" : "audio");
  m.src = piece.media.url; m.preload = "auto"; m.playsInline = true; m.crossOrigin = "anonymous";
  $("#media-host").appendChild(m);
  S.media = m;
  await new Promise((res) => {
    if (m.readyState >= 2) return res();
    m.addEventListener("loadeddata", res, { once: true });
    m.addEventListener("error", res, { once: true });
  });
  S.dur = Math.max(piece.duration, isFinite(m.duration) ? m.duration : 0, 1);
  if (S.isVideo) {
    const tex = new THREE.VideoTexture(m);
    tex.minFilter = THREE.LinearMipmapLinearFilter; tex.generateMipmaps = true; // less shimmer from afar
    tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
    videoU.uTex.value = tex;
  } else {
    videoU.uTex.value = new THREE.CanvasTexture(kbCanvas);
    videoU.uKeepColor.value = 1;
  }
  // how stretched time is: by default the whole piece is ~2.5 keyboards long
  U.uZS.value = S.stage.zs || clamp((2.5 * KW) / S.dur, 0.25, 3);
  U.uMinLen.value = 0.12;
  trailMat.uniforms.uGlow.value = S.stage.glow ?? 1;
  if (piece.hands) {
    try { S.hands = await (await fetch(piece.hands)).json(); } catch (e) { S.hands = null; }
  }
  rebuildAll();
  renderLabelList();
  wire();
  resize();
  setCam("auto");
  requestAnimationFrame(frame);
}

init().catch((e) => { $("#title").textContent = "couldn't open"; toast(e.message); });
