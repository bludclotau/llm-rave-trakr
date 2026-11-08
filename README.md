# LLM Rave Trakr

Web tracker for arranging drum samples and vocal one-shots in the browser.
**Dolphin** on the llama.cpp node at `10.1.1.122:8082` turns a text prompt
into a 16-step pattern. The drum kit is the wavbvkery *dreams* pack copied
from `ess-eleven-hundred`. Vocal one-shots, when imported, come from the
CyberRave word factory.

## Run

```sh
node server.mjs
```

Open http://127.0.0.1:3840

## Compose

Type a prompt (`dusty boom bap at 90bpm`) and hit **COMPOSE**. The server
pre-filters the sample index by the prompt, sends Dolphin a short digest
(id, name, tags, duration, brightness), and constrains the reply with a GBNF
grammar. Each drum channel can return a sample id from that list, a 16-step
string (`X` accent, `x` normal, `o` ghost, `.` rest) or euclid settings, and
one preset name: `tight`, `soft`, `long`, or `lofi`. The model may also
return up to eight vocal placements (`sample`, `row`, `note`, `volume`).
Ids outside the candidate list are clamped. An empty kick or snare falls
back to the genre template. The result is always playable.

A compose writes ten columns. FM layers, if you add them afterwards, start
after the vocal columns.

| CH | role |
|----|------|
| 1 | kick |
| 2 | snare |
| 3 | closed hat |
| 4 | open hat |
| 5 | clap |
| 6 | perc |
| 7 | crash |
| 8 | 808 bass |
| 9 | vocal one-shot |
| 10 | vocal one-shot |

`C-4` on a vocal column is the recorded pitch. The cell note changes
`playbackRate`. Vocal columns are not in the hat mute group and are not cut
by other channels. An old song has no `voxChannels`, so its first FM layer
stays on column 9.

**PRESET** skips the LLM and loads a local genre template from the prompt
keywords (boom-bap, trap, house, dnb, breakbeat, lofi, techno). `phonk`
uses the trap template and `rave` uses techno. That replaces the drum
pattern. User samples and imported vocals stay in the library. The template
still picks kit samples from the index and applies a sampler preset, so hat
and perc hits are not a single flat velocity.

## Layer mode

**LAYER** does not rebuild the kit. It reads the current BPM and the kick and
bass columns (`x` where a cell has a note) and asks for one FM part. The new
channel is appended. Drum channels stay as they are.

```sh
POST /api/compose
{ "mode": "layer", "prompt": "a lead synth pad melody", "node": "dolphin",
  "song": { "bpm": 90, "kick": "x...x...x..x.x..", "bass": "x.....x.x......." } }
```

`POST /api/compose-layer` is the same call. The full-song compose path is the
request without `mode`. `offline: true`, `local: true`, or `node: "offline"`
skips the model and returns the fallback layer.

The reply is one instrument, a channel FX suggestion, and 16 cells:

```json
{ "instrument": { "type": "fm", "preset": "lead", "patch": {}, "sound": {} },
  "channelFx": { "cutoff": 3400, "resonance": 1.2, "drive": 0, "fxWet": 0 },
  "cells": [], "llm": {} }
```

`sound` is the preset after the macro overrides, ready for `FMVoice.setPreset`.
`song.instruments[]` records both kinds of instrument. Drums stay in
`cell.sample` and in `song.kit`. On load, each used catalog id is copied to
`{ type: "sample", id, file, name, role }` when that file is not already
listed, so a later WAV reorder still resolves. FM entries keep a string id
(`fm-lead`, `fm-bass-ch8`).

`song.channelInstrument` assigns an FM id to a drum channel (0–7). The
channel head stays `CH1 KICK` and can add the preset (`CH8 BASS · BASS`).
Playback of that channel uses the cell note: a rest holds, `===` releases,
and a new pitch retriggers inside the worklet. The kit sample id stays in
the cell. Sample channels, including the hat mute group, are unchanged. An
FM channel does not join that mute group.

