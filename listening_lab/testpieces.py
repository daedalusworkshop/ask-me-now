"""Built-in test inputs: chord charts rendered to simple block-chord MIDI,
so the analysis can be checked against known answers."""

from . import theory as T

TESTS = {
    "ii-V-I": {
        "title": "Test 1 · ii–V–I in C, repeated",
        "chart": "| D-7 | G7 | Cmaj7 | Cmaj7 | D-7 | G7 | Cmaj7 | Cmaj7 | D-7 | G7 | Cmaj7 | Cmaj7 |",
        "tempo": 96,
        "expect": "Home = C. Gap shrinks into each I. Roughness low.",
    },
    "ask-me-now-A": {
        "title": "Test 2 · “Ask Me Now” A section (D♭)",
        "chart": ("| G-7 C7 F#-7 B7 | F-7 Bb7 E-7 A7 | Eb-7 Ab7 | B7 Bb7 | "
                  "Eb7 D7 | Dbmaj7 Eb7 | Eb-7 Ab7 | F-7 E7 Eb-7 D7 |"),
        "tempo": 72,
        "expect": ("Global home = D♭. ii–V headings step down F → E → E♭ → D → D♭. "
                   "Final D7 shows two headings: D♭ (tritone sub) and G (V of G)."),
    },
}


def voice(root, quality, low=50):
    """Root alone in the bass (octave 2); the remaining chord tones (or the
    whole triad) stacked in close position from around D3 upward."""
    pcs = T.chord_pcs(root, quality)
    bass = 36 + root  # C2..B2
    upper = []
    base = low
    for pc in (pcs[1:] if len(pcs) >= 4 else pcs):
        p = base + ((pc - base) % 12)
        while upper and p <= upper[-1]:
            p += 12
        upper.append(p)
    return [bass] + upper


def render_chart(chart_text, tempo, beats_per_bar=4, velocity=70):
    """Return (notes, per-beat chart) with each chord re-struck at every
    chord change and held until the next one."""
    chart, _bars = T.parse_chart(chart_text, beats_per_bar)
    spb = 60.0 / tempo
    notes = []
    i = 0
    while i < len(chart):
        j = i
        while j + 1 < len(chart) and chart[j + 1] is chart[i]:
            j += 1
        root, q, _label, _sym = chart[i]
        s, e = i * spb, (j + 1) * spb - 0.03
        if root is not None:
            for p in voice(root, q):
                notes.append((round(s, 4), round(e, 4), p, velocity))
        i = j + 1
    return notes, chart
