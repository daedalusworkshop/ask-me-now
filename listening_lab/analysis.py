"""Per-beat analysis: position, home (global + local), heading, gap,
confidence, roughness, arrival, harmonic function.

All deterministic. The numbers that shape the results are collected in
SETTINGS at the top so they're easy to find and change."""

import math

import numpy as np

from . import theory as T

SETTINGS = {
    # How sharply key correlations become probabilities. Smaller = more
    # decisive. (Correlations sit between -1 and 1; 0.1 means a key whose
    # correlation is 0.1 higher is e≈2.7x more likely.)
    "key_softmax_temperature": 0.1,
    # Same idea for chord-template matching confidence.
    "chord_softmax_temperature": 0.04,
    # Bonus when the lowest note is the chord root (helps C6 vs A-7).
    "chord_bass_bonus": 0.08,
    # Local-home window sizes offered by the slider, in bars.
    "window_bars": [1, 2, 3, 4, 5, 6, 7, 8],
    # Roughness: harmonics per note, and how fast they fall off.
    "roughness_harmonics": 6,
    "roughness_rolloff": 0.88,
    # Heading rule weights (before normalising to sum to 1).
    "heading": {
        "dominant_down_fifth": 0.6,      # C7 -> F
        "dominant_tritone_sub": 0.4,     # C7 -> B (down a half step)
        "ii_V_bonus": 0.6,               # added when a matching ii precedes
        "ii_subV_bonus": 0.6,            # Eb-7 D7 -> Db
        "m7_as_ii": 0.55,                # D-7 alone -> C
        "m7_as_minor_tonic": 0.45,       # D-7 alone -> D minor
        "ii_before_V": 1.0,              # D-7 followed by G7 (or Db7) -> C
        "ii_before_V_self": 0.2,
        "major_as_tonic": 0.75,          # Cmaj7 -> C
        "major_as_IV": 0.25,             # Fmaj7 -> C
        "minor_as_tonic": 0.7,
        "minor_as_iv": 0.3,
    },
}

ROUGH_B1, ROUGH_B2 = 3.5, 5.75
ROUGH_DSTAR, ROUGH_S1, ROUGH_S2 = 0.24, 0.0207, 18.96


# ---------------------------------------------------------------- features

def beat_features(notes, beat_times):
    """Chroma, bass and the list of sounding notes for each beat."""
    nb = len(beat_times) - 1
    chroma = np.zeros((nb, 12))
    sounding = [[] for _ in range(nb)]
    bass = [None] * nb
    bt = np.asarray(beat_times)
    for s, e, p, v in notes:
        i0 = max(0, int(np.searchsorted(bt, s, side="right")) - 1)
        i = i0
        while i < nb and bt[i] < e:
            ov = min(e, bt[i + 1]) - max(s, bt[i])
            if ov > 0:
                frac = ov / (bt[i + 1] - bt[i])
                chroma[i, p % 12] += ov * v / 127.0
                sounding[i].append((p, v / 127.0 * frac, frac))
            i += 1
    for i in range(nb):
        cands = [p for p, _a, frac in sounding[i] if frac >= 0.25]
        if cands:
            bass[i] = min(cands) % 12
    return chroma, bass, sounding


def roughness(sounding):
    """Plomp–Levelt dissonance (Sethares' parameterisation), summed over
    every pair of partials that belong to *different* notes."""
    if len(sounding) < 2:
        return 0.0
    nh = SETTINGS["roughness_harmonics"]
    roll = SETTINGS["roughness_rolloff"]
    freqs, amps, owner = [], [], []
    for idx, (p, a, _frac) in enumerate(sounding):
        f0 = 440.0 * 2 ** ((p - 69) / 12.0)
        for k in range(1, nh + 1):
            freqs.append(f0 * k)
            amps.append(a * roll ** (k - 1))
            owner.append(idx)
    f = np.array(freqs)
    a = np.array(amps)
    o = np.array(owner)
    i, j = np.triu_indices(len(f), k=1)
    keep = o[i] != o[j]
    i, j = i[keep], j[keep]
    fmin = np.minimum(f[i], f[j])
    df = np.abs(f[i] - f[j])
    s = ROUGH_DSTAR / (ROUGH_S1 * fmin + ROUGH_S2)
    d = np.minimum(a[i], a[j]) * (np.exp(-ROUGH_B1 * s * df) - np.exp(-ROUGH_B2 * s * df))
    return float(d.sum())


