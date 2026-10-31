"""Music-theory building blocks: pitch names, chord templates, key profiles,
chord-chart parsing, and distances. Everything here is deterministic."""

import re

import numpy as np

PC_NAMES = ["C", "Db", "D", "Eb", "E", "F", "F#", "G", "Ab", "A", "Bb", "B"]

# 24 keys: index 0-11 = major (C..B), 12-23 = minor (Cm..Bm)
KEY_NAMES = PC_NAMES + [n + "m" for n in PC_NAMES]


def key_index(pc, mode):
    return pc % 12 + (12 if mode == "minor" else 0)


def key_name(pc, mode):
    return KEY_NAMES[key_index(pc, mode)]


# ---------------------------------------------------------------- chords

# quality -> intervals above the root
CHORD_QUALITIES = {
    "maj": (0, 4, 7),
    "min": (0, 3, 7),
    "dim": (0, 3, 6),
    "aug": (0, 4, 8),
    "sus4": (0, 5, 7),
    "7": (0, 4, 7, 10),
    "maj7": (0, 4, 7, 11),
    "m7": (0, 3, 7, 10),
    "m7b5": (0, 3, 6, 10),
    "dim7": (0, 3, 6, 9),
    "mMaj7": (0, 3, 7, 11),
    "6": (0, 4, 7, 9),
    "m6": (0, 3, 7, 9),
    "7sus4": (0, 5, 7, 10),
}

# Display suffixes (jazz-chart style, matching how charts are usually written)
QUALITY_SUFFIX = {
    "maj": "", "min": "-", "dim": "°", "aug": "+", "sus4": "sus4", "7": "7",
    "maj7": "maj7", "m7": "-7", "m7b5": "ø7", "dim7": "°7", "mMaj7": "-maj7",
    "6": "6", "m6": "-6", "7sus4": "7sus4",
}

# Small prior so rarer chord types only win when the evidence is clearly better
QUALITY_PRIOR = {
    "maj": 0.0, "min": 0.0, "7": 0.0, "maj7": 0.0, "m7": 0.0, "m7b5": -0.01,
    "dim7": -0.01, "dim": -0.02, "6": -0.02, "m6": -0.02, "aug": -0.03,
    "sus4": -0.03, "7sus4": -0.03, "mMaj7": -0.04,
}

DOMINANT_QUALITIES = {"7", "7sus4", "aug"}
MAJOR_QUALITIES = {"maj", "maj7", "6"}
MINOR_QUALITIES = {"min", "m6", "mMaj7"}


def chord_label(root, quality):
    if root is None:
        return "N.C."
    return PC_NAMES[root] + QUALITY_SUFFIX[quality]


def chord_template(root, quality):
    t = np.zeros(12)
    for iv in CHORD_QUALITIES[quality]:
        t[(root + iv) % 12] = 1.0
    return t


def chord_pcs(root, quality):
    return [(root + iv) % 12 for iv in CHORD_QUALITIES[quality]]


# ---------------------------------------------------------------- chart parsing

_NOTE_RE = re.compile(r"^([A-Ga-g])([#b♯♭]?)(.*)$")
_LETTER_PC = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}


def _parse_root(letter, accidental):
    pc = _LETTER_PC[letter.upper()]
    if accidental in ("#", "♯"):
        pc += 1
    elif accidental in ("b", "♭"):
        pc -= 1
    return pc % 12


