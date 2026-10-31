"""A tiny additive piano-ish synth so MIDI inputs have audio to listen to."""

import wave

import numpy as np

SR = 22050


def midi_to_hz(p):
    return 440.0 * 2 ** ((p - 69) / 12.0)


def render(notes, path, tail=1.5):
    dur = max((e for _, e, _, _ in notes), default=1.0) + tail
    out = np.zeros(int(dur * SR) + 1)
    for s, e, p, v in notes:
        f = midi_to_hz(p)
        length = (e - s) + 0.25
        n = int(length * SR)
        t = np.arange(n) / SR
        tone = np.zeros(n)
        for k in range(1, 7):
            if f * k > SR / 2:
                break
            # higher partials decay faster, like a struck string
            tone += (0.6 ** (k - 1)) * np.sin(2 * np.pi * f * k * t) * np.exp(-t * (1.2 + 0.8 * k) * (f / 261.6) ** 0.3)
        env = np.minimum(1.0, t / 0.004)
        rel_start = e - s
        env *= np.where(t < rel_start, 1.0, np.exp(-(t - rel_start) / 0.08))
        i0 = int(s * SR)
        seg = tone * env * (v / 127.0) * 0.12
        out[i0:i0 + n] += seg[: len(out) - i0]
    peak = np.abs(out).max() or 1.0
    out = out / peak * 0.8
    pcm = (out * 32767).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(pcm.tobytes())
    return dur
