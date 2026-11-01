"""
OPTIONAL AI LANE — TypeSafe's Jev model (https://docs.typesafe.ai)
===================================================================

Everything about Jev lives in this file plus `jev_config.json`.

  * No API key  -> the lane shows "not connected". Nothing is sent anywhere.
  * API key set -> `ask_jev()` sends one request per batch of beats and
                   expects typed answers with probabilities back.

Where the key goes: put  JEV_API_KEY=...  in a file named `.env` in the
project folder (it is git-ignored), or set it as an environment variable.

`_call_jev()` talks to POST https://api.typesafe.ai/v1/systemone (see
docs.typesafe.ai/api/system-one): Bearer key, a JSON `state`, and named
typed questions (choice / noul). Answers come back with probabilities.

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
    # .env first, so a key saved from the app wins over an old environment variable
    env = os.path.join(ROOT, ".env")
    if os.path.exists(env):
        for line in open(env):
            line = line.strip()
            if line.startswith("JEV_API_KEY=") and len(line) > len("JEV_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    key = os.environ.get("JEV_API_KEY")
    return key.strip() if key else None


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
#
# How Jev works (docs.typesafe.ai): one POST to /v1/systemone carries a
# `state` (any JSON) plus a dict of named, typed `questions`. Each answer
# comes back under the same name. A "choice" answer has a `probabilities`
# dict over the options we defined; a "noul" answer is P(yes) in 0..1.
# Jev is good at short, literal judgments, so every beat gets its own five
# questions that name the beat directly, and the state holds only the beats
# near it (docs: "send only what the question needs").

PC_LONG = {"C": "C", "Db": "D-flat / C-sharp", "D": "D", "Eb": "E-flat / D-sharp",
           "E": "E", "F": "F", "F#": "F-sharp / G-flat", "G": "G",
           "Ab": "A-flat / G-sharp", "A": "A", "Bb": "B-flat / A-sharp", "B": "B"}

FUNCTION_TEXT = {
    "tonic": "the home chord or a stand-in for it (I, vi, iii in major; i, III in minor)",
    "predominant": "leads toward the dominant (ii, IV; iv or bVI in minor)",
    "dominant": "wants to resolve home (V, V7, vii-dim, or the tritone sub bII7)",
    "chromatic": "outside the home key: a secondary dominant, a ii-V into another key, a passing chord",
    "other": "no clear chord or function on this beat (silence, a single note, a fill)",
}

STATE_NOTE = (
    "Solo jazz piano, transcribed to notes and cut into beats. Each beat lists the "
    "chord label (from a chord chart if chord_source is 'chart', otherwise guessed "
    "by a simple detector that often misreads rootless jazz voicings), every note "
    "sounding on that beat, and the lowest note (bass). home_key is the key of the "
    "whole piece."
)


def _key_long(k):
    return PC_LONG[k[:-1]] + " minor" if k.endswith("m") else PC_LONG[k] + " major"


def _questions_for(b):
    """The five typed questions for one beat, named b<beat>_<field>."""
    where = f"beat {b['beat']} (bar {b['bar']}, beat {b['beat_in_bar']} of the bar) in state.beats"
    q = {}
    q[f"b{b['beat']}_chord_root"] = {
        "type": "choice",
        "instructions": f"For {where}: what is the root of the chord being played? Judge from the "
                        "sounding notes and bass as a jazz pianist would, not only from the label.",
        "criteria": {pc: f"root is {PC_LONG[pc]}" for pc in T.PC_NAMES},
    }
    q[f"b{b['beat']}_chord_function"] = {
        "type": "choice",
        "instructions": f"For {where}: what job does this chord do relative to state.home_key?",
        "criteria": dict(FUNCTION_TEXT),
    }
    q[f"b{b['beat']}_local_home"] = {
        "type": "choice",
        "instructions": f"For {where}: which key is the music in at this point? A key lasts "
                        "several bars and contains most of the chords in the two bars before and after "
                        "this beat; it is usually NOT simply the name of the current chord.",
        "criteria": {k: _key_long(k) for k in T.KEY_NAMES},
    }
    q[f"b{b['beat']}_heading"] = {
        "type": "choice",
        "instructions": f"For {where}: which key's home chord does this chord lead to? A dominant "
                        "seventh resolves down a fifth (G7 leads to C), a ii chord leads to the key a "
                        "whole step below (Dm7 leads to C), a tritone substitute resolves down a half "
                        "step (Db7 leads to C). A home chord leads to its own key.",
        "criteria": {k: _key_long(k) for k in T.KEY_NAMES},
    }
    q[f"b{b['beat']}_is_arrival"] = {
        "type": "noul",
        "instructions": f"For {where}: this beat is a point of arrival, where a chord progression "
                        "resolves (e.g. the chord after a V7, or the end of a phrase).",
    }
    return q


def ask_jev(analysis, notes):
    """Return {"status": {...}, "beats": [per-beat answers] or None}."""
    st = status()
    if not st["connected"]:
        return {"status": st, "beats": None}
    cfg = load_config()
    if st["mock"]:
        return {"status": st, "beats": _mock(analysis)}
    ctx = beat_context(analysis, notes)
    home = analysis["global_home"]["name"]
    size = int(cfg.get("batch_size", 8))
    window = int(cfg.get("context_beats", 12))
    jobs = []
    for start in range(0, len(ctx), size):
        batch = list(range(start, min(len(ctx), start + size)))
        lo, hi = max(0, batch[0] - window), min(len(ctx), batch[-1] + window + 1)
        jobs.append((batch, {"home_key": home, "context": ctx[lo:hi],
                             "answer_for": [ctx[i] for i in batch]}))
    try:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=int(cfg.get("parallel_requests", 4))) as pool:
            results = list(pool.map(lambda j: _call_jev(cfg, j[1]), jobs))
    except Exception as e:  # keep the app usable whatever goes wrong
        return {"status": {"connected": False, "mock": False, "message": f"error: {e}"}, "beats": None}
    answers = [_validate(item) for raw in results for item in raw]
    return {"status": st, "beats": answers}


def _call_jev(cfg, payload):
    """One System One request for a batch of beats.

    Returns a list with one dict per beat in payload["answer_for"], each like
    {"chord_root": {"C": 0.1, ...}, ..., "is_arrival": {"yes": .2, "no": .8}}.
    """
    state = {
        "about": STATE_NOTE,
        "home_key": _key_long(payload["home_key"]),
        "beats": payload["context"],
    }
    questions = {}
    for b in payload["answer_for"]:
        questions.update(_questions_for(b))
    data = _post(cfg, {"model": cfg.get("model", "jev-latest"), "state": state, "questions": questions})
    ans = data["answers"]
    out = []
    for b in payload["answer_for"]:
        item = {}
        for name in ("chord_root", "chord_function", "local_home", "heading"):
            item[name] = ans[f"b{b['beat']}_{name}"]["probabilities"]
        p = float(ans[f"b{b['beat']}_is_arrival"]["noul"])
        item["is_arrival"] = {"yes": p, "no": 1.0 - p}
        out.append(item)
    return out


def _post(cfg, body):
    """POST one System One request, retrying on rate limits / overload."""
    import time
    data = json.dumps(body).encode()
    url = cfg["base_url"].rstrip("/") + "/" + cfg["endpoint"].lstrip("/")
    for attempt in range(6):
        req = urllib.request.Request(url, data=data, method="POST", headers={
            "Authorization": f"Bearer {api_key()}", "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=float(cfg.get("timeout_seconds", 60))) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            if e.code in (429, 529) and attempt < 5:
                time.sleep(min(float(e.headers.get("retry-after") or 2 ** attempt), 30))
                continue
            raise RuntimeError(f"Jev HTTP {e.code}: {e.read()[:300].decode(errors='replace')}")


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


# ---------------------------------------------------------------- your own rows
#
# A row you add in the app is one sentence. For every beat, Jev gets that
# sentence word for word as a yes/no ("noul") question, and a state that is
# only data: this beat, the 4 beats before it and the 4 after it. Nothing is
# added to your wording. The row shows Jev's probability of "yes" per beat.

def custom_state(ctx, i, around=4):
    return {
        "this_beat": ctx[i],
        "beats_before": ctx[max(0, i - around):i],
        "beats_after": ctx[i + 1:i + 1 + around],
    }


def ask_custom(analysis, notes, texts):
    """Return {"status": ..., "values": [[P(yes) per beat] per text] or None}."""
    st = status()
    if not st["connected"]:
        return {"status": st, "values": None}
    if st["mock"]:
        rng = random.Random(len(texts))
        return {"status": st, "values": [[rng.random() for _ in analysis["beats"]] for _ in texts]}
    cfg = load_config()
    ctx = beat_context(analysis, notes)
    questions = {f"q{k}": {"type": "noul", "instructions": t} for k, t in enumerate(texts)}

    def one(i):
        body = {"model": cfg.get("model", "jev-latest"), "state": custom_state(ctx, i), "questions": questions}
        ans = _post(cfg, body)["answers"]
        return [float(ans[f"q{k}"]["noul"]) for k in range(len(texts))]

    try:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=int(cfg.get("parallel_requests", 4)) * 2) as pool:
            per_beat = list(pool.map(one, range(len(ctx))))
    except Exception as e:
        return {"status": {"connected": False, "mock": False, "message": f"error: {e}"}, "values": None}
    return {"status": st, "values": [[row[k] for row in per_beat] for k in range(len(texts))]}
