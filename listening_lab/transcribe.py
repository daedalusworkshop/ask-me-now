"""Audio extraction (ffmpeg) and piano transcription (Transkun, or Basic
Pitch as a fallback). Both transcribers are optional extras; see README."""

import glob
import os
import shutil
import subprocess
import sys


def ffmpeg_exe():
    exe = shutil.which("ffmpeg")
    if exe:
        return exe
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


def extract_audio(src, dst_wav, sr=44100):
    exe = ffmpeg_exe()
    if not exe:
        raise RuntimeError("ffmpeg not found. Re-run ./run.sh (it installs a copy), "
                           "or install it with: brew install ffmpeg")
    cmd = [exe, "-y", "-loglevel", "error", "-i", src, "-vn", "-ac", "1", "-ar", str(sr), dst_wav]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError("ffmpeg couldn't read this file:\n" + r.stderr[-800:])
    return dst_wav


def _bin(name):
    """Find a console script in this venv first, then on PATH.
    (On Windows the script is name.exe next to python.exe in .venv/Scripts.)"""
    folder = os.path.dirname(sys.executable)
    for cand in (name, name + ".exe"):
        here = os.path.join(folder, cand)
        if os.path.exists(here):
            return here
    return shutil.which(name)


def _env_with_ffmpeg():
    """Transkun reads audio through pydub, which looks for a program called
    'ffmpeg'. If there isn't one on PATH, expose our bundled copy under that name."""
    env = dict(os.environ)
    if shutil.which("ffmpeg"):
        return env
    src = ffmpeg_exe()
    if not src:
        return env
    bindir = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "work", "bin")
    os.makedirs(bindir, exist_ok=True)
    dst = os.path.join(bindir, "ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    if not os.path.exists(dst):
        shutil.copyfile(src, dst)
        os.chmod(dst, 0o755)
    env["PATH"] = bindir + os.pathsep + env.get("PATH", "")
    return env


# ---- one-click install from the app (runs pip in the background)
INSTALL = {"state": "idle", "log": []}


# Transkun's own dependency list includes training-only packages; one of them
# (ncls) has to be compiled on Windows and fails without Microsoft's C++ tools.
# Transcribing needs only these (checked by running transkun with the rest blocked):
TRANSKUN_RUNTIME = ["torch", "torchaudio", "numpy", "moduleconf", "pydub", "soxr", "pretty_midi",
                    "mir_eval", "scipy", "tqdm",
                    "setuptools<81",                          # transkun imports pkg_resources
                    "audioop-lts; python_version>='3.13'"]    # pydub on Python 3.13+


def install_commands():
    pip = [sys.executable, "-m", "pip", "install", "--progress-bar", "off"]
    return [pip + ["--no-deps", "transkun"], pip + TRANSKUN_RUNTIME]


def start_install():
    import threading
    if INSTALL["state"] == "running":
        return INSTALL
    INSTALL.update(state="running", log=["Starting… this downloads PyTorch, so it can take 5–15 minutes."])

    def work():
        try:
            code = 0
            for cmd in install_commands():
                p = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
                for line in p.stdout:
                    line = line.strip()
                    if line:
                        INSTALL["log"] = (INSTALL["log"] + [line])[-40:]
                code = p.wait()
                if code:
                    break
            ok = code == 0 and available()
            INSTALL["state"] = "done" if ok else "failed"
            INSTALL["log"].append("Installed. You can now load any recording." if ok else
                                  f"Install failed (see above). Python {sys.version.split()[0]}.")
        except Exception as e:  # keep the server alive whatever happens
            INSTALL["state"] = "failed"
            INSTALL["log"].append(f"Install failed: {e}")

    threading.Thread(target=work, daemon=True).start()
    return INSTALL


def available():
    if _bin("transkun"):
        return "transkun"
    if _bin("basic-pitch"):
        return "basic-pitch"
    return None


def transcribe(wav, out_mid, log=print):
    """Transcribe wav -> MIDI. Returns the name of the transcriber used."""
    which = available()
    if which == "transkun":
        device = os.environ.get("TRANSKUN_DEVICE", "cpu")
        log(f"Transcribing with Transkun on {device} (a few minutes for a full tune)…")
        r = subprocess.run([_bin("transkun"), wav, out_mid, "--device", device],
                           capture_output=True, text=True, env=_env_with_ffmpeg())
        if r.returncode != 0 or not os.path.exists(out_mid):
            raise RuntimeError("Transkun failed:\n" + (r.stderr or r.stdout)[-1200:])
        return "transkun"
    if which == "basic-pitch":
        log("Transcribing with Basic Pitch (Transkun not installed)…")
        outdir = os.path.dirname(out_mid)
        for old in glob.glob(os.path.join(outdir, "*_basic_pitch.mid")):
            os.remove(old)
        r = subprocess.run([_bin("basic-pitch"), outdir, wav], capture_output=True, text=True, env=_env_with_ffmpeg())
        made = glob.glob(os.path.join(outdir, "*_basic_pitch.mid"))
        if r.returncode != 0 or not made:
            raise RuntimeError("Basic Pitch failed:\n" + (r.stderr or r.stdout)[-1200:])
        os.replace(made[0], out_mid)
        return "basic-pitch"
    raise RuntimeError("NO_TRANSCRIBER: No transcriber is installed, so audio can't be turned into notes yet.")


if __name__ == "__main__":
    # `python -m listening_lab.transcribe --install`: what run.sh / run.bat use
    if "--install" in sys.argv:
        for cmd in install_commands():
            r = subprocess.run(cmd)
            if r.returncode:
                sys.exit(r.returncode)
        print("Transkun installed." if available() else "Transkun didn't install.")
