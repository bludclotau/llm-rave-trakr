/**
 * WAV measurements. Pure module: a buffer in, numbers out. No filesystem.
 *
 * Used by the sample index and the vocal importer. PCM integer and 32-bit
 * float are read. Other encodings return null and the caller skips the file.
 */

const TARGET_PEAK = 0.89;
const MIN_GAIN = 0.25;
const MAX_GAIN = 4;

function clampGain(peak) {
  if (!(peak > 1e-6)) return 1;
  return Math.min(MAX_GAIN, Math.max(MIN_GAIN, TARGET_PEAK / peak));
}

function readFourcc(view, offset) {
  return String.fromCharCode(
    view.getUint8(offset),
    view.getUint8(offset + 1),
    view.getUint8(offset + 2),
    view.getUint8(offset + 3),
  );
}

/** Locate fmt and data. Returns null when the buffer is not a PCM/float WAV. */
export function parseWav(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (buf.length < 44) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (readFourcc(view, 0) !== "RIFF" || readFourcc(view, 8) !== "WAVE") return null;
  let offset = 12;
  let fmt = null;
  let data = null;
  while (offset + 8 <= buf.length) {
    const id = readFourcc(view, offset);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + size > buf.length) break;
    if (id === "fmt " && size >= 16) {
      fmt = {
        audioFormat: view.getUint16(start, true),
        channels: view.getUint16(start + 2, true),
        sampleRate: view.getUint32(start + 4, true),
        bits: view.getUint16(start + 14, true),
      };
    } else if (id === "data") {
      data = { start, size };
    }
    offset = start + size + (size % 2);
  }
  if (!fmt || !data || !fmt.channels || !fmt.sampleRate) return null;
  if (fmt.audioFormat !== 1 && fmt.audioFormat !== 3) return null;
  if (fmt.audioFormat === 3 && fmt.bits !== 32) return null;
  if (fmt.audioFormat === 1 && ![8, 16, 24, 32].includes(fmt.bits)) return null;
  return { view, fmt, data };
}

function readSample(view, fmt, pos) {
  if (fmt.audioFormat === 3) return view.getFloat32(pos, true);
  if (fmt.bits === 8) return (view.getUint8(pos) - 128) / 128;
  if (fmt.bits === 16) return view.getInt16(pos, true) / 32768;
  if (fmt.bits === 24) {
    const b0 = view.getUint8(pos);
    const b1 = view.getUint8(pos + 1);
    const b2 = view.getUint8(pos + 2);
    let v = b0 | (b1 << 8) | (b2 << 16);
    if (v & 0x800000) v |= ~0xffffff;
    return v / 8388608;
  }
  return view.getInt32(pos, true) / 2147483648;
}

/** `dataStart` is an offset into `view`, not into the underlying ArrayBuffer. */
function monoFrame(view, fmt, dataStart, frame) {
  const bytes = fmt.bits / 8;
  const framePos = dataStart + frame * fmt.channels * bytes;
  if (framePos + fmt.channels * bytes > view.byteLength) return 0;
  let sum = 0;
  for (let ch = 0; ch < fmt.channels; ch++) sum += readSample(view, fmt, framePos + ch * bytes);
  return sum / fmt.channels;
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

/**
 * duration, peak, rms, gain trim, leading-silence offset (seconds),
 * brightness (spectral centroid, Hz), and an optional fundamental.
 */
export function analyzeWav(bytes, opts = {}) {
  const parsed = parseWav(bytes);
  if (!parsed) return null;
  const { view, fmt, data } = parsed;
  const bytesPerFrame = fmt.channels * (fmt.bits / 8);
  const frames = Math.floor(data.size / bytesPerFrame);
  if (!frames) return null;
  const rate = fmt.sampleRate;
  const duration = frames / rate;
  const limit = Math.min(frames, rate * 12);
  let peak = 0;
  let sumSq = 0;
  let first = -1;
  const scratch = new Float32Array(limit);
  for (let i = 0; i < limit; i++) {
    const s = monoFrame(view, fmt, data.start, i);
    scratch[i] = s;
    const a = Math.abs(s);
    if (a > peak) peak = a;
    sumSq += s * s;
  }
  const gate = Math.max(0.005, peak * 0.02);
  for (let i = 0; i < limit; i++) {
    if (Math.abs(scratch[i]) >= gate) {
      first = i;
      break;
    }
  }
  const rms = Math.sqrt(sumSq / limit);
  const offset = first > 0 ? first / rate : 0;
  const brightness = centroid(scratch, rate, first < 0 ? 0 : first);
  const pitch = opts.pitch ? fundamental(scratch, rate, first < 0 ? 0 : first) : null;
  return {
    duration: round4(duration),
    peak: round4(peak),
    rms: round4(rms),
    gain: round4(clampGain(peak)),
    offset: round4(offset),
    brightness: brightness == null ? null : Math.round(brightness),
    pitch: pitch == null ? null : round4(pitch),
  };
}

function centroid(samples, rate, from) {
  const n = 2048;
  const start = Math.min(Math.max(0, from), Math.max(0, samples.length - n));
  if (samples.length - start < 64) return null;
  const len = Math.min(n, samples.length - start);
  let magSum = 0;
  let weighted = 0;
  const half = Math.floor(len / 2);
  for (let k = 1; k < half; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < len; i++) {
      const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (len - 1)));
      const angle = (2 * Math.PI * k * i) / len;
      if (i % 4) continue;
      const v = samples[start + i] * w;
      re += v * Math.cos(angle);
      im -= v * Math.sin(angle);
    }
    const mag = Math.hypot(re, im);
    const freq = (k * rate) / len;
    magSum += mag;
    weighted += freq * mag;
  }
  if (magSum <= 0) return null;
  return weighted / magSum;
}

