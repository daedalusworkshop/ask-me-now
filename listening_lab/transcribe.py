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
    """Find a console script in this venv first, then on PATH."""
    here = os.path.join(os.path.dirname(sys.executable), name)
    return here if os.path.exists(here) else shutil.which(name)


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
                           capture_output=True, text=True)
        if r.returncode != 0 or not os.path.exists(out_mid):
            raise RuntimeError("Transkun failed:\n" + (r.stderr or r.stdout)[-1200:])
        return "transkun"
    if which == "basic-pitch":
        log("Transcribing with Basic Pitch (Transkun not installed)…")
        outdir = os.path.dirname(out_mid)
        for old in glob.glob(os.path.join(outdir, "*_basic_pitch.mid")):
            os.remove(old)
        r = subprocess.run([_bin("basic-pitch"), outdir, wav], capture_output=True, text=True)
        made = glob.glob(os.path.join(outdir, "*_basic_pitch.mid"))
        if r.returncode != 0 or not made:
            raise RuntimeError("Basic Pitch failed:\n" + (r.stderr or r.stdout)[-1200:])
        os.replace(made[0], out_mid)
        return "basic-pitch"
    cmd = "run.bat --install-transcriber" if os.name == "nt" else "./run.sh --install-transcriber"
    raise RuntimeError(
        "No transcriber is installed, so audio can't be turned into notes yet.\n"
        f"Stop the app and run:  {cmd}\n"
        "(Or load a MIDI of the same recording with it.)")