`channelFx` is the per-channel strip. A layer's cutoff and resonance are
heard on that channel. Drum channels start from the neutral defaults below
until a slider or a cell command moves them.

### Grammar

`LAYER_GRAMMAR` in `public/audio/layer.js` is a separate GBNF grammar. The
start rule is `root`. Keys are fixed in this order: `layer`, `preset`,
`patch`, `scale`, `melody`. `max_tokens` is 256.

| field | values |
|-------|--------|
| `layer`, `preset` | `lead`, `pad`, `bell`, `bass`, `pluck` |
| `patch.ratio` | `"1"`, `"2"`, `"3"`, `"4"`, `"0.5"` |
| other patch fields | integer 0–9 |
| `scale.root` | `A`–`G` with an optional `#` |
| `scale.mode` | `major`, `minor`, `dorian`, `pentatonic` |
| `melody` | exactly 16 steps of 2 characters |

### Melody tokens

| token | meaning |
|-------|---------|
| `1`–`7` plus `l`, `m`, or `h` | scale degree. `l`/`m`/`h` are octaves 3/4/5, or 1/2/3 for a bass layer |
| `..` | rest. The voice is not touched, so a held note stays in sustain |
| `==` | note-off. The cell is stored as `===` |

Pentatonic has five degrees. Degree 6 and 7 wrap into the next octave. The
octave letter is the root's octave. A degree that crosses C prints the next
octave name (`A` degree 2 in octave 4 is `C-5`). Note names match the tracker
(`C-4`, `C#4`).

A new degree retriggers inside the worklet (5 ms fade, envelopes restart).
There is no legato. `===` starts the release. The patch attack and release
are the envelope times.

### Level map

Levels are integers 0–9. The tables live in `public/audio/layer.js` (`LEVELS`).
The named preset is the starting point. A key the model sends replaces that
macro. A key it omits stays on the preset. Ratio sets the modulator only.
Attack, sustain, and release go to both operators. Modulator decay is 0.65
of the decay value. The carrier gets the full decay. The synth still clamps
every envelope stage to at least 3 ms.

| level | 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 |
|-------|---|---|---|---|---|---|---|---|---|---|
| attack (s) | 0.005 | 0.01 | 0.02 | 0.04 | 0.08 | 0.15 | 0.30 | 0.55 | 1.0 | 1.6 |
| decay (s) | 0.04 | 0.07 | 0.12 | 0.20 | 0.35 | 0.55 | 0.80 | 1.2 | 1.8 | 2.6 |
| sustain | 0 | 0.12 | 0.24 | 0.36 | 0.48 | 0.58 | 0.70 | 0.80 | 0.90 | 1 |
| release (s) | 0.02 | 0.04 | 0.08 | 0.12 | 0.20 | 0.35 | 0.55 | 0.90 | 1.4 | 2.2 |
| depth (rad) | 0 | 0.4 | 0.8 | 1.3 | 1.8 | 2.4 | 3.1 | 4.0 | 5.0 | 6.0 |
| feedback (rad) | 0 | 0.15 | 0.3 | 0.5 | 0.75 | 1.0 | 1.35 | 1.7 | 2.1 | 2.6 |
| cutoff (Hz) | 180 | 280 | 420 | 650 | 1000 | 1500 | 2200 | 3400 | 5200 | 7800 |
| res (Q) | 0.5 | 0.8 | 1.2 | 1.8 | 2.5 | 3.5 | 5 | 7 | 9 | 12 |

Cutoff and resonance are the lowpass, not FM operator fields. When the model
omits them, the role's fallback levels are used.

### Fallback

The result is always playable. A missing reply, a rejected grammar, or both
llama.cpp nodes down (and no `XAI_API_KEY`) expands `expandLayer(null, prompt)`.

If the prompt names a role, that role wins, lead before pad, then bell, bass,
pluck. `a lead synth pad melody` is a lead. If it names no role, the model's
`preset` or `layer` is used, otherwise lead. A phrase like `D minor` sets the
scale. Otherwise the model's scale is used, otherwise A minor.

