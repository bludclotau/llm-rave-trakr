/**
 * Named sampler presets. The model may only return one of these names.
 * The numbers are the GCD-8 response plus a channel-strip patch. They are
 * not invented per request.
 */

export const SAMPLER_PRESET_NAMES = Object.freeze(["tight", "soft", "long", "lofi"]);

export const SAMPLER_PRESETS = Object.freeze({
  tight: {
    response: {
      level: 1, start: 0, end: 0.4, envShape: 0.2,
      velAmp: 0.2, velTone: 0.05, velStart: 0, velAttack: 0, velDecay: 0.65,
    },
    fx: { cutoff: 12000, resonance: 0.707, drive: 0, fxWet: 0, reverbSend: 0 },
  },
  soft: {
    response: {
      level: 1, start: 0, end: 1, envShape: 0.8,
      velAmp: 0.45, velTone: 0.4, velStart: 0, velAttack: 0.3, velDecay: 0.25,
    },
    fx: { cutoff: 4800, resonance: 0.9, drive: 0, fxWet: 0, reverbSend: 0.08 },
  },
  long: {
    response: {
      level: 1, start: 0, end: 1, envShape: 1,
      velAmp: 0, velTone: 0, velStart: 0, velAttack: 0, velDecay: 0,
    },
    fx: { cutoff: 14000, resonance: 0.707, drive: 0, fxWet: 0.12, reverbSend: 0.2, delayTime: 3, delayFeedback: 0.28 },
  },
  lofi: {
    response: {
      level: 0.92, start: 0.01, end: 0.8, envShape: 0.65,
      velAmp: 0.35, velTone: 0.8, velStart: 0.04, velAttack: 0.12, velDecay: 0.2,
    },
    fx: { cutoff: 2200, resonance: 0.85, drive: 0.16, fxWet: 0, filterType: "lowpass", reverbSend: 0.06 },
  },
});

export function presetForPrompt(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (/lofi|lo-fi|dusty|chill|jazz/.test(text)) return "lofi";
  if (/haunt|phonk|dark|ambient|soft|warm/.test(text)) return "soft";
  if (/trap|808|long/.test(text)) return "long";
  return "tight";
}

export function normalizePresetName(name, prompt) {
  const key = String(name || "").toLowerCase();
  if (Object.hasOwn(SAMPLER_PRESETS, key)) return key;
  return presetForPrompt(prompt);
}