/** Autocorrelation fundamental between 40 Hz and 400 Hz. Null when it is weak. */
function fundamental(samples, rate, from) {
  const start = Math.min(Math.max(0, from), samples.length);
  const take = Math.min(samples.length - start, rate);
  if (take < rate / 40) return null;
  const minLag = Math.max(1, Math.floor(rate / 400));
  const maxLag = Math.min(take - 1, Math.floor(rate / 40));
  let bestLag = 0;
  let best = 0;
  let energy = 0;
  for (let i = 0; i < take; i++) energy += samples[start + i] ** 2;
  if (energy < 1e-6) return null;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let corr = 0;
    const n = take - lag;
    for (let i = 0; i < n; i += 2) corr += samples[start + i] * samples[start + i + lag];
    if (corr > best) {
      best = corr;
      bestLag = lag;
    }
  }
  if (!bestLag || best < energy * 0.15) return null;
  return rate / bestLag;
}

export function tagsFromPath(rel) {
  const stop = new Set(["wav", "aiff", "aif", "flac", "ogg", "mp3", "wavbvkery", "dreams", "samples", "public"]);
  const tags = [];
  for (const part of String(rel || "").toLowerCase().replace(/\.[a-z0-9]+$/, "").split(/[^a-z0-9]+/)) {
    if (part.length < 2 || stop.has(part) || /^\d+$/.test(part)) continue;
    if (!tags.includes(part)) tags.push(part);
  }
  return tags.slice(0, 8);
}

/** 16-bit mono WAV. `samples` is a Float32Array in -1..1. */
export function encodePcm16Wav(samples, sampleRate) {
  const n = samples.length;
  const buffer = new ArrayBuffer(44 + n * 2);
  const view = new DataView(buffer);
  const write = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + n * 2, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const clipped = Math.max(-1, Math.min(1, samples[i] || 0));
    view.setInt16(44 + i * 2, Math.round(clipped * 32767), true);
  }
  return new Uint8Array(buffer);
}

/**
 * Drop leading and trailing silence and scale the peak to the kit target.
 * Returns a 16-bit mono WAV buffer plus the measurements of that buffer.
 */
export function renderNormalizedWav(bytes, sampleRateHint) {
  const parsed = parseWav(bytes);
  if (!parsed) return null;
  const { view, fmt, data } = parsed;
  const bytesPerFrame = fmt.channels * (fmt.bits / 8);
  const frames = Math.floor(data.size / bytesPerFrame);
  const mono = new Float32Array(frames);
  let peak = 0;
  for (let i = 0; i < frames; i++) {
    const s = monoFrame(view, fmt, data.start, i);
    mono[i] = s;
    peak = Math.max(peak, Math.abs(s));
  }
  const gate = Math.max(0.005, peak * 0.02);
  let start = 0;
  let end = frames;
  while (start < end && Math.abs(mono[start]) < gate) start += 1;
  while (end > start && Math.abs(mono[end - 1]) < gate) end -= 1;
  if (end - start < 16) {
    start = 0;
    end = frames;
  }
  const slice = mono.subarray(start, end);
  const slicePeak = peak || 1;
  const gain = TARGET_PEAK / slicePeak;
  const out = new Float32Array(slice.length);
  for (let i = 0; i < slice.length; i++) out[i] = Math.max(-1, Math.min(1, slice[i] * gain));
  const rate = sampleRateHint || fmt.sampleRate;
  const encoded = encodePcm16Wav(out, rate);
  return { wav: encoded, info: analyzeWav(encoded, { pitch: true }) };
}