An invalid melody is replaced with a template: a short lead phrase, a pad
that holds `1m` then `3m` until `==`, sparse high bell notes, or bass and
pluck notes on the current bass (or kick) hits. Pluck writes `==` on the rest
after each hit. An invalid patch is replaced with that role's fallback
levels, so a pad is slow and dark even when the nodes are down.

**MUTE**, **HEAR**, and **X** on the layer header mute, audition, and remove
that channel. They do not change the drums. Tracker keys on a layer channel
write sample `0` and play the layer voice. Keys on a drum channel still write
samples.

## Project file

**SAVE** downloads the song as JSON with `version: 3`. **LOAD** reads it back,
including a missing version, version 1, or version 2. `migrateSong` bumps a
catalog-backed song to version 3 and does not rewrite `cell.sample`. The
file includes `instruments`, `channelInstrument`, `layers` (including mute),
`channelFx`, `channelSampler`, `channelEuclid`, `userSamples`, `voxChannels`,
and the extra pattern columns. A drum song with eight columns and no version
still loads and plays. The compose HTTP response has no `instruments` key.
The page adds sample instruments after the catalog loads.

## Playback

Web Audio plays the WAV samples with one monophonic voice per channel. Closed
and open hats share a mute group. Tracker keys: `Z–M` / `Q–U` for notes,
`` ` `` for note-off, arrows to move, `DEL` to clear, space to play/stop.
Click a sample to audition it. Audition uses the bass channel's voice.

A row is a sixteenth note: `15 / bpm` seconds. `song.speed` is stored (classic
ticks per row) and the scheduler does not read it. The scheduler looks ahead
120 ms and stamps each row with an audio-clock time.

## Voices

`public/audio/voice.js` is the playback interface. Each channel holds one voice.

| call | meaning |
|------|---------|
| `noteOn(time, note, velocity)` | start a note at an audio-clock time. `note` is MIDI. `velocity` 1 matches cell volume 64 |
| `noteOff(time)` | envelope release. Cell token `===`. Drum one-shots ignore it |
| `cut(time)` | silence with a 10 ms ramp, then stop the source 50 ms later |

There is no legato. A new note on a sample channel cuts the previous note
on that channel before `noteOn`. A hat sample cuts both hat channels. An
FM-assigned drum channel does not cut before `noteOn`. A rest on that
channel posts nothing. The cut is stamped with
`currentTime` when the row is scheduled, so a stolen sample can start fading
up to one lookahead early. `noteOn` and `noteOff` use the row time itself.
`SampleVoice` is the drum implementation of this interface. Pattern effect
commands automate the channel strip after the voice. They do not change
`SampleVoice`. Existing songs have no `===` cells and no effect commands, so
drum playback is unchanged until a GCD-8 sampler slider moves.

## GCD-8 sampler

Each drum channel, and each vocal channel, has the sample response from `gcd8-pd` (`gcd8.sampler~`).
The sliders are under **GCD-8 SAMPLER** and follow the selected channel.
They are stored on `song.channelSampler` and round-trip through **SAVE** /
**LOAD**. A song with no `channelSampler` loads the identity settings, so
the hit is the same buffer playback as before.

Cell volume is the velocity. `1` is volume 64. Full velocity is never
darkened, shortened, or faded by the depth sliders. Softer hits are.

| slider | 0 | 1 |
|--------|---|---|
| LEVEL | silence | unity, before the velocity curve |
| START / END | play from the start / through the end | trim the buffer |
| HOLD | AD envelope (no hold) | 95% hold, then a fade |
| AMP | linear volume, as before | velocity squared |
| TONE | no extra lowpass | 24 kHz at full velocity, 600 Hz at velocity 0 |
| V.START | start trim only | soft hits skip toward the end trim |
| ATTACK | no fade-in | 150 ms fade-in at velocity 0, capped at half the envelope |
| DECAY | full trimmed length | velocity 0 lasts 15% of that length |

HOLD, ATTACK, and DECAY build one AHD envelope. The fade is squared, matching
the Pure Data `vline~` multiplied by itself. TONE is a lowpass on that hit
only. The channel strip filter is still downstream and is unchanged.
Clicking a sample auditions it through the bass voice with the selected drum
channel's response. `node scripts/verify-sample-response.mjs` checks the curves.

## Loading your own samples

**LOAD**, **CLEAR**, and **STOP** sit on the GCD-8 sampler strip and act on the selected sample channel (a drum column or a vocal column), like the buttons on `gcd8.sampler~`.

- **LOAD** takes any file the browser can decode (WAV, AIFF, FLAC, OGG, MP3), up to 8 MB. When the tracker server is up it `POST`s the bytes to `/api/samples/upload`, which writes them under `public/samples/user/` and stores a file reference on `song.userSamples`. If that upload is refused, the file is still kept as base64 inside the project. It becomes the channel's kit sample, and every hit already on that channel switches to it. It is also auditioned through the channel's sampler response. Rests, note-offs, and other channels are untouched.
- **CLEAR** puts the channel back on the kit sample it used before the load. A hit with no kit sample to return to is emptied. A user sample that nothing uses any more is dropped from the song. An uploaded file is left on disk.
- **STOP** fades out the selected channel's voice (10 ms). It also stops a sample audition when the pattern is not running.

`cell.sample` stays a number. The hat mute group and the sampler sliders are unchanged. **PRESET** and **COMPOSE** replace the pattern and keep library entries the new song does not own, including embedded user samples and vocals. Projects that already store base64 still load.

**RESCAN** calls `POST /api/samples/rescan`. New files under `public/samples` appear without a restart. An id already assigned to a path does not move. `GET /api/library` is the compact digest of the same catalog.

## Euclidean sequencer

The **GCD-8 EUCLID** strip is the base-pattern section of `gcd8.seq` for the selected sample channel. **GENERATE** writes the cycle onto the channel's rows.

| field | range | meaning                                                                      |
|-------|-------|------------------------------------------------------------------------------|
| LEN   | 1–32  | steps in the cycle                                                           |
| HITS  | 0–LEN | steps that are hits                                                          |
| SHIFT | 0–LEN-1 | rotates the cycle forward. A larger value wraps                            |
| RATE  | 1/16, 1/8, 1/4, 1/2 | rows per step: 1, 2, 4, 8 (a row is a sixteenth)                 |

The preview line shows the hits for the whole pattern. The cycle restarts at row 0 and repeats until the pattern ends, so with LEN 5 on a 16-row pattern the last repeat is cut short. Hits take the note, sample, and volume of the channel's first existing hit, or the role default (`C-4`, `C-1` for bass, volume 40 for hats, 64 otherwise). Rows without a hit lose note, sample, and volume. `effect` and `param` stay, so FX automation survives a rewrite. On a channel assigned to FM, GENERATE rewrites its notes and removes any `===` cells.

Settings are stored in `song.channelEuclid` and round-trip through **SAVE** / **LOAD**. A song without it uses LEN 16, HITS 4, SHIFT 0, RATE 1/16.

Differences from `gcd8.seq`: gcd8 free-runs the sequencer on the clock and per-track step rates. The tracker renders onto a fixed pattern, and a hit is `(i * hits) mod length < hits`, the floor form of the Euclidean distribution. It matches the Bjorklund pattern for common cases such as E(4,16), E(3,8), and E(5,8), but may be a rotation of what `[else/euclid]` produces for other inputs. Jitter, accents, and the euclidean panner are not ported.

```
node scripts/verify-euclid.mjs
```

## Licence

This project now includes logic adapted from [glima31/gcd8-pd](https://github.com/glima31/gcd8-pd) (the sampler's velocity response and the euclidean base pattern), which is GPL-3.0. The project is therefore distributed under GPL-3.0-or-later. See `LICENSE` and `NOTICE.md`. The drum WAVs are third-party audio and are not covered by it.

## FM voice

`FMVoice` is a second implementation of the same three calls. It is a
two-operator AudioWorklet (`public/audio/fm-worklet.js`), not an oscillator
graph, because operator feedback is per sample. Operator 0 modulates operator 1:

```
modulator = sin(modPhase + feedback * prevMod) * modEnv * modLevel
output    = sin(carPhase + depth * modulator) * carEnv * carLevel * velGain
```

`prevMod` is the previous modulator sample, including its envelope and level.
`depth` and `feedback` are radians. `velGain = (1 - velSens) + velSens * velocity`.
Each operator has a ratio (against the played note), fine detune in cents,
ADSR, and an output level. Attack, decay, release, retrigger, and cut are
ramped (3 ms minimum on the envelope stages, 5 ms on retrigger, cut, and
preset moves).

The worklet applies a note at the sample whose audio-clock time reaches the
timestamp on the message. The pattern scheduler already looks ahead 120 ms
and has those timestamps. Drum channels stay on samples unless **CH INST**
assigns an FM preset to the selected drum channel. That assignment does not
change the other channels. A **LAYER** channel plays this voice: a rest
sends nothing, so the envelope holds, and `===` releases it. **PING** plays
C-4 on the selected preset. **KEYS** sends the tracker keyboard (`Z–M` /
`Q–U`, `` ` `` for note-off) to the audition FM voice instead of the sample.
The key still writes the cell. KEYS defaults off. On an FM-assigned drum
channel the key writes the note, leaves `cell.sample` in place, and auditions
that channel's voice.

