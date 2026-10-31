"""Beat grids: fixed tempo, or tracked from note onsets.

The tracker is a small version of Dan Ellis's dynamic-programming beat
tracker (2007): estimate one tempo from onset autocorrelation, then find
the beat sequence that lands on onsets while keeping roughly that spacing,
so it can follow a gently rubato performance."""

import numpy as np

FPS = 100  # onset-envelope frames per second


def fixed_grid(tempo_bpm, start, end):
    period = 60.0 / tempo_bpm
    n = int(np.ceil((end - start) / period)) + 1
    return [start + k * period for k in range(max(n, 2))]


def _onset_envelope(notes, duration):
    n = int(duration * FPS) + FPS
    env = np.zeros(n)
    for s, _e, _p, v in notes:
        i = int(s * FPS)
        if 0 <= i < n:
            env[i] += v / 127.0
    # smooth with a ~20 ms Gaussian
    k = np.exp(-0.5 * (np.arange(-6, 7) / 2.0) ** 2)
    return np.convolve(env, k / k.sum(), mode="same")


def estimate_tempo(notes, duration, lo=50, hi=200, prior_bpm=100):
    env = _onset_envelope(notes, duration)
    env = env - env.mean()
    ac = np.correlate(env, env, mode="full")[len(env) - 1:]
    best, best_bpm = -np.inf, prior_bpm
    for lag in range(int(FPS * 60 / hi), int(FPS * 60 / lo) + 1):
        bpm = 60.0 * FPS / lag
        # log-Gaussian preference for moderate tempi
        w = np.exp(-0.5 * (np.log2(bpm / prior_bpm) / 1.0) ** 2)
        score = ac[lag] * w
        if score > best:
            best, best_bpm = score, bpm
    return best_bpm


def track_beats(notes, duration, tempo_bpm=None, tightness=100.0):
    """Return (beat_times, tempo_bpm)."""
    if not notes:
        return fixed_grid(tempo_bpm or 100, 0, duration), tempo_bpm or 100
    if tempo_bpm is None:
        tempo_bpm = estimate_tempo(notes, duration)
    env = _onset_envelope(notes, duration)
    period = FPS * 60.0 / tempo_bpm
    n = len(env)
    score = env.copy()
    back = np.full(n, -1)
    lo, hi = int(round(period / 2)), int(round(period * 2))
    for t in range(n):
        if t < lo:
            continue
        prev = np.arange(max(0, t - hi), t - lo + 1)
        if len(prev) == 0:
            continue
        pen = -tightness * np.log((t - prev) / period) ** 2
        cand = score[prev] + pen
        j = int(np.argmax(cand))
        if cand[j] > 0:
            score[t] = env[t] + cand[j]
            back[t] = prev[j]
    # start from the best-scoring frame in the last beat period
    tail = np.arange(max(0, n - int(period) - FPS), n)
    t = int(tail[np.argmax(score[tail])])
    beats = [t]
    while back[t] >= 0:
        t = back[t]
        beats.append(t)
    beats = [b / FPS for b in reversed(beats)]
    # extend the grid to cover the whole piece at the local spacing
    p = 60.0 / tempo_bpm
    while beats[0] - p > -0.05:
        beats.insert(0, max(0.0, beats[0] - p))
    while beats[-1] < duration:
        beats.append(beats[-1] + p)
    return beats, tempo_bpm
