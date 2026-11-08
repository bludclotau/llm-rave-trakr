import { SampleVoice } from "/audio/voice.js";
import { ChannelStrip, createMasterChain } from "/audio/dsp-strip.js";
import { channelSampler, normalizeChannelFx, resolveCatalogSample } from "/audio/instruments.js";
import { createLibrary } from "/audio/library.js";
import { DRUM_CHANNELS, DRUM_ROLES, isVoxChannel, roleForChannel } from "/audio/channels.js";
import { bassNoteFor } from "/audio/compose-plan.js";
import { filterLyricGroups, groupLyrics } from "/audio/lyric-bank.js";

const NOTES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];
const LANE_NAMES = ["KICK", "SNARE", "HAT", "OPEN", "CLAP", "PERC", "CRASH", "BASS", "VOX A", "VOX B"];
const ROWS = 16;
const LANES = 10;

const $ = (id) => document.getElementById(id);
const library = createLibrary();

const state = {
  song: null,
  lyrics: [],
  armed: null,
  laneSample: Array(LANES).fill(0),
  ch: 8,
  row: 0,
  playing: false,
  playRow: 0,
  nextTime: 0,
  timer: 0,
  ctx: null,
  master: null,
  strips: [],
  voices: [],
  preview: null,
};

function midiOf(note) {
  const match = String(note || "").match(/^([A-G]#?)[ -]?(\d)$/i);
  if (!match) return null;
  const token = match[1].length === 1 ? match[1].toUpperCase() + "-" : match[1][0].toUpperCase() + match[1][1];
  const idx = NOTES.indexOf(token);
  if (idx < 0) return null;
  return idx + (Number(match[2]) + 1) * 12;
}

function emptyCell() {
  return { note: null, sample: 0, volume: 0, effect: 0, param: 0 };
}

function emptyColumn() {
  return Array.from({ length: ROWS }, emptyCell);
}

function blankSong() {
  return {
    title: "Rave Deck",
    bpm: 128,
    speed: 6,
    rows: ROWS,
    channels: LANES,
    voxChannels: 2,
    patterns: [{ name: "Rave Deck", rows: ROWS, data: Array.from({ length: LANES }, emptyColumn) }],
    channelSampler: {},
    channelFx: {},
  };
}

function status(text, kind) {
  const el = $("status");
  el.textContent = text;
  el.className = `status${kind ? ` ${kind}` : ""}`;
}

function currentBpm() {
  return Number($("bpm").value) || state.song?.bpm || 128;
}

function secondsPerRow() {
  const speed = Number(state.song?.speed) || 6;
  return (speed * 2.5) / currentBpm();
}

function pattern() {
  return state.song?.patterns?.[0];
}

function shortSample(sample) {
  return String(sample?.name || "")
    .replace(/^wavbvkery\s*-\s*dreams\s*/i, "")
    .replace(/\.[a-z0-9]+$/i, "");
}

function kitFor(role) {
  return library.list().filter((sample) => sample.role === role && sample.source !== "wordfactory");
}

function viewSong(song) {
  const copy = song?.patterns?.[0]?.data ? structuredClone(song) : blankSong();
  const data = copy.patterns[0].data;
  for (const column of data) {
    while (column.length < ROWS) column.push(emptyCell());
  }
  if (!Number(copy.voxChannels)) {
    copy.patterns[0].data = [...data.slice(0, DRUM_CHANNELS), emptyColumn(), emptyColumn()];
    copy.voxChannels = 2;
    copy.layers = [];
  }
  copy.channels = copy.patterns[0].data.length;
  copy.rows = ROWS;
  return copy;
}

function spreadVocals() {
  const data = pattern().data;
  const hits = [];
  for (const ch of [DRUM_CHANNELS, DRUM_CHANNELS + 1]) {
    data[ch].forEach((cell, row) => {
      if (cell?.note && cell.sample) hits.push({ ch, row, cell });
    });
  }
  if (hits.length < 2 || new Set(hits.map((hit) => hit.ch)).size > 1) return;
  const second = hits[1];
  const other = second.ch === DRUM_CHANNELS ? DRUM_CHANNELS + 1 : DRUM_CHANNELS;
  if (data[other][second.row]?.note) return;
  data[second.ch][second.row] = emptyCell();
  data[other][second.row] = second.cell;
}

function inferLaneSamples() {
  for (let ch = 0; ch < DRUM_CHANNELS; ch++) {
    const column = pattern().data[ch] || [];
    const hit = column.find((cell) => cell?.sample);
    const role = DRUM_ROLES[ch];
    const kit = kitFor(role);
    state.laneSample[ch] = hit?.sample || kit[0]?.id || 0;
  }
}

async function ensureAudio() {
  if (state.ctx) {
    if (state.ctx.state === "suspended") await state.ctx.resume();
    return state.ctx;
  }
  const ctx = new AudioContext();
  const bus = createMasterChain(ctx);
  bus.master.gain.value = Number($("master").value) / 100;
  state.ctx = ctx;
  state.master = bus.master;
  state.strips = Array.from({ length: LANES }, () => new ChannelStrip(ctx, bus.master, bus));
  state.voices = state.strips.map((strip) => new SampleVoice(ctx, strip.input));
  state.preview = new SampleVoice(ctx, bus.master);
  state.preview.pan = null;
  return ctx;
}

function applyStrips(when) {
  if (!state.ctx) return;
  const t = when ?? state.ctx.currentTime;
  for (let ch = 0; ch < LANES; ch++) {
    state.strips[ch]?.setFx(normalizeChannelFx(state.song?.channelFx?.[ch]), t, currentBpm(), true);
  }
}

async function bufferFor(sample) {
  if (!sample?.url) return null;
  const cached = library.buffer(sample.id);
  if (cached) return cached;
  await ensureAudio();
  const res = await fetch(sample.url);
  if (!res.ok) return null;
  const audio = await state.ctx.decodeAudioData(await res.arrayBuffer());
  library.setBuffer(sample.id, audio);
  return audio;
}

function cutVoice(ch, when) {
  state.voices[ch]?.cut(when);
}

function playCell(cell, when, ch) {
  const voice = state.voices[ch];
  if (!voice || !cell?.note || !cell.sample) return;
  const sample = resolveCatalogSample(cell.sample, state.song, library.list());
  const buf = sample && library.buffer(sample.id);
  if (!buf) return;
  const role = roleForChannel(state.song, ch);
  if (sample.muteGroup === "hats") {
    cutVoice(DRUM_ROLES.indexOf("hat"), when);
    cutVoice(DRUM_ROLES.indexOf("openhat"), when);
  } else {
    cutVoice(ch, when);
  }
  voice.buffer = buf;
  voice.pan = (ch - 4) / 10;
  voice.response = channelSampler(state.song, ch);
  voice.gainTrim = Number(sample.gain) > 0 ? Number(sample.gain) : 1;
  voice.skipSec = Number(sample.offset) > 0 ? Number(sample.offset) : 0;
  const midi = midiOf(cell.note) ?? (role === "bass" ? 24 : 60);
  voice.noteOn(when, midi, (cell.volume || 64) / 64);
}

function schedule() {
  if (!state.playing || !state.ctx) return;
  const ahead = 0.12;
  const pat = pattern();
  while (state.nextTime < state.ctx.currentTime + ahead) {
    const row = state.playRow;
    for (let ch = 0; ch < LANES; ch++) playCell(pat.data[ch]?.[row], state.nextTime, ch);
    paintPlayhead(row);
    state.playRow = (row + 1) % ROWS;
    state.nextTime += secondsPerRow();
  }
  state.timer = requestAnimationFrame(schedule);
}

function paintPlayhead(row) {
  document.querySelectorAll(".step.now").forEach((el) => el.classList.remove("now"));
  document.querySelectorAll(`.step[data-row="${row}"]`).forEach((el) => el.classList.add("now"));
}

async function warm(song) {
  const ids = new Set();
  for (let ch = 0; ch < LANES; ch++) {
    if (state.laneSample[ch]) ids.add(state.laneSample[ch]);
    for (const cell of song.patterns[0].data[ch] || []) {
      if (cell?.sample) ids.add(cell.sample);
    }
  }
  await Promise.all([...ids].map(async (id) => {
    const sample = library.list().find((item) => item.id === id);
    if (sample) await bufferFor(sample);
  }));
}

function renderLanes() {
  const root = $("lanes");
  root.replaceChildren();
  const pat = pattern();
  for (let ch = 0; ch < LANES; ch++) {
    const lane = document.createElement("div");
    lane.className = `lane${ch === state.ch ? " selected" : ""}${ch >= DRUM_CHANNELS ? " vox" : ""}`;
    lane.dataset.ch = String(ch);
    const name = document.createElement("button");
    name.type = "button";
    name.className = "lane-name";
    name.textContent = LANE_NAMES[ch];
    name.addEventListener("click", () => {
      state.ch = ch;
      renderLanes();
    });
    lane.append(name);
    if (ch < DRUM_CHANNELS) {
      const select = document.createElement("select");
      select.setAttribute("aria-label", `${LANE_NAMES[ch]} sample`);
      for (const sample of kitFor(DRUM_ROLES[ch])) {
        const option = document.createElement("option");
        option.value = String(sample.id);
        option.textContent = shortSample(sample);
        if (sample.id === state.laneSample[ch]) option.selected = true;
        select.append(option);
      }
      select.addEventListener("change", () => {
        state.laneSample[ch] = Number(select.value);
      });
      lane.append(select);
    } else {
      const note = document.createElement("span");
      note.className = "mood";
      note.textContent = "lyric one-shot";
      lane.append(note);
    }
    const steps = document.createElement("div");
    steps.className = "steps";
    for (let row = 0; row < ROWS; row++) {
      const cell = pat.data[ch][row];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "step";
      button.dataset.ch = String(ch);
      button.dataset.row = String(row);
      if (row % 4 === 0) button.classList.add("down");
      if (cell?.note && cell.sample) {
        button.classList.add("on");
        if (cell.volume >= 60) button.classList.add("accent");
        else if (cell.volume <= 32) button.classList.add("ghost");
        if (ch >= DRUM_CHANNELS) {
          const sample = library.list().find((item) => item.id === cell.sample);
          button.textContent = (sample?.treatment || "vox").slice(0, 3);
          button.classList.add("vox-hit");
          button.title = sample ? `${sample.word} · ${sample.treatment}` : "vocal";
        }
      }
      if (ch === state.ch && row === state.row) button.classList.add("selected");
      button.addEventListener("click", () => onStep(ch, row));
      steps.append(button);
    }
    lane.append(steps);
    root.append(lane);
  }
  if (state.playing) paintPlayhead(state.playRow);
}

function onStep(ch, row) {
  state.ch = ch;
  state.row = row;
  const cell = pattern().data[ch][row];
  if (ch < DRUM_CHANNELS) {
    if (cell?.note) pattern().data[ch][row] = emptyCell();
    else {
      const sample = library.list().find((item) => item.id === state.laneSample[ch]);
      const note = DRUM_ROLES[ch] === "bass" ? bassNoteFor(sample) : "C-4";
      pattern().data[ch][row] = { note, sample: state.laneSample[ch], volume: 64, effect: 0, param: 0 };
    }
  } else if (cell?.note) {
    pattern().data[ch][row] = emptyCell();
  } else if (state.armed) {
    placeArmed(ch, row);
    return;
  }
  renderLanes();
}

function placeArmed(ch = state.ch, row = state.row) {
  if (!state.armed || !state.song) return;
  const lane = isVoxChannel(state.song, ch) ? ch : DRUM_CHANNELS;
  const step = Math.max(0, Math.min(ROWS - 1, row));
  pattern().data[lane][step] = {
    note: "C-4",
    sample: state.armed.id,
    volume: 56,
    effect: 0,
    param: 0,
  };
  state.ch = lane;
  state.row = step;
  bufferFor(state.armed).catch(() => {});
  renderLanes();
}

function renderRack() {
  const moods = [...new Set(state.lyrics.map((sample) => sample.mood).filter(Boolean))].sort();
  const treatments = [...new Set(state.lyrics.map((sample) => sample.treatment).filter(Boolean))].sort();
  fillSelect($("lyric-mood"), moods, "all moods");
  fillSelect($("lyric-treatment"), treatments, "all treatments");
  const groups = filterLyricGroups(groupLyrics(state.lyrics), {
    q: $("lyric-q").value,
    mood: $("lyric-mood").value,
    treatment: $("lyric-treatment").value,
    review: $("lyric-review").value,
  });
  const shown = groups.reduce((sum, group) => sum + group.takes.length, 0);
  $("lyric-count").textContent = state.lyrics.length
    ? `${groups.length} words · ${shown} takes`
    : "no lyrics";
  const list = $("lyric-list");
  list.replaceChildren();
  if (!groups.length) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = state.lyrics.length
      ? "nothing matches these filters"
      : "word factory database is not connected";
    list.append(empty);
  }
  for (const group of groups) {
    const card = document.createElement("article");
    card.className = "word";
    const head = document.createElement("header");
    const title = document.createElement("strong");
    title.textContent = group.word;
    const mood = document.createElement("span");
    mood.className = "mood";
    mood.textContent = group.mood || "";
    head.append(title, mood);
    const takes = document.createElement("div");
    takes.className = "takes";
    for (const sample of group.takes) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `take${state.armed?.id === sample.id ? " armed" : ""}`;
      button.textContent = sample.treatment;
      button.addEventListener("click", () => arm(sample));
      takes.append(button);
    }
    card.append(head, takes);
    list.append(card);
  }
  $("lyric-armed").textContent = state.armed
    ? `armed ${state.armed.word} · ${state.armed.treatment}`
    : "pick a take, then place it on a vocal step";
  $("btn-place").disabled = !state.armed;
}