# ---------------------------------------------------------------- chords

_TEMPLATES = [
    (r, q, T.chord_template(r, q) / math.sqrt(len(T.CHORD_QUALITIES[q])))
    for r in range(12) for q in T.CHORD_QUALITIES
]


def detect_chord(chroma, bass):
    """Template matching. Returns dict(root, quality, label, conf, alts)."""
    total = chroma.sum()
    if total <= 1e-6:
        return {"root": None, "quality": None, "label": "N.C.", "conf": 0.0, "alts": []}
    c = chroma / (np.linalg.norm(chroma) or 1.0)
    scores = []
    for r, q, t in _TEMPLATES:
        sc = float(c @ t) + T.QUALITY_PRIOR[q]
        if bass is not None and bass == r:
            sc += SETTINGS["chord_bass_bonus"]
        scores.append(sc)
    scores = np.array(scores)
    probs = T.softmax(scores, SETTINGS["chord_softmax_temperature"])
    order = np.argsort(-scores)
    r, q, _ = _TEMPLATES[order[0]]
    alts = [
        {"label": T.chord_label(_TEMPLATES[k][0], _TEMPLATES[k][1]), "p": round(float(probs[k]), 3)}
        for k in order[1:3]
    ]
    return {"root": r, "quality": q, "label": T.chord_label(r, q),
            "conf": round(float(probs[order[0]]), 3), "alts": alts}


# ---------------------------------------------------------------- heading

def heading_candidates(chord, prev, nxt):
    """Where does this chord want to go? Returns up to two
    (pc, mode, weight, rule) tuples, weights summing to 1."""
    W = SETTINGS["heading"]
    if chord is None or chord[0] is None:
        return []
    r, q = chord
    cands = []

    def add(pc, mode, w, rule):
        cands.append((pc % 12, mode, w, rule))

    pr, pq = prev if prev else (None, None)
    nr, nq = nxt if nxt else (None, None)

    if q in T.DOMINANT_QUALITIES or q == "sus4":
        w5 = W["dominant_down_fifth"]
        wt = W["dominant_tritone_sub"]
        mode5 = "major"
        rule5, rulet = "V → I", "tritone sub ↓½"
        if pq in ("m7", "m7b5", "min") and pr == (r + 7) % 12:
            w5 += W["ii_V_bonus"]
            rule5 = "ii–V → I"
            if pq == "m7b5":
                mode5 = "minor"
                rule5 = "iiø–V → i"
        if pq in ("m7", "min") and pr == (r + 1) % 12:
            wt += W["ii_subV_bonus"]
            rulet = "ii–subV → I"
        add(r + 5, mode5, w5, rule5)
        add(r - 1, "major", wt, rulet)
    elif q in ("m7", "m7b5"):
        if nq in T.DOMINANT_QUALITIES and nr in ((r + 5) % 12, (r - 1) % 12):
            mode = "minor" if q == "m7b5" else "major"
            rule = "ii–V → I" if nr == (r + 5) % 12 else "ii–subV → I"
            if q == "m7b5":
                rule = rule.replace("ii", "iiø").replace("→ I", "→ i")
            add(r - 2, mode, W["ii_before_V"], rule)
            add(r, "minor", W["ii_before_V_self"], "as minor tonic")
        elif q == "m7b5":
            add(r - 2, "minor", W["m7_as_ii"], "iiø → i")
            add(r + 1, "major", W["m7_as_minor_tonic"], "viiø → I")
        else:
            add(r - 2, "major", W["m7_as_ii"], "as ii → I")
            add(r, "minor", W["m7_as_minor_tonic"], "as minor tonic")
    elif q in T.MAJOR_QUALITIES:
        add(r, "major", W["major_as_tonic"], "rests on itself")
        add(r + 7, "major", W["major_as_IV"], "as IV → I")
    elif q in T.MINOR_QUALITIES:
        add(r, "minor", W["minor_as_tonic"], "rests on itself")
        add(r + 7, "minor", W["minor_as_iv"], "as iv → i")
    elif q in ("dim", "dim7"):
        add(r + 1, "major", 0.5, "leading tone → I")
        add(r + 1, "minor", 0.5, "leading tone → i")

    # merge duplicates, keep the top two, normalise
    merged = {}
    for pc, mode, w, rule in cands:
        k = (pc, mode)
        if k in merged:
            merged[k] = (pc, mode, merged[k][2] + w, merged[k][3] + " + " + rule)
        else:
            merged[k] = (pc, mode, w, rule)
    top = sorted(merged.values(), key=lambda c: -c[2])[:2]
    tot = sum(c[2] for c in top) or 1.0
    return [(pc, mode, w / tot, rule) for pc, mode, w, rule in top]