Presets: E-Piano, Bell, FM Bass, Pluck, Lead, Pad. Edits on this panel last
until you pick another preset. They do not edit a layer that is already in
the pattern. These ids edit the preset. Pattern commands do not retune
operators. `fmDepth`, `opRatio`, and `feedback` stay here:

| id | meaning |
|----|---------|
| `fmDepth` | carrier modulation index, radians |
| `feedback` | modulator feedback, radians |
| `velSens` | how much velocity scales the output |
| `opRatio`, `opDetune`, `opAttack`, `opDecay`, `opSustain`, `opRelease`, `opLevel` | modulator |
| `carRatio`, `carDetune`, `carAttack`, `carDecay`, `carSustain`, `carRelease`, `carLevel` | carrier |

## Channel strip

Each channel builds one strip the first time audio starts, and reuses it.
Sample voices and FM voices on that channel both feed it. The FM panel
**PING** voice goes to the master, after the strips. Preview still uses the
bass channel's voice, so it passes through the bass strip. At the defaults
that strip is the same level as the dry sample.

```
voice → filter → saturation → dry / delay → channel output → master → limiter
                            ↘ reverb send → one shared convolver → master
```

| parameter | default | heard as |
|-----------|---------|----------|
| `filterType` | `lowpass` | lowpass or highpass. Changing type is immediate |
| `cutoff` | 18000 Hz | resonant filter. Slider and commands ramp in about 5 ms |
| `resonance` | 0.707 | filter Q |
| `drive` | 0 | clean gain `1 - drive`, plus `drive * 6` into a tanh waveshaper (`oversample: "4x"`) |
| `fxWet` | 0 | delay wet. Dry gain is `1 - fxWet` |
| `delayFeedback` | 0.35 | delay feedback, capped at 0.85. Silent while `fxWet` is 0 |
| `delayTime` | 2 rows | `rows * (15 / bpm)` seconds, clamped to 0.01–1.9 s. `song.speed` is still unread |
| `reverbSend` | 0 | send into one generated 1.2 s impulse |

