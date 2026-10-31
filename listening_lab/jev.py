"""
OPTIONAL AI LANE — TypeSafe's Jev model (https://docs.typesafe.ai)
===================================================================

Everything about Jev lives in this file plus `jev_config.json`.

  * No API key  -> the lane shows "not connected". Nothing is sent anywhere.
  * API key set -> `ask_jev()` sends one request per batch of beats and
                   expects typed answers with probabilities back.

Where the key goes: put  JEV_API_KEY=...  in a file named `.env` in the
project folder (it is git-ignored), or set it as an environment variable.

THE ONE FUNCTION TO EDIT is `_call_jev()`. I wrote it without access to
Jev's docs (they weren't reachable from where this was built), so the
request/response *shape* is a placeholder: match it to docs.typesafe.ai
once you have access. Everything around it (what we ask, how answers are
checked, normalised and compared) is done and doesn't need to change.

Each beat gets these typed outputs, each a probability distribution:
    chord_root      12 options   C, Db, D, ... B
    chord_function  5 options    tonic, predominant, dominant, chromatic, other
    local_home      24 options   C ... B, Cm ... Bm
    heading         24 options   C ... B, Cm ... Bm
    is_arrival      2 options    yes, no
"""

import json
import os
import random
import urllib.error
import urllib.request

from . import theory as T

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "jev_config.json")

OPTIONS = {
    "chord_root": T.PC_NAMES,
    "chord_function": ["tonic", "predominant", "dominant", "chromatic", "other"],
    "local_home": T.KEY_NAMES,
    "heading": T.KEY_NAMES,
    "is_arrival": ["yes", "no"],
}

QUESTION = (
    "You are analysing solo jazz piano one beat at a time. For the beat marked "
    "NOW, answer: where are we (chord_root, chord_function relative to the "
    "piece's home key), where's home right now (local_home), where does the "
    "music want to go next (heading), and is this the moment it arrives "
    "(is_arrival). Give a probability for every option."
)


def load_config():
    with open(CONFIG_PATH) as f:
        cfg = json.load(f)
    cfg = {k: v for k, v in cfg.items() if not k.startswith("_")}
    if os.environ.get("JEV_MODE"):  # e.g. JEV_MODE=mock ./run.sh
        cfg["mode"] = os.environ["JEV_MODE"]
    return cfg


