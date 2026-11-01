# Listening Lab

A local lab for exploring harmonic tension in solo piano. Every beat answers
three questions:

| | question | lane |
|---|---|---|
| **position** | where are we? | the current chord |
| **heading** | where does it want to go? | the key the chord pulls toward |
| **destination** | where's home? | the tonic of the piece |

**Tension = the gap between heading and home.** Release = the moment they line
up and the music actually arrives. **Roughness** (sensory friction between
notes) is a separate channel, like the road surface.

Every measurement is a lane on one shared timeline, synced to the audio, so
you can listen and see which lanes move the way the music feels.

---

## Run it

You need **Python 3** (3.9 or newer). On a Mac, open Terminal and type
`python3 --version`. If that doesn't print a version, install Python from
<https://www.python.org/downloads/>.

Then, in the project folder:

```bash
./run.sh
```

**On Windows:** double-click **`run.bat`** in the project folder instead (no
terminal needed). It does exactly the same thing. If Windows says Python is
missing, install it from <https://www.python.org/downloads/> and tick
"Add python.exe to PATH" during setup. To use the options below, open the
folder, type `cmd` in the address bar, and run e.g. `run.bat --install-transcriber`.

**Updating on Windows:** double-click **`update.bat`**. It downloads the newest
version from GitHub and copies it over the app, leaving your `library`
folder, your key and your settings alone.

The first run takes a minute: it creates a private Python environment in
`.venv/` and installs three small packages (numpy, mido, and a bundled copy
of ffmpeg). Later runs start instantly. Your browser opens
<http://localhost:8765>. Press **Ctrl+C** in Terminal to stop.

### Transcribing real recordings (optional, one-time)

Turning audio into notes needs a transcriber. It's a separate step because
it downloads PyTorch (a few hundred MB on a Mac, several GB on Linux):

```bash
./run.sh --install-transcriber
```

