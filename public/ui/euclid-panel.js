/**
 * Euclidean strip for one sample column. GENERATE writes cells and leaves
 * effect and param alone.
 */

import { channelEuclid, euclidRows, euclidString, normalizeEuclid, STEP_RATES } from "../audio/euclid.js";

const FIELDS = [
  ["eu-length", "length"],
  ["eu-hits", "hits"],
  ["eu-shift", "shift"],
  ["eu-rate", "stepRate"],
];

export function createEuclidPanel(api) {
  function paint() {
    const { $, state } = api;
    const label = $("eu-channel");
    if (!label || !state.song) return;
    const ch = state.ch;
    const sampleCh = api.isSampleColumn(state.song, ch);
    const cfg = sampleCh ? channelEuclid(state.song, ch) : normalizeEuclid(null);
    label.textContent = sampleCh ? `CH${ch + 1}` : "LAYER";
    state.euSync = true;
    for (const [id, key] of FIELDS) {
      const el = $(id);
      if (!el) continue;
      el.value = String(cfg[key]);
      el.disabled = !sampleCh;
    }
    const hits = $("eu-hits");
    const shift = $("eu-shift");
    if (hits) hits.max = String(cfg.length);
    if (shift) shift.max = String(Math.max(0, cfg.length - 1));
    const generate = $("eu-generate");
    if (generate) generate.disabled = !sampleCh;
    const rows = state.song.patterns[0].rows;
    const preview = $("eu-preview");
    if (preview) preview.textContent = sampleCh ? euclidString(cfg, rows) : "";
    const stride = STEP_RATES[cfg.stepRate];
    const hint = $("eu-hint");
    if (hint) {
      hint.textContent = !sampleCh
        ? "euclid is per sample channel"
        : api.channelFmId(ch)
          ? "GENERATE rewrites this channel's notes · playback is FM"
          : `${cfg.hits} of ${cfg.length} steps · ${stride} row${stride === 1 ? "" : "s"} per step`;
    }
    state.euSync = false;
  }

  function write(key, value) {
    const { state } = api;
    if (!state.song || !api.isSampleColumn(state.song, state.ch)) return;
    const ch = state.ch;
    state.song.channelEuclid ||= {};
    const raw = key === "stepRate" ? value : Number(value);
    state.song.channelEuclid[ch] = normalizeEuclid({ ...channelEuclid(state.song, ch), [key]: raw });
    paint();
  }

  function generate() {
    const { state } = api;
    const song = state.song;
    const ch = state.ch;
    if (!song || !api.isSampleColumn(song, ch)) return;
    const pat = song.patterns[0];
    const column = pat.data[ch];
    const role = api.roleForChannel(song, ch);
    const hits = euclidRows(channelEuclid(song, ch), pat.rows);
    const proto = column.find((cell) => cell?.note && cell.note !== api.NOTE_OFF);
    const note = proto?.note || (role === "bass" ? "C-1" : "C-4");
    const sample = proto?.sample || song.kit?.[role] || state.selectedSample || 1;
    const volume = proto?.volume || (role === "hat" ? 40 : 64);
    for (let r = 0; r < pat.rows; r++) {
      const cell = column[r] || (column[r] = api.emptyCell());
      if (hits[r]) {
        cell.note = note;
        cell.sample = sample;
        cell.volume = volume;
      } else {
        cell.note = null;
        cell.sample = 0;
        cell.volume = 0;
      }
    }
    api.pruneUserSamples(song);
    api.paintColumn(ch);
    const cfg = channelEuclid(song, ch);
    api.status(`E(${cfg.hits},${cfg.length}) written to CH${ch + 1}`, "ok");
  }

  function setup() {
    const { $ } = api;
    for (const [id, key] of FIELDS) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener("change", () => {
        if (api.state.euSync) return;
        write(key, el.value);
      });
    }
    $("eu-generate")?.addEventListener("click", generate);
    paint();
  }

  return { paint, setup };
}