function fillSelect(select, values, label) {
  const current = select.value;
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = label;
  select.append(all);
  for (const value of values) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    if (value === current) option.selected = true;
    select.append(option);
  }
}

async function arm(sample) {
  state.armed = sample;
  renderRack();
  try {
    await ensureAudio();
    const buf = await bufferFor(sample);
    if (!buf || !state.preview) return;
    state.preview.buffer = buf;
    state.preview.gainTrim = sample.gain || 1;
    state.preview.skipSec = sample.offset || 0;
    state.preview.response = null;
    state.preview.cut(state.ctx.currentTime);
    state.preview.noteOn(state.ctx.currentTime + 0.01, 60, 0.9);
  } catch (err) {
    status(err.message || "could not play that take", "err");
  }
}

async function adopt(song) {
  state.song = viewSong(song);
  spreadVocals();
  $("bpm").value = state.song.bpm || 128;
  $("song-title").textContent = state.song.title || "Rave Deck";
  const llm = state.song.llm;
  $("llm-meta").textContent = llm
    ? `${llm.provider || "template"}${llm.model ? ` · ${llm.model}` : ""}`
    : "";
  inferLaneSamples();
  await ensureAudio();
  applyStrips();
  await warm(state.song);
  renderLanes();
}

async function compose(local) {
  const buttons = [$("btn-compose"), $("btn-preset"), $("btn-play")];
  buttons.forEach((button) => { button.disabled = true; });
  status(local ? "loading preset…" : "composing…", "busy");
  try {
    const res = await fetch("/api/compose", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: $("prompt").value,
        node: $("node").value,
        local: Boolean(local),
      }),
    });
    const song = await res.json();
    if (!res.ok) throw new Error(song.error || "compose failed");
    await adopt(song);
    const vox = vocalHits();
    status(
      `${local ? "preset" : "composed"} · ${state.song.title} · ${vox} vocal hits`,
      "ok",
    );
  } catch (err) {
    status(err.message || "compose failed", "err");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

function vocalHits() {
  const data = pattern()?.data || [];
  let n = 0;
  for (let ch = DRUM_CHANNELS; ch < LANES; ch++) {
    n += (data[ch] || []).filter((cell) => cell?.note && cell.sample).length;
  }
  return n;
}

async function play() {
  await ensureAudio();
  if (state.playing) return;
  await warm(state.song);
  applyStrips();
  state.playing = true;
  state.playRow = 0;
  state.nextTime = state.ctx.currentTime + 0.05;
  status("playing", "ok");
  schedule();
}

function stop() {
  state.playing = false;
  cancelAnimationFrame(state.timer);
  const now = state.ctx?.currentTime || 0;
  for (const voice of state.voices) voice?.cut(now);
  state.preview?.cut(now);
  document.querySelectorAll(".step.now").forEach((el) => el.classList.remove("now"));
  if (state.song) status(`stopped · ${state.song.title || "Rave Deck"}`, "ok");
}

async function loadLyrics() {
  const res = await fetch("/api/lyrics");
  const body = await res.json();
  state.lyrics = Array.isArray(body.records) ? body.records : [];
  const counts = {};
  for (const sample of state.lyrics) counts[sample.review] = (counts[sample.review] || 0) + 1;
  if (counts[$("lyric-review").value]) {
    /* keep the current review filter */
  } else if (counts.new) $("lyric-review").value = "new";
  else if (counts.kept) $("lyric-review").value = "kept";
  else $("lyric-review").value = "all";
  library.replaceKit([
    ...library.list().filter((sample) => sample.source !== "wordfactory"),
    ...state.lyrics.filter((sample) => sample.review !== "discarded"),
  ]);
  renderRack();
  return body;
}

async function loadKit() {
  const res = await fetch("/api/samples");
  const body = await res.json();
  library.replaceKit(body.samples || []);
}

async function boot() {
  state.song = blankSong();
  renderLanes();
  try {
    await loadKit();
    const lyrics = await loadLyrics();
    state.lyricError = lyrics.ok ? "" : (lyrics.error || "lyrics offline");
  } catch (err) {
    state.lyricError = err.message || "could not load samples";
  }
  await compose(true);
  if (state.lyricError) status(`${$("status").textContent} · ${state.lyricError}`, "err");
  if (new URLSearchParams(location.search).get("e2e") === "1") {
    window.__rave = {
      get song() { return state.song; },
      lyrics() { return state.lyrics.length; },
      armed() { return state.armed; },
      place(id) {
        const sample = state.lyrics.find((item) => item.dbId === id || item.id === id);
        if (!sample) return null;
        state.armed = sample;
        placeArmed(8, 0);
        const cell = pattern().data[8][0];
        return { id: cell.sample, note: cell.note, role: "vox", muteGroup: sample.muteGroup };
      },
      placeFirst() {
        const sample = state.lyrics.find((item) => item.review !== "discarded");
        if (!sample) return null;
        return window.__rave.place(sample.dbId);
      },
      snapshot() { return structuredClone(state.song); },
      audio() { return state.ctx?.state || "none"; },
    };
  }
}

$("btn-play").addEventListener("click", () => play());
$("btn-stop").addEventListener("click", () => stop());
$("btn-compose").addEventListener("click", () => compose(false));
$("btn-preset").addEventListener("click", () => compose(true));
$("btn-place").addEventListener("click", () => placeArmed());
$("btn-rescan").addEventListener("click", async () => {
  status("rescanning kit…", "busy");
  const res = await fetch("/api/samples/rescan", { method: "POST" });
  const body = await res.json();
  library.replaceKit(body.samples || []);
  inferLaneSamples();
  renderLanes();
  status("kit rescanned", "ok");
});
$("btn-lyrics").addEventListener("click", async () => {
  status("refreshing lyrics…", "busy");
  const res = await fetch("/api/lyrics/refresh", { method: "POST" });
  const body = await res.json();
  if (!res.ok || !body.ok) {
    status(body.error || "lyrics offline", "err");
    return;
  }
  await loadKit();
  await loadLyrics();
  status(`lyrics ${state.lyrics.length}`, "ok");
});
for (const id of ["lyric-q", "lyric-mood", "lyric-treatment", "lyric-review"]) {
  $(id).addEventListener("input", renderRack);
  $(id).addEventListener("change", renderRack);
}
$("bpm").addEventListener("change", () => {
  if (state.song) state.song.bpm = currentBpm();
});
$("master").addEventListener("input", () => {
  if (state.master) state.master.gain.value = Number($("master").value) / 100;
});
document.addEventListener("keydown", (event) => {
  if (event.target.matches("input, select, textarea")) return;
  if (event.code === "Space") {
    event.preventDefault();
    if (state.playing) stop();
    else play();
  } else if (event.key === "ArrowRight") {
    state.row = (state.row + 1) % ROWS;
    renderLanes();
  } else if (event.key === "ArrowLeft") {
    state.row = (state.row + ROWS - 1) % ROWS;
    renderLanes();
  } else if (event.key === "ArrowDown") {
    state.ch = Math.min(LANES - 1, state.ch + 1);
    renderLanes();
  } else if (event.key === "ArrowUp") {
    state.ch = Math.max(0, state.ch - 1);
    renderLanes();
  }
});

boot();