The master limiter is a compressor at 0 dBFS, knee 0, ratio 20, attack 3 ms,
release 80 ms. It does not reduce a signal that stays under 0 dBFS. Chorus
and flanger are not in this strip.

Cell columns `effect` and `param` write the strip when the row is scheduled.
`effect` 0 does nothing, including on a rest, so empty rows can still
automate. The value is stored back into `song.channelFx` and ramped at the
row's audio time. **FX** and **PRM** edit the selected cell. The sliders edit
the channel, not the cell.

| effect | param | writes |
|--------|-------|--------|
| 0 | — | no change |
| 1 | 0–255 | `cutoff = 80 * (18000 / 80) ^ (param / 255)` Hz |
| 2 | 0–255 | `resonance = 0.5 + (param / 255) * 17.5` |
| 3 | 0–255 | `drive = param / 255` |
| 4 | 0–255 | `fxWet = param / 255` |
| 5 | 0–255 | `delayFeedback = (param / 255) * 0.85` |
| 6 | 1–16 | `delayTime` in rows. 0 is ignored. This is not a 0–255 curve |
| 7 | 0–255 | `reverbSend = param / 255` |
| 8 | 0 or other | `filterType` lowpass, or highpass when param is not 0 |

Live control ids: `cutoff`, `resonance`, `drive`, `fxWet`, `delayFeedback`,
`delayTime`, `filterType`, `reverbSend`, `cell-effect`, `cell-param`.