def parse_chord_symbol(sym):
    """'G-7' -> (7, 'm7'), 'Dbmaj7' -> (1, 'maj7'), 'Bb7#11' -> (10, '7').
    Returns (root, quality, bass) or raises ValueError."""
    s = sym.strip()
    if s.upper() in ("N.C.", "NC", "N.C"):
        return None, None, None
    bass = None
    if "/" in s:
        s, b = s.split("/", 1)
        m = _NOTE_RE.match(b.strip())
        if m:
            bass = _parse_root(m.group(1), m.group(2))
    m = _NOTE_RE.match(s)
    if not m:
        raise ValueError(f"can't read chord '{sym}'")
    root = _parse_root(m.group(1), m.group(2))
    q = m.group(3).strip()
    ql = q.lower().replace("(", "").replace(")", "")

    def has(*xs):
        return any(x in ql for x in xs)

    minor = q.startswith("-") or q.startswith("m") and not q.lower().startswith("maj")
    minor = minor or ql.startswith("min")
    if has("ø", "m7b5", "-7b5", "min7b5", "half"):
        quality = "m7b5"
    elif has("°7", "o7", "dim7"):
        quality = "dim7"
    elif has("°", "dim") or ql == "o":
        quality = "dim"
    elif has("sus"):
        quality = "7sus4" if has("7", "9", "11", "13") else "sus4"
    elif minor:
        rest = re.sub(r"^(min|mi|m|-)", "", q)
        rl = rest.lower()
        if "maj" in rl or "Δ" in rest or rl.startswith("M"):
            quality = "mMaj7"
        elif rl.startswith("6"):
            quality = "m6"
        elif any(c in rl for c in ("7", "9", "11", "13")):
            quality = "m7"
        else:
            quality = "min"
    elif has("maj", "Δ") or q.startswith("M"):
        quality = "maj7"
    elif has("+", "aug", "#5"):
        quality = "aug"
    elif ql.startswith("6") or ql.startswith("69"):
        quality = "6"
    elif any(c in ql for c in ("7", "9", "11", "13", "alt")):
        quality = "7"
    else:
        quality = "maj"
    return root, quality, bass


def parse_chart(text, beats_per_bar=4):
    """Parse '| G-7 C7 F#-7 B7 | F-7 Bb7 E-7 A7 |' into a per-beat list of
    (root, quality, label, symbol) tuples. Chords in a bar split the bar
    evenly. '%' or '/' repeats the previous chord. Returns (beats, bars)."""
    text = text.replace("\n", "|").replace("||", "|")
    bars = [b.strip() for b in text.split("|")]
    bars = [b for b in bars if b]
    out = []
    prev = None
    parsed_bars = []
    for bar in bars:
        toks = bar.split()
        chords = []
        for tok in toks:
            if tok in ("%", "/", "-"):
                if prev is None:
                    raise ValueError("'%' with no previous chord")
                chords.append(prev)
                continue
            root, quality, _ = parse_chord_symbol(tok)
            c = (root, quality, chord_label(root, quality), tok)
            chords.append(c)
            prev = c
        if not chords:
            continue
        n = len(chords)
        if beats_per_bar % n != 0 and n < beats_per_bar:
            # uneven split: give the first chords the extra beats
            per = [beats_per_bar // n + (1 if i < beats_per_bar % n else 0) for i in range(n)]
        elif n > beats_per_bar:
            raise ValueError(f"bar '{bar}' has more chords than beats")
        else:
            per = [beats_per_bar // n] * n
        parsed_bars.append([c[2] for c in chords])
        for c, k in zip(chords, per):
            out.extend([c] * k)
    return out, parsed_bars


# ---------------------------------------------------------------- keys

# Krumhansl–Kessler probe-tone profiles (C major / C minor)
KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])

KEY_PROFILES = np.array(
    [np.roll(KK_MAJOR, k) for k in range(12)] + [np.roll(KK_MINOR, k) for k in range(12)]
)


def key_correlations(chroma):
    """Pearson correlation of a 12-bin chroma with all 24 KK profiles."""
    c = np.asarray(chroma, dtype=float)
    if c.sum() <= 0 or np.allclose(c, c[0]):
        return np.zeros(24)
    cz = c - c.mean()
    pz = KEY_PROFILES - KEY_PROFILES.mean(axis=1, keepdims=True)
    num = pz @ cz
    den = np.sqrt((pz ** 2).sum(axis=1) * (cz ** 2).sum())
    return num / den


def softmax(x, temperature):
    z = np.asarray(x, dtype=float) / temperature
    z -= z.max()
    e = np.exp(z)
    return e / e.sum()


# ---------------------------------------------------------------- distances

def fifths_distance(a, b):
    """Steps around the circle of fifths between two pitch classes (0-6)."""
    pa, pb = (a * 7) % 12, (b * 7) % 12
    d = abs(pa - pb)
    return min(d, 12 - d)


def semitone_distance(a, b):
    """Half steps between two pitch classes, the short way round (0-6)."""
    d = abs(a - b) % 12
    return min(d, 12 - d)
