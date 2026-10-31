"""Test-mode report: run both built-in tests and check them against the
expectations, in plain language.   ./run.sh --selftest"""

import statistics

from . import analysis as A
from . import beats as B
from . import testpieces as tp
from . import theory as T


def run(name, home=None):
    t = tp.TESTS[name]
    notes, chart = tp.render_chart(t["chart"], t["tempo"])
    grid = B.fixed_grid(t["tempo"], 0, max(e for _, e, _, _ in notes) + 1)
    with_chart = A.analyze(notes, grid, 4, chart, home_override=home)
    no_chart = A.analyze(notes, grid, 4, None, home_override=home)
    return with_chart, no_chart


def mark(ok):
    return "  ✓" if ok else "  ✗"


def segs(r):
    out = []
    for b in r["beats"]:
        if not out or out[-1]["chord"]["label"] != b["chord"]["label"]:
            out.append(b)
    return out


def main():
    print("\n=== Test 1 · ii–V–I in C ===")
    r, nc = run("ii-V-I")
    g = r["global_home"]
    print(f"{mark(g['name'] == 'C')} global home: {g['name']}  (runner-up {g['top'][1]['name']})")
    det_ok = all(b["detected"]["label"] == b["chord"]["label"] for b in r["beats"])
    print(f"{mark(det_ok)} chord detector agrees with the chart on every beat")
    s = segs(r)
    for mode in ("fifths", "semitones"):
        vals = [(b["chord"]["label"], b["gap_" + mode]) for b in s[:3]]
        into_I = vals[2][1] < vals[1][1]
        print(f"{mark(into_I)} gap ({mode}, weighted) ii→V→I: " + "  ".join(f"{l} {v:.2f}" for l, v in vals))
    arrivals = [f"bar {b['bar']}" for b in r["beats"] if b["home_arrival"]]
    print(f"  · home arrivals at: {', '.join(arrivals)}")
    rough1 = statistics.mean(b["roughness"] for b in r["beats"])

    print("\n=== Test 2 · “Ask Me Now” A section ===")
    r2, _ = run("ask-me-now-A")
    g = r2["global_home"]
    print(f"{mark(g['name'] == 'Db')} global home (auto): {g['name']}  — ranking: "
          + ", ".join(f"{k['name']} {k['r']:.2f}" for k in g["top"]))
    db_rank = None
    from .theory import key_correlations
    import numpy as np
    total = np.array([b["chroma"] for b in r2["beats"]]).sum(axis=0)
    corr = key_correlations(total)
    db_rank = int((corr > corr[1]).sum()) + 1
    print(f"  · D♭ major ranks #{db_rank} of 24 (r = {corr[1]:.3f})")

    r2, _ = run("ask-me-now-A", home=1)  # Db
    s = segs(r2)
    iiV = [b for b in s if b["chord"]["quality"] == "m7"
           and b["heading"] and b["heading"][0]["rule"].startswith("ii")]
    targets = [b["heading"][0]["name"] for b in iiV]
    want = ["F", "E", "Eb", "D", "Db"]
    first5 = targets[:5]
    print(f"{mark(first5 == want)} ii–V headings (bars 1–3): {' → '.join(first5)}")
    print(f"  · all ii headings in order: {' → '.join(targets)}")
    last = r2["beats"][-1]
    h = {c["name"]: c["w"] for c in last["heading"]}
    print(f"{mark(set(h) == {'Db', 'G'})} final D7 headings: "
          + " / ".join(f"{k} {v:.0%} ({c['rule']})" for (k, v), c in zip(h.items(), last["heading"])))
    print("  gap toward D♭ along the ii–V chain (top heading only):")
    for mode in ("fifths", "semitones"):
        vals = [b["gap_" + mode + "_top"] for b in iiV[:5]]
        mono = all(a > b for a, b in zip(vals, vals[1:]))
        print(f"{mark(mono)}   {mode:9}: " + " → ".join(str(v) for v in vals)
              + ("  (shrinks steadily)" if mono else "  (not steady)"))
    rough2 = statistics.mean(b["roughness"] for b in r2["beats"])
    print(f"\nRoughness (mean per beat): test 1 = {rough1:.2f}, test 2 = {rough2:.2f}")
    print()


if __name__ == "__main__":
    main()