## LLM nodes

| node | default |
|------|---------|
| Dolphin | `http://10.1.1.122:8082` |
| Qwen (fallback) | `http://10.1.1.122:8081` |

Override with `LLAMA_URL` / `LLAMA_URL_2`. If both llama.cpp nodes fail and
`XAI_API_KEY` is set, compose falls back to SpaceXAI (`grok-4.7` at
`https://api.x.ai/v1`).

## Samples

90 WAVs from `ess-eleven-hundred/samples` (wavbvkery dreams). Third-party audio;
the tracker code is separate from that pack. `node scripts/index-samples.mjs`
writes `public/samples/index.json` (duration, peak, RMS, gain trim, leading
silence, brightness, a rough pitch for bass, and filename tags). Playback
applies the gain trim and skips the leading silence. `public/samples/ids.json`
keeps catalog ids stable across a rescan.

## Vocal one-shots

The CyberRave word factory stores rendered words in Postgres and already
exports them:

```sh
wordfactory export-manifest --format json --review kept --output samples.json
node scripts/import-vox.mjs --manifest samples.json --audio-root /path/to/wavs
```

The JSON is an array of `{ word, treatment, file_path, duration_sec, sample_rate, channels, peak_dbfs, loudness_lufs, bark_seed, review_status, created_at }`. CSV with that header works too. The importer writes 16-bit mono WAV at 44.1 kHz or 48 kHz into `public/samples/vox/`, trims silence, and peaks each file to the kit. Filenames are `001_whisper.wav`. The word stays in `public/samples/vox/index.json` (`role`, `word`, `treatment`, `tags`, `duration`, `pitch`, `offset`). That directory is gitignored. The tracker does not open Postgres.

A haunting or phonk prompt prefers whisper and bit-crush treatments. Placements are sparse: the template puts at most two, on a downbeat or the last row. The model is told not to write a lyric. Words come from the factory list only.

## Check the layer

```sh
node scripts/verify-layer.mjs
```

That checks three prompts against the expander and, when this server is up,
against HTTP:

| prompt | expect |
|--------|--------|
| `a lead synth pad melody` | preset `lead`, even though the words also say pad |
| `slow warm pad in D minor` | preset `pad`, root D, mode minor, a held note, then `===` |
| either prompt with the LLM nodes down | a playable fallback layer, HTTP 200 |

In the browser: **PRESET** a beat, **LAYER** the lead prompt, press **PLAY**
(drums and the new channel together), **MUTE** / **HEAR** / **X** the header,
then **SAVE** and **LOAD**. **PRESET** again clears the layer and the drums
still play.

## Check the instruments

```sh
node scripts/verify-instruments.mjs
```

That checks migration, file remap, and channel FX defaults. In the browser,
**PRESET** a beat, press **PLAY**, and the drum samples still start. Select
the bass column, set **CH INST** to FM Bass, press **PLAY**: the kick still
plays its sample and the bass column plays FM at the written pitch (`C-1`
on a drum template whose bass sample has no measured pitch). **SAVE** writes
`version: 3` and a sample instrument for each kit file. `cell.sample` on
those drum cells is unchanged.

## Check the library

```sh
node scripts/verify-library.mjs
```

That checks gain trim, leading-silence offset, filename tags, id stability
across a rescan, candidate clamping, and the repair step. The model is not
called.
