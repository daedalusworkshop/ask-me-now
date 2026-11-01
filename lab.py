#!/usr/bin/env python3
"""Listening Lab — local server. Start it with ./run.sh (or: python lab.py)."""

import csv
import hashlib
import io
import json
import mimetypes
import os
import re
import sys
import threading
import traceback
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlparse

from listening_lab import analysis as A
from listening_lab import beats as B
from listening_lab import jev as J
from listening_lab import midi_io, synth, testpieces
from listening_lab import theory as T
from listening_lab import transcribe as TR

ROOT = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(ROOT, "static")
WORK = os.path.join(ROOT, "work")
LIBRARY = os.path.join(ROOT, "library")  # your own pieces; git-ignored
PORT = int(os.environ.get("PORT", "8765"))

VIDEO_EXT = {".mp4", ".m4v", ".mov", ".webm"}
AUDIO_EXT = {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac", ".oga", ".opus"}
MIDI_EXT = {".mid", ".midi"}

SESSIONS = {}  # id -> dict(notes, media, info, title, last result, jev)
LOCK = threading.Lock()


# ---------------------------------------------------------------- sources

def session_from_test(name):
    t = testpieces.TESTS[name]
    sid = "test-" + name
    d = os.path.join(WORK, sid)
    os.makedirs(d, exist_ok=True)
    notes, _chart = testpieces.render_chart(t["chart"], t["tempo"])
    midi_io.write_midi(notes, os.path.join(d, "piece.mid"), t["tempo"])
    wav = os.path.join(d, "audio.wav")
    synth.render(notes, wav)
    _, info = midi_io.read_midi(os.path.join(d, "piece.mid"))
    return sid, {
        "title": t["title"], "notes": notes, "info": info,
        "media": {"url": f"/media/{sid}/audio.wav", "kind": "audio"},
        "transcriber": None, "defaults": {"chart": t["chart"], "tempo": t["tempo"]},
        "expect": t["expect"],
    }


def session_from_upload(path, filename, log=print):
    sid = os.path.basename(os.path.dirname(path))
    d = os.path.dirname(path)
    ext = os.path.splitext(filename)[1].lower()
    if ext in MIDI_EXT:
        notes, info = midi_io.read_midi(path)
        synth.render(notes, os.path.join(d, "audio.wav"))
        media = {"url": f"/media/{sid}/audio.wav", "kind": "audio"}
        transcriber = None
    else:
        wav = os.path.join(d, "audio.wav")
        if not os.path.exists(wav):
            TR.extract_audio(path, wav)
        mid = os.path.join(d, "transcribed.mid")
        tag = os.path.join(d, "transcriber.txt")
        paired = os.path.join(d, "paired.mid")  # a MIDI of this same recording, uploaded with it
        if os.path.exists(paired):
            notes, info = midi_io.read_midi(paired)  # keeps the MIDI's own beat grid
            off = midi_io.offset_to_audio(notes, wav)
            notes, info = midi_io.shift(notes, info, off)
            info["midi_offset"] = off
            transcriber = f"your MIDI (lined up {off:+.2f}s)" if off else "your MIDI"
        elif os.path.exists(mid) and os.path.exists(tag):
            transcriber = open(tag).read().strip()
        else:
            transcriber = TR.transcribe(wav, mid, log=log)
            open(tag, "w").write(transcriber)
        if not os.path.exists(paired):
            notes, info = midi_io.read_midi(mid)
            info["has_real_tempo"] = False  # transcriptions have no beat grid
        playable = os.path.basename(path)
        if ext in VIDEO_EXT:
            media = {"url": f"/media/{sid}/{playable}", "kind": "video"}
        elif ext in AUDIO_EXT:
            media = {"url": f"/media/{sid}/{playable}", "kind": "audio"}
        else:  # e.g. .mkv/.avi: play the extracted audio instead
            media = {"url": f"/media/{sid}/audio.wav", "kind": "audio"}
    return sid, {"title": filename, "notes": notes, "info": info, "media": media,
                 "transcriber": transcriber, "defaults": {}, "expect": None}


def list_library():
    """Pieces in library/: each subfolder is one piece (a recording, a MIDI,
    or both, which get paired). Loose files at the top count as pieces too."""
    items = []
    if not os.path.isdir(LIBRARY):
        return items
    media_ext = VIDEO_EXT | AUDIO_EXT | {".mkv", ".avi"}
    for name in sorted(os.listdir(LIBRARY), key=str.lower):
        full = os.path.join(LIBRARY, name)
        if os.path.isdir(full):
            files = sorted(os.listdir(full))
            media = next((f for f in files if os.path.splitext(f)[1].lower() in media_ext), None)
            midi = next((f for f in files if os.path.splitext(f)[1].lower() in MIDI_EXT), None)
            if media or midi:
                items.append({"id": name, "title": name, "media": media, "midi": midi})
        elif os.path.splitext(name)[1].lower() in media_ext | MIDI_EXT:
            items.append({"id": name, "title": os.path.splitext(name)[0],
                          "media": None if name.lower().endswith((".mid", ".midi")) else name,
                          "midi": name if name.lower().endswith((".mid", ".midi")) else None})
    return items


def session_from_library(item_id):
    import shutil
    item = next((i for i in list_library() if i["id"] == item_id), None)
    if not item:
        raise RuntimeError(f"'{item_id}' isn't in the library folder any more.")
    folder = os.path.join(LIBRARY, item_id) if os.path.isdir(os.path.join(LIBRARY, item_id)) else LIBRARY
    sid = "lib-" + hashlib.sha1(item_id.encode()).hexdigest()[:12]
    d = os.path.join(WORK, sid)
    os.makedirs(d, exist_ok=True)
    main = item["media"] or item["midi"]
    src = os.path.join(d, "source" + os.path.splitext(main)[1].lower())
    shutil.copyfile(os.path.join(folder, main), src)
    paired = os.path.join(d, "paired.mid")
    if item["media"] and item["midi"]:
        shutil.copyfile(os.path.join(folder, item["midi"]), paired)
    elif os.path.exists(paired):
        os.remove(paired)
    _sid, sess = session_from_upload(src, main)
    sess["title"] = item["title"]
    return sid, sess


# ---------------------------------------------------------------- analysis

def run_analysis(sess, p):
    notes = sess["notes"]
    info = sess["info"]
    if not notes:
        raise RuntimeError("No notes found in this input.")
    duration = max(e for _, e, _, _ in notes)
    bpb = int(p.get("beats_per_bar") or info.get("beats_per_bar") or 4)
    chart_text = (p.get("chart") or "").strip()
    tempo = float(p["tempo"]) if p.get("tempo") else None
    chart_start = float(p.get("chart_start") or 0.0)
    source = p.get("beat_source") or "auto"

    chart = None
    if chart_text:
        chart, _bars = T.parse_chart(chart_text, bpb)

    if source == "auto":
        if chart and tempo:
            source = "fixed"
        elif info.get("has_real_tempo"):
            source = "midi"
        else:
            source = "detected"

    if source == "fixed":
        if not tempo:
            raise RuntimeError("Fixed-tempo beats need a tempo (BPM).")
        period = 60.0 / tempo
        start0 = chart_start % period
        beat_times = B.fixed_grid(tempo, start0, duration + period)
        used_tempo = tempo
    elif source == "midi":
        beat_times = info["beat_times"]
        used_tempo = info["tempo_bpm"]
    else:
        beat_times, used_tempo = B.track_beats(notes, duration, tempo)

    chart_start_beat = 0
    for i, t in enumerate(beat_times):
        if t >= chart_start - 0.02:
            chart_start_beat = i
            break

    home = p.get("home_override")
    home = None if home in (None, "", "auto") else int(home)
    result = A.analyze(notes, beat_times, bpb, chart, chart_start_beat,
                       bool(p.get("chart_repeat", True)), home)
    result["info"] = {
        "beat_source": source, "tempo_bpm": round(used_tempo, 2),
        "transcriber": sess["transcriber"], "chart_used": bool(chart),
        "note_count": len(notes),
    }
    return result


def payload(sid, sess, result):
    return {
        "session": sid, "title": sess["title"], "media": sess["media"],
        "notes": [[round(s, 4), round(e, 4), p, v] for s, e, p, v in sess["notes"]],
        "analysis": result, "defaults": sess["defaults"], "expect": sess["expect"],
        "jev": sess.get("jev") or {"status": J.status(), "beats": None},
    }


# ---------------------------------------------------------------- 3D stage

def get_session(sid):
    """The session for this id, rebuilt from work/ if the server restarted."""
    if sid in SESSIONS:
        return SESSIONS[sid]
    if sid.startswith("test-") and sid[5:] in testpieces.TESTS:
        _, sess = session_from_test(sid[5:])
    elif sid.startswith("lib-"):
        item = next((i for i in list_library()
                     if "lib-" + hashlib.sha1(i["id"].encode()).hexdigest()[:12] == sid), None)
        if not item:
            return None
        _, sess = session_from_library(item["id"])
    else:
        d = os.path.join(WORK, sid)
        if not os.path.isdir(d):
            return None
        src = [f for f in os.listdir(d) if f.startswith("source")]
        if not src:
            return None
        _, sess = session_from_upload(os.path.join(d, src[0]), open(os.path.join(d, "name.txt")).read())
    SESSIONS[sid] = sess
    return sess


def stage_payload(sid, sess):
    """Everything the 3D stage needs: the notes, the media, and what you saved
    there before (keyboard corners, labels, look settings)."""
    d = os.path.join(WORK, sid)
    stage = {}
    if os.path.exists(os.path.join(d, "stage.json")):
        with open(os.path.join(d, "stage.json")) as f:
            stage = json.load(f)
    notes = sess["notes"]
    return {
        "session": sid, "title": sess["title"], "media": sess["media"],
        "notes": [[round(s, 4), round(e, 4), p, v] for s, e, p, v in notes],
        "duration": max((e for _, e, _, _ in notes), default=0.0),
        "stage": stage,
        "hands": f"/media/{sid}/hands.json" if os.path.exists(os.path.join(d, "hands.json")) else None,
    }


# ---------------------------------------------------------------- export

def export_csv(sess):
    r = sess["result"]
    jv = (sess.get("jev") or {}).get("beats")
    bpb = r["beats_per_bar"]
    out = io.StringIO()
    w = csv.writer(out)
    head = ["bar", "beat", "t0", "t1", "chord", "chord_source", "chord_conf",
            "detected_chord", "detected_conf", "heading_1", "heading_1_weight", "heading_1_rule",
            "heading_2", "heading_2_weight", "heading_2_rule",
            "gap_fifths", "gap_fifths_top", "gap_semitones", "gap_semitones_top",
            "arrival", "home_arrival", "function", "roughness", "bass", "global_home"]
    for al in ("centered", "trailing"):
        for wb in A.SETTINGS["window_bars"]:
            head += [f"local_home_{al}_{wb}bar", f"local_home_p_{al}_{wb}bar", f"confidence_{al}_{wb}bar"]
    head += ["chroma_" + n for n in T.PC_NAMES]
    if jv:
        for f in J.OPTIONS:
            head += [f"jev_{f}", f"jev_{f}_p"]
    w.writerow(head)
    for b in r["beats"]:
        h = b["heading"] + [{"name": "", "w": "", "rule": ""}] * (2 - len(b["heading"]))
        row = [b["bar"], b["beat"], b["t0"], b["t1"], b["chord"]["label"], b["chord"]["source"],
               b["chord"]["conf"], b["detected"]["label"], b["detected"]["conf"],
               h[0]["name"], h[0]["w"], h[0]["rule"], h[1]["name"], h[1]["w"], h[1]["rule"],
               b["gap_fifths"], b["gap_fifths_top"], b["gap_semitones"], b["gap_semitones_top"],
               b["arrival"], b["home_arrival"], b["function"], b["roughness"],
               "" if b["bass"] is None else T.PC_NAMES[b["bass"]], r["global_home"]["name"]]
        for al in ("centered", "trailing"):
            for wb in A.SETTINGS["window_bars"]:
                L = r["local_home"][al][str(wb)]
                k = L["best"][b["i"]]
                row += [T.KEY_NAMES[k], L["probs"][b["i"]][k], L["confidence"][b["i"]]]
        row += b["chroma"]
        if jv:
            ans = jv[b["i"]]
            for f in J.OPTIONS:
                best = max(ans[f], key=ans[f].get)
                row += [best, round(ans[f][best], 4)]
        w.writerow(row)
    return out.getvalue()


# ---------------------------------------------------------------- http

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        if "/api/" in (args[0] if args else ""):
            sys.stderr.write("  " + (fmt % args) + "\n")

    def _json(self, obj, code=200):
        data = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _error(self, msg, code=400):
        self._json({"error": msg}, code)

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _file(self, path, ctype=None, download=None):
        if not os.path.isfile(path):
            return self._error("not found", 404)
        size = os.path.getsize(path)
        ctype = ctype or mimetypes.guess_type(path)[0] or "application/octet-stream"
        rng = self.headers.get("Range")
        start, end = 0, size - 1
        if rng:
            m = re.match(r"bytes=(\d*)-(\d*)", rng)
            if m:
                if m.group(1):
                    start = int(m.group(1))
                    end = int(m.group(2)) if m.group(2) else size - 1
                else:
                    start = size - int(m.group(2))
                end = min(end, size - 1)
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        if download:
            self.send_header("Content-Disposition", f'attachment; filename="{download}"')
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            left = end - start + 1
            while left > 0:
                chunk = f.read(min(1 << 16, left))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (BrokenPipeError, ConnectionResetError):
                    return
                left -= len(chunk)

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        try:
            if path == "/":
                return self._file(os.path.join(STATIC, "index.html"), "text/html; charset=utf-8")
            if path == "/stage":
                return self._file(os.path.join(STATIC, "stage.html"), "text/html; charset=utf-8")
            m = re.match(r"^/api/piece/([\w-]+)$", path)
            if m:
                with LOCK:
                    sess = get_session(m.group(1))
                if not sess:
                    return self._error("That piece isn't loaded. Open it in the main page first.", 404)
                return self._json(stage_payload(m.group(1), sess))
            if path.startswith("/static/"):
                f = os.path.normpath(os.path.join(STATIC, path[len("/static/"):]))
                if not f.startswith(STATIC):
                    return self._error("bad path", 403)
                return self._file(f)
            if path.startswith("/media/"):
                f = os.path.normpath(os.path.join(WORK, path[len("/media/"):]))
                if not f.startswith(WORK):
                    return self._error("bad path", 403)
                return self._file(f)
            if path == "/api/install-transcriber":
                return self._json(TR.INSTALL)
            if path == "/api/status":
                return self._json({
                    "transcriber": TR.available(),
                    "ffmpeg": bool(TR.ffmpeg_exe()),
                    "jev": J.status(),
                    "tests": {k: {"title": v["title"], "expect": v["expect"]} for k, v in testpieces.TESTS.items()},
                    "library": list_library(),
                    "keys": T.KEY_NAMES,
                })
            m = re.match(r"^/api/export/([\w.-]+)\.(csv|json)$", path)
            if m:
                sess = SESSIONS.get(m.group(1))
                if not sess or "result" not in sess:
                    return self._error("analyse something first", 404)
                base = re.sub(r"[^\w-]+", "_", os.path.splitext(sess["title"])[0])[:60]
                if m.group(2) == "csv":
                    data = export_csv(sess).encode()
                    ctype = "text/csv"
                else:
                    data = json.dumps(payload(m.group(1), sess, sess["result"]), indent=1).encode()
                    ctype = "application/json"
                self.send_response(200)
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Disposition", f'attachment; filename="listening-lab_{base}.{m.group(2)}"')
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
                return
            return self._error("not found", 404)
        except Exception as e:
            traceback.print_exc()
            return self._error(str(e), 500)

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/upload":
                name = os.path.basename(unquote(self.headers.get("X-Filename") or "upload.bin"))
                ext = os.path.splitext(name)[1].lower()
                if ext not in VIDEO_EXT | AUDIO_EXT | MIDI_EXT | {".mkv", ".avi"}:
                    return self._error(f"Unsupported file type '{ext}'.")
                data = self._body()
                pair = self.headers.get("X-Pair-With")
                if pair:  # a MIDI of an audio/video upload: use its notes instead of transcribing
                    d = os.path.join(WORK, os.path.basename(pair))
                    if ext not in MIDI_EXT or not os.path.isdir(d):
                        return self._error("Pairing needs a MIDI file and an uploaded recording.")
                    with open(os.path.join(d, "paired.mid"), "wb") as f:
                        f.write(data)
                    with LOCK:
                        SESSIONS.pop(os.path.basename(pair), None)
                    return self._json({"upload": os.path.basename(pair), "filename": name})
                sid = "up-" + hashlib.sha1(data).hexdigest()[:12]
                d = os.path.join(WORK, sid)
                os.makedirs(d, exist_ok=True)
                safe = "source" + ext
                with open(os.path.join(d, safe), "wb") as f:
                    f.write(data)
                with open(os.path.join(d, "name.txt"), "w") as f:
                    f.write(name)
                return self._json({"upload": sid, "filename": name})

            if path == "/api/analyze":
                p = json.loads(self._body() or b"{}")
                with LOCK:
                    if p.get("test"):
                        sid = "test-" + p["test"]
                        if sid not in SESSIONS:
                            sid, sess = session_from_test(p["test"])
                            SESSIONS[sid] = sess
                    elif p.get("library"):
                        sid = "lib-" + hashlib.sha1(p["library"].encode()).hexdigest()[:12]
                        if sid not in SESSIONS:
                            sid, sess = session_from_library(p["library"])
                            SESSIONS[sid] = sess
                    elif p.get("upload"):
                        sid = p["upload"]
                        if sid not in SESSIONS:
                            d = os.path.join(WORK, sid)
                            src = [f for f in os.listdir(d) if f.startswith("source")][0]
                            name = open(os.path.join(d, "name.txt")).read()
                            sid, sess = session_from_upload(os.path.join(d, src), name)
                            SESSIONS[sid] = sess
                    else:
                        return self._error("nothing to analyse")
                    sess = SESSIONS[sid]
                    if p.get("first_load") and sess["defaults"]:
                        # fill in the test's own chart/tempo where the form is empty
                        p = {**p, **{k: v for k, v in sess["defaults"].items() if not p.get(k)}}
                    result = run_analysis(sess, p)
                    sess["result"] = result
                    sess["params"] = p
                    sess.pop("jev", None)
                return self._json(payload(sid, sess, result))

            if path == "/api/install-transcriber":
                return self._json(TR.start_install())

            m = re.match(r"^/api/(stage|hands)/([\w-]+)$", path)
            if m:
                # 3D stage saves: stage.json (corners, labels, look) and hands.json (hand tracks)
                d = os.path.join(WORK, m.group(2))
                if not os.path.isdir(d):
                    return self._error("unknown piece", 404)
                data = self._body()
                if len(data) > (80 << 20):
                    return self._error("too big")
                json.loads(data)  # refuse anything that isn't JSON
                with open(os.path.join(d, m.group(1) + ".json"), "wb") as f:
                    f.write(data)
                return self._json({"ok": True})

            if path == "/api/jev-key":
                # Save the TypeSafe key to .env on this computer (git-ignored). Never logged.
                key = (json.loads(self._body() or b"{}").get("key") or "").strip()
                if not re.fullmatch(r"[\w.\-]{8,512}", key):
                    return self._error("That doesn't look like an API key.")
                env = os.path.join(ROOT, ".env")
                lines = [l for l in (open(env).read().splitlines() if os.path.exists(env) else [])
                         if not l.startswith("JEV_API_KEY=")]
                with open(env, "w") as f:
                    f.write("\n".join(lines + [f"JEV_API_KEY={key}"]) + "\n")
                return self._json({"jev": J.status()})

            if path == "/api/jev-custom":
                p = json.loads(self._body() or b"{}")
                sess = SESSIONS.get(p.get("session"))
                if not sess or "result" not in sess:
                    return self._error("analyse something first", 404)
                texts = [t for t in (p.get("questions") or []) if isinstance(t, str) and t.strip()]
                if not texts:
                    return self._error("no question")
                return self._json(J.ask_custom(sess["result"], sess["notes"], texts))

            if path == "/api/jev":
                p = json.loads(self._body() or b"{}")
                sess = SESSIONS.get(p.get("session"))
                if not sess or "result" not in sess:
                    return self._error("analyse something first")
                sess["jev"] = J.ask_jev(sess["result"], sess["notes"])
                return self._json(sess["jev"])
            return self._error("not found", 404)
        except Exception as e:
            traceback.print_exc()
            return self._error(str(e), 500)


def main():
    os.makedirs(WORK, exist_ok=True)
    try:
        srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        print(f"\n  Listening Lab is already running (port {PORT} is in use).\n"
              "  Close the other Listening Lab window first, then start it again.\n"
              "  (If you can't find it, restarting the computer also works.)\n")
        sys.exit(1)
    url = f"http://localhost:{PORT}"
    print(f"\n  Listening Lab is running at {url}\n  (press Ctrl+C to stop)\n")
    print(f"  transcriber: {TR.available() or 'none installed (MIDI + tests still work)'}")
    print(f"  Jev lane:    {J.status()['message']}\n")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        print("\n  stopped.")


if __name__ == "__main__":
    main()