def api_key():
    key = os.environ.get("JEV_API_KEY")
    if key:
        return key.strip()
    env = os.path.join(ROOT, ".env")
    if os.path.exists(env):
        for line in open(env):
            line = line.strip()
            if line.startswith("JEV_API_KEY=") and len(line) > len("JEV_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return None


def status():
    cfg = load_config()
    if cfg.get("mode") == "mock":
        return {"connected": True, "mock": True, "message": "MOCK data (not Jev) — for testing the comparison view"}
    if cfg.get("mode") == "off":
        return {"connected": False, "mock": False, "message": "turned off in jev_config.json"}
    if not api_key():
        return {"connected": False, "mock": False, "message": "not connected — no JEV_API_KEY set"}
    if not cfg.get("endpoint"):
        return {"connected": False, "mock": False,
                "message": "key found, but jev_config.json has no endpoint yet (see docs.typesafe.ai)"}
    return {"connected": True, "mock": False, "message": f"connected · {cfg.get('model')}"}


# ---------------------------------------------------------------- context

def beat_context(analysis, notes):
    """What Jev sees about each beat: the chord written or detected, the
    actual sounding notes, the bass, and the chords around it."""
    beats = analysis["beats"]
    ctx = []
    for b in beats:
        sounding = sorted({p for s, e, p, _v in notes if s < b["t1"] and e > b["t0"]})
        ctx.append({
            "beat": b["i"],
            "bar": b["bar"],
            "beat_in_bar": b["beat"],
            "chord": b["chord"]["label"],
            "chord_source": b["chord"]["source"],
            "sounding_notes": [T.PC_NAMES[p % 12] + str(p // 12 - 1) for p in sounding],
            "bass": None if b["bass"] is None else T.PC_NAMES[b["bass"]],
        })
    return ctx


# ---------------------------------------------------------------- the hook

def ask_jev(analysis, notes):
    """Return {"status": {...}, "beats": [per-beat answers] or None}."""
    st = status()
    if not st["connected"]:
        return {"status": st, "beats": None}
    cfg = load_config()
    ctx = beat_context(analysis, notes)
    if st["mock"]:
        return {"status": st, "beats": _mock(analysis)}
    answers = []
    size = int(cfg.get("batch_size", 16))
    window = int(cfg.get("context_beats", 8))
    try:
        for start in range(0, len(ctx), size):
            batch = list(range(start, min(len(ctx), start + size)))
            lo, hi = max(0, batch[0] - window), min(len(ctx), batch[-1] + window + 1)
            raw = _call_jev(cfg, {
                "question": QUESTION,
                "context": ctx[lo:hi],
                "answer_for_beats": batch,
                "outputs": OPTIONS,
            })
            for i, item in zip(batch, raw):
                answers.append(_validate(item))
    except Exception as e:  # keep the app usable whatever goes wrong
        return {"status": {"connected": False, "mock": False, "message": f"error: {e}"}, "beats": None}
    return {"status": st, "beats": answers}


def _call_jev(cfg, payload):
    """>>> EDIT THIS to match docs.typesafe.ai. <<<

    Must return a list with one dict per beat in payload["answer_for_beats"],
    each like {"chord_root": {"C": 0.1, ...}, "chord_function": {...},
    "local_home": {...}, "heading": {...}, "is_arrival": {"yes": .2, "no": .8}}.
    """
    body = {
        "model": cfg.get("model", "jev"),
        "input": payload,
        # Typed outputs: one categorical distribution per field, per beat.
        "output_schema": {
            "type": "array",
            "items": {name: {"type": "distribution", "options": opts} for name, opts in OPTIONS.items()},
        },
    }
    req = urllib.request.Request(
        cfg["base_url"].rstrip("/") + "/" + cfg["endpoint"].lstrip("/"),
        data=json.dumps(body).encode(),
        headers={"Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=float(cfg.get("timeout_seconds", 60))) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"HTTP {e.code}: {e.read()[:300].decode(errors='replace')}")
    # Adjust this line to wherever the per-beat answers sit in the response.
    return data.get("output") or data.get("answers") or data


def _validate(item):
    """Make every distribution complete, non-negative and summing to 1."""
    out = {}
    for name, opts in OPTIONS.items():
        d = item.get(name) or {}
        if isinstance(d, list):  # also accept a plain list in option order
            d = dict(zip(opts, d))
        vals = [max(0.0, float(d.get(o, 0.0))) for o in opts]
        tot = sum(vals)
        out[name] = {o: (v / tot if tot else 1.0 / len(opts)) for o, v in zip(opts, vals)}
    return out


def _mock(analysis):
    """Fake answers for testing the comparison UI: the deterministic answer
    with noise, and deliberately wrong on roughly one beat in six."""
    rng = random.Random(7)
    out = []
    local = analysis["local_home"]["centered"]["4"]["best"]
    for b in analysis["beats"]:
        def peaked(opts, right):
            if rng.random() < 0.17:
                right = rng.choice(opts)
            d = {o: rng.random() * 0.15 for o in opts}
            if right in d:
                d[right] += 0.8
            return d
        root = b["chord"]["root"]
        h = b["heading"][0]["name"] if b["heading"] else None
        out.append(_validate({
            "chord_root": peaked(T.PC_NAMES, None if root is None else T.PC_NAMES[root]),
            "chord_function": peaked(OPTIONS["chord_function"], b["function"]),
            "local_home": peaked(T.KEY_NAMES, T.KEY_NAMES[local[b["i"]]]),
            "heading": peaked(T.KEY_NAMES, h),
            "is_arrival": peaked(["yes", "no"], "yes" if b["arrival"] > 0 else "no"),
        }))
    return out