This installs [Transkun](https://github.com/Yujia-Yan/Transkun). If that
fails, it falls back to Spotify's Basic Pitch automatically and says so. The
header shows which one is active. Tests and MIDI files work without either.

Transcription of a full tune takes a few minutes on a laptop CPU. It's cached
in `work/`, so re-analysing the same file (new chart, new tempo) is instant.

### Check the analysis in the terminal

```bash
./run.sh --selftest
```

This prints a plain-language report of both built-in tests against their
expected results.

---

## Using it

1. **Load something.** Click *Test 1* or *Test 2*, or choose a video, audio or
   MIDI file. If you have a recording **and** a MIDI of that same performance,
   select both at once (Ctrl+click). You hear the recording, the analysis uses
   the MIDI's notes (no transcribing), and the app lines the MIDI up with the
   audio automatically. Drum tracks in a MIDI are always ignored.
   **Your library:** put a piece in its own folder inside `library/` (a
   recording, its MIDI, or both) and it shows up as a one-click button. The
   `library/` folder stays on your computer and is never uploaded to GitHub.
2. **Paste a chord chart** (optional, but it's your ground truth). It
   overrides the detected chords:
   ```
   | G-7 C7 F#-7 B7 | F-7 Bb7 E-7 A7 | Eb-7 Ab7 | B7 Bb7 |
   ```
   Chords in a bar split it evenly. `%` repeats the previous chord. It accepts
   `-7 m7 min7`, `maj7 Δ`, `7 9 13 7alt 7#11` (all read as dominant 7),
   `ø m7b5`, `°7 dim7`, `6 -6`, `sus4 7sus4`, `+`, and slash chords (the bass is
   ignored).
3. **Set the beat grid.** Choose *Beats from*:
   * *fixed tempo*: a steady grid at the tempo you type, starting at *Chart
     starts at*. Good for strict-time playing.
   * *tracked from notes*: follows the player's onsets, so it handles gentle
     rubato. If you type a tempo it's used as the starting guess.
   * *MIDI file's tempo map*: for MIDI from a notation program or DAW.
   * *auto*: fixed if you gave a chart and a tempo; else the MIDI tempo map
     if the file has one; else tracked.

   *Chart starts at* is the time (in seconds) where bar 1 of your chart begins
   in the recording. *Repeat chart* loops it for every chorus.
4. **Home**: *auto* uses the Krumhansl–Kessler key of the whole piece. Pick a
   key to override it, and the gap and function lanes are recomputed against
   it.
5. **Play.** Click anywhere on the lanes to seek. **Space** plays and pauses.
   **← / →** moves one beat (hold Shift to move a bar). Hover anywhere to read
   every value for that beat in the strip at the bottom.
6. **Zoom**: use **−/+/fit**, or ⌘/Ctrl + scroll (or pinch). Scroll sideways to
   pan.
7. **Lanes**: hover a lane name for ↑ ↓ × (reorder or hide). Use the *lanes ▾*
   menu to bring hidden lanes back. Your layout is remembered.
8. **Export**: *CSV* and *JSON* download every per-beat value, including local
   home and confidence at all eight window sizes, both gap measures, chroma,
   and any Jev answers.

### The lanes

| lane | what it shows |
|---|---|
| Piano roll | every note: height = pitch, brightness = velocity |
| Position | the chord per beat (chart if given), with the detector's guess under it in grey, or in red where it disagrees |
| Heading | the top two keys the chord pulls toward, bar length = weight |
| Local home | 24-row key heatmap (circle of fifths, each major next to its relative minor) over a sliding window of 1–8 bars, *centred* or *trailing*. Orange outline = global home; orange dot = heading |
| Gap (tension) | heading-to-home distance, either *circle of 5ths* or *half steps* (the other one shows in grey), *weighted* over both headings or *top only*. Ticks = arrivals (green = arrival at home) |
| Confidence | 1 − normalised entropy of the local-home probabilities |
| Roughness | Plomp–Levelt / Sethares dissonance between the sounding notes |
| Jev lanes | see below |

---

## 3D stage

Press **3D stage** (top right of the lanes) to open the piece as a 3D
"space-time box": the video becomes a thin slice that slides through time,
every note you've played piles up behind it as a coloured block, the notes
still to come wait in front of it as white outlines, and each hand leaves a
blue (left) or pink (right) trail. A camera flies around it on its own, and
**● record** saves the whole thing, with sound, as a video file.

### Using it

1. **Keyboard corners** (videos only, once per video). Click the four corners
   of the keys: front-left, front-right, back-right, back-left. "Front" is the
   edge nearest the player, "back" is where the keys disappear under the lid.
   Thin lines then show where the app thinks every white key is, with the C's
   marked. Drag a corner until they sit on the keys. If the lines are too
   bunched or too spread out, pick your keyboard size (88 / 76 / 61 / 49) under
   *look*.
2. **Track hands** (optional, once per video). The video plays through once,
   silently, while Google's MediaPipe hand tracker finds 21 points on each hand
   in every frame. It runs only as fast as your computer can keep up, so this
   takes roughly as long as the video, or longer on a slow machine. The result is saved
   in `work/`, so it's instant next time.
3. **+ label** (or **L**) drops a section name at the current moment ("A
   section begins", "Back to A"…). Labels stand on top of the box.
4. **Play** with space. Drag the picture to steer the camera yourself; press
   **C** to hand it back to the automatic camera. **H** hides the panel.
5. **● record** plays from the start in the size you pick (16:9, 4:3, square,
   4:5 portrait), pulls back for an overview at the end, and downloads the
   video. Chrome saves MP4; if a site refuses the file, convert it with
   `ffmpeg -i in.mp4 -c:v libx264 -c:a aac out.mp4`.

Pieces with no video (tests, MIDI, audio) get a drawn keyboard instead.
The page loads three.js and MediaPipe from the internet, so it needs a
connection.

### How it works, step by step

Everything lives in `static/stage.js`, in sections numbered like this list.

1. **Notes in.** The page asks the server for the piece's notes (start, end,
   pitch, velocity). These come from the same place as the lanes: your MIDI
   or the transcription.
2. **One shared space.** Three directions, and everything is placed with
   them:
   * **x = pitch**, left to right like the keyboard.
   * **y = up/down in the video.** The keys sit in a band at y = 0…3; the
     player's hands come in from below.
   * **z = time.** Every second is a fixed distance further along
     (*time stretch* changes it).
3. **Lining the video up with the notes.** The four corners you click
   define a *homography*: a 3×3 matrix that maps any point on the flat
   keyboard to a pixel in the video, perspective included. Four points are
   exactly enough to pin it down. With it the app can (a) un-skew the video
   so the keyboard becomes a perfect rectangle, (b) know which key sits under
   any pixel, and (c) turn tracked hand points into positions in the box.
   Key positions: the white keys are equal slices of the width, and each
   black key sits on the line between two whites.
4. **The layers.** Each one is drawn on the graphics card and reads the same
   clock (`uNow`, the current playback time), so nothing has to be rebuilt
   as the music plays:
   * **Video slice**: the video in black and white with extra contrast,
     un-skewed by the homography, at z = now. Dark parts go see-through so the
     notes behind show through. Near each hand the picture is tinted that
     hand's colour.
   * **Notes**: one small box per note at (x of its key, key height, start
     time). A note that has started is drawn solid in its pitch colour (C red,
     round the rainbow to B) and grows while it's held. A note that hasn't
     started yet is drawn as a white outline that gets brighter as it gets
     close.
   * **Hand trails**: for each tracked frame, each of the hand's 21 bones is
     joined to the same bone in the next frame, making a thin ribbon through
     time. There are tens of thousands of these, each very faint, drawn so
     that overlapping ones add up. Together they look like coloured smoke.
     Which hand is which: with two hands, the one lower on the keyboard is
     the left; with one, it's whichever was last seen nearest.
   * **Box, grid, ruler, labels**: the outline of the whole piece, a floor
     line for every C and every few seconds, note names lying on the note
     sheet, and your section labels on posts along the top.
5. **The camera.** A list of eight shots (angle, height, distance, look
   ahead or behind), each held about 9 seconds and blended into the next,
   always centred on the moving slice. In the last few seconds it pulls back
   to show the whole piece at once. Because the shot depends only on the
   playback time, every recording comes out the same.
6. **Recording.** The browser records the 3D canvas (`captureStream`) and
   the sound (the media element routed through Web Audio) into one file with
   `MediaRecorder`.

What's saved per piece, in `work/<piece>/`: `stage.json` (corners, keyboard
size, labels, look settings) and `hands.json` (the hand points, in video
coordinates, so moving the corners never means tracking again).

---

## How each number is computed

All of this is in `listening_lab/analysis.py`. The knobs are collected in
`SETTINGS` at the top of that file.

* **Beat chroma**: each note adds (overlap in seconds × velocity) to its pitch
  class for every beat it sounds in.
* **Position**: cosine match of the beat's chroma against 14 chord types × 12
  roots, with a small bonus when the lowest note is the root. Confidence is a
  softmax over all 168 scores.
* **Home (global)**: Pearson correlation of the whole piece's chroma with the
  24 Krumhansl–Kessler profiles.
* **Home (local)**: the same correlation on a window of N bars, turned into
  probabilities with a softmax (temperature 0.1).
* **Heading**: rules on the current chord and its neighbours.
  * Dominant 7: down a fifth (60%) or tritone sub, down a half step (40%).
  * m7 followed by its V (or by its tritone-sub V, e.g. E♭-7 D7): points at
    the I.
  * A V preceded by its ii: the down-a-fifth reading gets +0.6.
  * A tritone-sub V preceded by the ii (E♭-7 D7): the half-step reading gets
    +0.6.
  * Lone m7: ii of a major key (55%) or a minor tonic (45%).
  * maj7/6: rests on itself (75%) or acts as IV (25%).
  * Lone minor: itself (70%) or iv (30%).
  * dim: leading tone.
  * The top two candidates are kept and normalised.
* **Gap**: distance from each heading tonic to home, in circle-of-fifths steps
  or half steps (both 0–6), averaged by heading weight. *Top only* uses just
  the top candidate. Mode (major/minor) is ignored in the distance.
* **Arrival**: a non-dominant chord whose root and quality match one of the
  previous chord's headings. Strength = that heading's weight.
* **Confidence**: 1 − entropy/log 24 of the local-home probabilities.
* **Roughness**: for every pair of partials from *different* notes (6
  harmonics per note, amplitude 0.88ᵏ, scaled by velocity and by how much of
  the beat the note covers), Sethares' curve
  `min(a₁,a₂)·(e^(−3.5·s·Δf) − e^(−5.75·s·Δf))`, `s = 0.24/(0.0207·f_low + 18.96)`,
  summed.

---

## Optional AI lane: Jev

Everything about TypeSafe's Jev is in **`listening_lab/jev.py`** and
**`jev_config.json`**. It is connected and working (model `jev-latest`).

* With no API key, the lane says *not connected* and nothing is sent anywhere.
* To connect, click the **Jev: not connected** chip at the top right and
  paste your key. It's saved to `.env` on your computer, which is git-ignored,
  so the key never goes to GitHub. (Or edit `.env` yourself, or set
  `JEV_API_KEY` as an environment variable.)
* How it asks: for every beat, Jev gets the chords and notes of the nearby
  beats plus five multiple-choice questions, and returns a probability for
  every option. A whole piece takes a couple of seconds.
* **Your own rows:** press **+ row** and type any yes/no statement, e.g.
  *"This beat sounds unresolved."* For every beat, Jev gets your sentence
  word for word, plus only data: that beat's chord, sounding notes and bass,
  and the same for the 4 beats before and after. The row shows Jev's
  probability of "yes" on each beat. Rows are remembered; **delete row**
  removes one.
* What it's good and bad at: chord roots are reliable (often better than the
  detector on rootless voicings). Local home tends to stick to the piece's
  home key, and heading is a mixed bag. Read those two lanes as a second
  opinion, not as ground truth.
* Press **ask Jev**. Five lanes appear:
  * chord root (12)
  * function (tonic / predominant / dominant / chromatic / other)
  * local home (24)
  * heading (24)
  * arrival (yes/no)

  Each lane is a probability heatmap with the deterministic answer boxed:
  white where they agree, red where they don't. A **Jev vs rules** strip
  marks every disagreement on one line.
* To try the comparison view without a key, run `JEV_MODE=mock ./run.sh`. It
  fills the lanes with clearly labelled fake answers.

---

## Files

```
run.sh                  one-command setup + start
lab.py                  local web server
listening_lab/
  theory.py             chord templates, chart parser, key profiles, distances
  analysis.py           all per-beat measurements (SETTINGS at the top)
  beats.py              fixed grid + onset beat tracker
  midi_io.py, synth.py  MIDI read/write, tiny synth so MIDI has audio
  transcribe.py         ffmpeg + Transkun / Basic Pitch
  testpieces.py         the built-in tests
  selftest.py           ./run.sh --selftest
  jev.py                the Jev hook
jev_config.json         Jev settings (no secrets)
static/                 the page (index.html, app.js, style.css)
  stage.html/.js/.css   the 3D stage
work/                   uploads, transcriptions, rendered audio (git-ignored)
```
