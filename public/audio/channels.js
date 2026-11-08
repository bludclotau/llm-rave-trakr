/**
 * Drum columns, vocal columns, and FM layers.
 *
 * Columns 0–7 are the drum kit. Vocal sample columns, when a song has them,
 * sit immediately after the drums. FM layers follow those. An old song has
 * no vocal columns, so its first layer stays on column 8.
 */

export const DRUM_ROLES = Object.freeze([
  "kick", "snare", "hat", "openhat", "clap", "perc", "crash", "bass",
]);

export const DRUM_CHANNELS = DRUM_ROLES.length;
export const VOX_CHANNEL_COUNT = 2;

export function voxCount(song) {
  const n = Number(song?.voxChannels);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(VOX_CHANNEL_COUNT, Math.round(n));
}

/** First column that is an FM or sample layer, not a drum or vocal column. */
export function layerBase(song) {
  return DRUM_CHANNELS + voxCount(song);
}

export function isDrumChannel(ch) {
  return ch >= 0 && ch < DRUM_CHANNELS;
}

export function isVoxChannel(song, ch) {
  return ch >= DRUM_CHANNELS && ch < layerBase(song);
}

export function isLayerColumn(song, ch) {
  return ch >= layerBase(song);
}

export function layerIndex(song, ch) {
  return ch - layerBase(song);
}

export function roleForChannel(song, ch) {
  if (isDrumChannel(ch)) return DRUM_ROLES[ch];
  if (isVoxChannel(song, ch)) return "vox";
  return null;
}

/**
 * A layer whose instrument is a sample plays like a drum column.
 * FM layers stay on FMVoice.
 */
export function layerInstrument(song, ch) {
  if (!isLayerColumn(song, ch)) return null;
  const layer = song?.layers?.[layerIndex(song, ch)];
  if (!layer) return null;
  return (song.instruments || []).find((item) => item.id === layer.instrumentId) || null;
}

export function isSampleLayer(song, ch) {
  return layerInstrument(song, ch)?.type === "sample";
}

/** Drum, vocal, or sample-layer column. These use SampleVoice. */
export function isSampleColumn(song, ch) {
  return isDrumChannel(ch) || isVoxChannel(song, ch) || isSampleLayer(song, ch);
}