# ---------------------------------------------------------------- function

def harmonic_function(root, quality, home_pc, home_mode):
    """tonic / predominant / dominant / chromatic / other, relative to home."""
    if root is None:
        return "other"
    iv = (root - home_pc) % 12
    if quality in T.DOMINANT_QUALITIES or quality == "sus4":
        return "dominant" if iv in (7, 11, 1) else "chromatic"
    if quality in ("dim", "dim7"):
        return "dominant" if iv == 11 else "chromatic"
    if quality == "m7b5":
        return {2: "predominant", 11: "dominant"}.get(iv, "chromatic")
    if home_mode == "major":
        if quality in T.MAJOR_QUALITIES:
            return {0: "tonic", 5: "predominant", 7: "dominant"}.get(iv, "chromatic")
        return {9: "tonic", 4: "tonic", 2: "predominant", 5: "predominant"}.get(iv, "chromatic")
    # minor home
    if quality in T.MAJOR_QUALITIES:
        return {3: "tonic", 8: "predominant", 7: "dominant"}.get(iv, "chromatic")
    return {0: "tonic", 5: "predominant", 2: "predominant"}.get(iv, "chromatic")


# ---------------------------------------------------------------- main

def analyze(notes, beat_times, beats_per_bar=4, chart=None, chart_start_beat=0,
            chart_repeat=True, home_override=None):
    """notes: list of (start, end, pitch, velocity). beat_times: beat
    onsets in seconds. chart: per-beat list from theory.parse_chart, or
    None. home_override: key index 0-23 or None."""
    last_end = max((e for _, e, _, _ in notes), default=0.0)
    bt = [t for t in beat_times]
    # keep beats that start before the music ends, plus a closing edge
    keep = [t for t in bt if t < last_end - 1e-3]
    if not keep:
        keep = bt[:1]
    nxt = [t for t in bt if t >= keep[-1] + 1e-6]
    beat_edges = keep + [nxt[0] if nxt else keep[-1] + 0.5]
    nb = len(beat_edges) - 1

    chroma, bass, sounding = beat_features(notes, beat_edges)

    # ---- position
    detected = [detect_chord(chroma[i], bass[i]) for i in range(nb)]
    chords = []
    for i in range(nb):
        c = None
        if chart:
            k = i - chart_start_beat
            if k >= 0 and (k < len(chart) or chart_repeat):
                root, q, label, _sym = chart[k % len(chart)]
                c = {"root": root, "quality": q, "label": label, "conf": 1.0, "source": "chart"}
        if c is None:
            d = detected[i]
            c = {"root": d["root"], "quality": d["quality"], "label": d["label"],
                 "conf": d["conf"], "source": "detected"}
        chords.append(c)

    # ---- segments (runs of the same chord)
    segs = []
    for i, c in enumerate(chords):
        # chart events start new segments when the chart changes chord;
        # a chart bar written as "C C" still counts as one held chord
        if segs and segs[-1]["label"] == c["label"]:
            segs[-1]["end"] = i + 1
        else:
            segs.append({"start": i, "end": i + 1, "label": c["label"],
                         "root": c["root"], "quality": c["quality"]})

    # ---- global home
    total = chroma.sum(axis=0)
    gcorr = T.key_correlations(total)
    g_order = np.argsort(-gcorr)
    auto_home = int(g_order[0])
    home = auto_home if home_override is None else int(home_override)
    home_pc, home_mode = home % 12, ("minor" if home >= 12 else "major")

    # ---- heading, arrival
    heading = [[] for _ in range(nb)]
    arrival = [0.0] * nb
    for si, sg in enumerate(segs):
        prev = (segs[si - 1]["root"], segs[si - 1]["quality"]) if si > 0 else None
        nx = (segs[si + 1]["root"], segs[si + 1]["quality"]) if si + 1 < len(segs) else None
        cands = heading_candidates((sg["root"], sg["quality"]), prev, nx)
        sg["heading"] = cands
        for i in range(sg["start"], sg["end"]):
            heading[i] = cands
        # arrival: this chord is where the previous chord was heading, and
        # it is not itself a dominant (which would keep the motion going)
        if si > 0 and sg["root"] is not None and sg["quality"] not in T.DOMINANT_QUALITIES:
            for pc, mode, w, _rule in segs[si - 1].get("heading", []):
                tonic_ok = sg["quality"] in (T.MAJOR_QUALITIES if mode == "major" else T.MINOR_QUALITIES | {"m7"})
                if pc == sg["root"] and tonic_ok:
                    arrival[sg["start"]] = max(arrival[sg["start"]], w)

    # ---- gap
    def gap_for(cands, dist):
        if not cands:
            return None, None
        exp = sum(w * dist(pc, home_pc) for pc, _m, w, _r in cands)
        return exp, dist(cands[0][0], home_pc)

    # ---- local home, confidence
    local = {}
    for align in ("centered", "trailing"):
        local[align] = {}
        for wb in SETTINGS["window_bars"]:
            n = wb * beats_per_bar
            probs, conf, best = [], [], []
            for i in range(nb):
                if align == "centered":
                    a, b = i - n // 2, i - n // 2 + n
                else:
                    a, b = i - n + 1, i + 1
                a, b = max(0, a), min(nb, b)
                win = chroma[a:b].sum(axis=0)
                corr = T.key_correlations(win)
                if not corr.any():
                    pr = np.full(24, 1 / 24)
                else:
                    pr = T.softmax(corr, SETTINGS["key_softmax_temperature"])
                ent = -(pr * np.log(pr + 1e-12)).sum() / math.log(24)
                probs.append([round(float(x), 4) for x in pr])
                conf.append(round(float(1 - ent), 4))
                best.append(int(np.argmax(pr)))
            local[align][str(wb)] = {"probs": probs, "confidence": conf, "best": best}

    # ---- per-beat records
    beats = []
    for i in range(nb):
        c = chords[i]
        gf, gf1 = gap_for(heading[i], T.fifths_distance)
        gs, gs1 = gap_for(heading[i], T.semitone_distance)
        beats.append({
            "i": i,
            "t0": round(beat_edges[i], 4),
            "t1": round(beat_edges[i + 1], 4),
            "bar": i // beats_per_bar + 1,
            "beat": i % beats_per_bar + 1,
            "chord": c,
            "detected": detected[i],
            "heading": [
                {"key": T.key_index(pc, m), "name": T.key_name(pc, m), "pc": pc,
                 "mode": m, "w": round(w, 3), "rule": rule}
                for pc, m, w, rule in heading[i]
            ],
            "gap_fifths": None if gf is None else round(gf, 3),
            "gap_fifths_top": gf1,
            "gap_semitones": None if gs is None else round(gs, 3),
            "gap_semitones_top": gs1,
            "arrival": round(arrival[i], 3),
            "home_arrival": round(arrival[i], 3) if (arrival[i] > 0 and c["root"] == home_pc) else 0.0,
            "function": harmonic_function(c["root"], c["quality"], home_pc, home_mode),
            "roughness": round(roughness(sounding[i]), 4),
            "bass": bass[i],
            "chroma": [round(float(x), 4) for x in chroma[i]],
        })

    return {
        "beats_per_bar": beats_per_bar,
        "duration": round(beat_edges[-1], 3),
        "keys": T.KEY_NAMES,
        "global_home": {
            "key": home,
            "name": T.KEY_NAMES[home],
            "auto_key": auto_home,
            "auto_name": T.KEY_NAMES[auto_home],
            "overridden": home_override is not None,
            "top": [{"key": int(k), "name": T.KEY_NAMES[k], "r": round(float(gcorr[k]), 3)}
                    for k in g_order[:5]],
        },
        "beats": beats,
        "local_home": local,
        "segments": [{k: v for k, v in s.items() if k != "heading"} for s in segs],
        "settings": SETTINGS,
    }
