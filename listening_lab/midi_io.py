"""Read and write MIDI files as simple note lists.

A note is (start_seconds, end_seconds, midi_pitch, velocity)."""

import mido


def read_midi(path):
    """Return (notes, info). info has the tempo map as beat times and the
    time signature, so a MIDI file made in a notation program or DAW keeps
    its own beat grid."""
    mid = mido.MidiFile(path)
    tpb = mid.ticks_per_beat
    # Merge all tracks into absolute-tick events
    events = []
    for track in mid.tracks:
        t = 0
        for msg in track:
            t += msg.time
            events.append((t, msg))
    events.sort(key=lambda e: e[0])

    tempo_changes = [(0, 500000)]
    beats_per_bar = 4
    for t, msg in events:
        if msg.type == "set_tempo":
            if t == 0:
                tempo_changes[0] = (0, msg.tempo)
            else:
                tempo_changes.append((t, msg.tempo))
        elif msg.type == "time_signature" and t == 0:
            beats_per_bar = msg.numerator

    def tick_to_sec(tick):
        sec = 0.0
        for i, (t0, tempo) in enumerate(tempo_changes):
            t1 = tempo_changes[i + 1][0] if i + 1 < len(tempo_changes) else None
            if t1 is not None and tick > t1:
                sec += (t1 - t0) * tempo / 1e6 / tpb
            else:
                sec += (tick - t0) * tempo / 1e6 / tpb
                break
        return sec

    notes = []
    active = {}
    for t, msg in events:
        if msg.type == "note_on" and msg.velocity > 0:
            active.setdefault((msg.channel, msg.note), []).append((t, msg.velocity))
        elif msg.type in ("note_off", "note_on"):
            stack = active.get((msg.channel, msg.note))
            if stack:
                t0, vel = stack.pop(0)
                notes.append((tick_to_sec(t0), tick_to_sec(t), msg.note, vel))
    notes.sort()

    last_tick = max((t for t, _ in events), default=0)
    beat_times = [tick_to_sec(k * tpb) for k in range(int(last_tick / tpb) + 2)]
    tempos = {tp for _, tp in tempo_changes}
    info = {
        "beat_times": beat_times,
        "beats_per_bar": beats_per_bar,
        "tempo_bpm": 60e6 / tempo_changes[0][1],
        # A file with only the default 120 BPM and no other tempo events is
        # probably a transcription with no real beat grid.
        "has_real_tempo": not (tempos == {500000}),
    }
    return notes, info


def write_midi(notes, path, tempo_bpm=120.0, beats_per_bar=4):
    mid = mido.MidiFile(ticks_per_beat=480)
    track = mido.MidiTrack()
    mid.tracks.append(track)
    tempo = int(round(60e6 / tempo_bpm))
    track.append(mido.MetaMessage("set_tempo", tempo=tempo, time=0))
    track.append(mido.MetaMessage("time_signature", numerator=beats_per_bar, denominator=4, time=0))
    sec_to_tick = lambda s: int(round(s * 1e6 / tempo * 480))
    evs = []
    for s, e, p, v in notes:
        evs.append((sec_to_tick(s), 1, mido.Message("note_on", note=p, velocity=v)))
        evs.append((sec_to_tick(e), 0, mido.Message("note_off", note=p, velocity=0)))
    evs.sort(key=lambda x: (x[0], x[1]))
    last = 0
    for t, _, msg in evs:
        msg.time = t - last
        last = t
        track.append(msg)
    mid.save(path)
