import { isPlainResponse, shapeSampleHit } from "./sample-response.js";

/**
 * Channel voices for the tracker.
 *
 * One monophonic voice per channel. The engine owns the slots and is the only
 * place that steals voices. A voice never cuts a different channel.
 *
 *   noteOn(time, note, velocity)
 *     Start a note at an AudioContext time. `note` is a MIDI note number.
 *     `velocity` is linear gain, where 1 matches cell volume 64.
 *     SampleVoice uses `voice.buffer`, `voice.pan`, and `voice.response`,
 *     which the engine sets before the call. `pan === null` skips the
 *     panner (sample audition). A plain response plays the buffer as before.
 *
 *   noteOff(time)
 *     Envelope release at `time`. This does not hard-stop the voice.
 *     SampleVoice ignores it. Drum one-shots play until the buffer ends
 *     or something cuts them. The cell token for this is "===".
 *
 *   cut(time)
 *     Silence the current note with a short anti-click ramp, then stop the
 *     source 50 ms later. This is the voice-steal and transport-stop path.
 *
 * Retrigger / legato
 *   There is no legato. Before noteOn, the engine cuts that channel (both
 *   hat channels when the sample's mute group is "hats"). The cut time is
 *   ctx.currentTime at the moment the row is scheduled, which is up to one
 *   lookahead (120 ms) before the row. noteOn and noteOff receive the row's
 *   own audio-clock time. A stolen sample therefore starts fading when the
 *   scheduler sees the new hit, and the new sample starts on the row.
 *   That is the original player's behaviour, kept on purpose.
 *
 * FMVoice in fm-voice.js implements the same three calls. Drum channels do
 * not use it. A layer channel does: a rest posts nothing, so the envelope
 * holds, "===" is noteOff, and a new note retriggers inside the worklet
 * with a 5 ms fade. A cut at the same timestamp would cancel that note, so
 * the scheduler does not cut a layer voice before noteOn.
 */

export const NOTE_OFF = "===";

export function isNoteOff(cell) {
  return cell?.note === NOTE_OFF;
}

export class SampleVoice {
  /**
   * @param {AudioContext} ctx
   * @param {AudioNode} destination  usually the master gain
   */
  constructor(ctx, destination) {
    this.ctx = ctx;
    this.destination = destination;
    this.buffer = null;
    /** @type {number|null} null means connect with no StereoPanner */
    this.pan = 0;
    /** GCD-8 per-channel sampler. Null is the unchanged drum hit. */
    this.response = null;
    /** Index gain trim. 1 leaves the hit at cell velocity. */
    this.gainTrim = 1;
    /** Leading silence, in seconds, skipped so the transient is on the row. */
    this.skipSec = 0;
    this.current = null;
  }

  noteOn(time, note, velocity) {
    if (!this.buffer || !this.destination) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    const midi = Number(note);
    const rate = 2 ** ((midi - 60) / 12);
    src.playbackRate.value = rate;
    const plain = isPlainResponse(this.response);
    const shaped = plain ? null : shapeSampleHit(this.response, velocity, this.buffer.duration, rate);
    const skip = Math.min(
      Math.max(0, Number(this.skipSec) || 0),
      Math.max(0, this.buffer.duration - 0.005),
    );
    if (shaped) {
      shaped.offsetSec = Math.min(this.buffer.duration, shaped.offsetSec + skip);
      shaped.bufferPlay = Math.max(0, Math.min(shaped.bufferPlay, this.buffer.duration - shaped.offsetSec));
      if (shaped.bufferPlay <= 0) return;
    }
    const trim = Number(this.gainTrim);
    const gainTrim = Number.isFinite(trim) && trim > 0 ? trim : 1;
    const gain = this.ctx.createGain();
    const level = (plain ? Number(velocity) : shaped.gain) * gainTrim;
    if (!plain && shaped.useEnvelope) scheduleEnvelope(gain.gain, time, shaped);
    else gain.gain.setValueAtTime(level, time);
    let head = src;
    let filter = null;
    if (shaped?.useFilter) {
      filter = this.ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.Q.value = 0.707;
      filter.frequency.setValueAtTime(Math.min(shaped.cutoff, this.ctx.sampleRate * 0.45), time);
      src.connect(filter);
      head = filter;
    }
    head.connect(gain);
    let tail = gain;
    let panner = null;
    if (this.pan != null) {
      panner = this.ctx.createStereoPanner();
      panner.pan.value = this.pan;
      gain.connect(panner);
      tail = panner;
    }
    tail.connect(this.destination);
    if (plain) {
      if (skip > 0.0001) src.start(time, skip);
      else src.start(time);
    } else src.start(time, shaped.offsetSec, shaped.bufferPlay);
    if (shaped?.useEnvelope && shaped.envelopeLen > 0) src.stop(time + shaped.envelopeLen);
    const token = { src, gain, panner, filter };
    this.current = token;
    src.onended = () => {
      if (this.current === token) this.current = null;
      disconnectQuiet(filter, gain, panner);
    };
  }

  noteOff(_time) {
    // One-shots have no release stage. Key-off must not chop a drum.
  }

  cut(time) {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const t = Number.isFinite(time) ? time : this.ctx.currentTime;
    try {
      cur.gain.gain.cancelScheduledValues(t);
      // Time constant 10 ms. The source stops at +50 ms, about five
      // constants later, so the ramp finishes before the buffer is killed.
      cur.gain.gain.setTargetAtTime(0, t, 0.01);
      cur.src.stop(t + 0.05);
    } catch {
      /* already stopped */
    }
  }
}

function scheduleEnvelope(param, time, shaped) {
  const total = shaped.attack + shaped.hold + shaped.decay;
  const peak = shaped.gain;
  if (!(total > 0.001)) {
    param.setValueAtTime(peak, time);
    return;
  }
  const n = Math.max(2, Math.min(256, Math.ceil(total * 200)));
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const at = (i / (n - 1)) * total;
    let env = 1;
    if (at < shaped.attack) env = shaped.attack > 0 ? at / shaped.attack : 1;
    else if (at > shaped.attack + shaped.hold) {
      const u = shaped.decay > 0 ? (at - shaped.attack - shaped.hold) / shaped.decay : 1;
      env = Math.max(0, 1 - u);
    }
    curve[i] = peak * env * env;
  }
  param.setValueCurveAtTime(curve, time, total);
}

function disconnectQuiet(...nodes) {
  for (const node of nodes) {
    try { node?.disconnect(); } catch { /* already disconnected */ }
  }
}

if (typeof globalThis !== "undefined" && globalThis.window === globalThis) {
  globalThis.TrackerVoices = { NOTE_OFF, isNoteOff, SampleVoice };
}
