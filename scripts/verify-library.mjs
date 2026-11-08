#!/usr/bin/env node
/**
 * Sample index, stable ids, candidate clamp, and repair. No network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLibrary } from "../public/audio/library.js";
import {
  composeGrammar,
  composeMessages,
  expandSong,
  repairPlan,
  selectCandidates,
  songHasKickAndSnare,
} from "../public/audio/compose-plan.js";
import { migrateSong, SONG_VERSION } from "../public/audio/instruments.js";
import { assignIds, buildCatalog, saveUpload } from "../public/audio/sample-catalog.js";
import { analyzeWav, encodePcm16Wav, tagsFromPath } from "../public/audio/wav-info.js";
import { buildIndex } from "./index-samples.mjs";
import { importManifest } from "./import-vox.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;

function assert(cond, msg) {
  if (cond) {
    console.log(`ok  ${msg}`);
    return;
  }
  failed += 1;
  console.error(`FAIL  ${msg}`);
}

function tone(rate, seconds, freq, amp, leadSilence = 0) {
  const n = Math.round(rate * seconds);
  const lead = Math.round(rate * leadSilence);
  const samples = new Float32Array(lead + n);
  for (let i = 0; i < n; i++) samples[lead + i] = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
  return encodePcm16Wav(samples, rate);
}

function writeWav(dir, rel, bytes) {
  const dest = path.join(dir, ...rel.split("/"));
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, bytes);
}

const quiet = analyzeWav(tone(44100, 0.2, 220, 0.1), { pitch: true });
assert(quiet && quiet.gain === 4, `quiet hit gain clamps at 4 (${quiet?.gain})`);
assert(quiet.peak > 0.09 && quiet.peak < 0.11, `quiet peak recorded (${quiet?.peak})`);

const hot = analyzeWav(tone(44100, 0.2, 440, 1));
assert(hot && Math.abs(hot.gain - 0.89) < 0.02, `hot hit trims toward 0.89 (${hot?.gain})`);

const late = analyzeWav(tone(44100, 0.05, 880, 0.5, 0.1));
assert(late && late.offset > 0.09 && late.offset < 0.12, `leading silence offset (${late?.offset})`);

const tags = tagsFromPath("kicks/wavbvkery - dreams kick 01.wav");
assert(tags.includes("kick") && !tags.includes("wavbvkery") && !tags.includes("01"), `filename tags ${tags.join(",")}`);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rave-lib-"));
try {
  writeWav(dir, "kicks/kick-a.wav", tone(44100, 0.15, 80, 0.4));
  writeWav(dir, "snares/snare-a.wav", tone(44100, 0.12, 180, 0.5));
  const indexed = buildIndex(dir);
  assert(indexed.files["kicks/kick-a.wav"]?.tags?.includes("kick"), "index stores kick tags");
  assert(indexed.files["kicks/kick-a.wav"].gain > 1, "index stores a gain trim above unity for a quiet kick");
  assert(indexed.files["snares/snare-a.wav"].offset === 0, "a hit with no lead silence has offset 0");

  const first = buildCatalog(dir);
  const kickId = first.ids["kicks/kick-a.wav"];
  const snareId = first.ids["snares/snare-a.wav"];
  writeWav(dir, "hats closed/hat-a.wav", tone(44100, 0.08, 4000, 0.3));
  const second = buildCatalog(dir);
  assert(second.ids["kicks/kick-a.wav"] === kickId && second.ids["snares/snare-a.wav"] === snareId, "rescan keeps existing ids");
  assert(second.ids["hats closed/hat-a.wav"] === Math.max(kickId, snareId) + 1, "a new file takes the next id");
  const reserved = { ...second.ids };
  fs.rmSync(path.join(dir, "snares", "snare-a.wav"));
  const third = buildCatalog(dir);
  assert(third.ids["kicks/kick-a.wav"] === kickId, "deleting another file does not move the kick id");
  assert(assignIds(["kicks/kick-a.wav"], reserved)["snares/snare-a.wav"] === snareId, "a removed file keeps its reserved id");

  const wav = tone(44100, 0.05, 440, 0.4);
  const uploaded = saveUpload(dir, { filename: "../nope.wav", mime: "audio/wav", bytes: wav });
  assert(uploaded.sample?.file === "user/nope.wav", `upload stays inside user/ (${uploaded.sample?.file})`);
  const afterUpload = buildCatalog(dir);
  assert(afterUpload.ids["kicks/kick-a.wav"] === kickId, "upload rescan leaves the kit id alone");
  assert(afterUpload.ids["user/nope.wav"] > kickId, "upload receives a new id");
  let rejected = false;
  try {
    saveUpload(dir, { filename: "x.wav", mime: "text/plain", bytes: wav });
  } catch (err) {
    rejected = err.status === 415;
  }
  assert(rejected, "a non-audio MIME is refused");

  const library = createLibrary();
  library.replaceKit(afterUpload.samples);
  library.add({ id: 1000, name: "embedded", role: "perc", user: true, data: "abc", file: null });
  library.remember({ id: 1000, name: "embedded", data: "abc", role: "perc" });
  library.replaceKit(afterUpload.samples.filter((sample) => sample.role !== "perc"));
  assert(library.get(1000)?.user === true, "compose catalog swap keeps an embedded sample");
  assert(library.getByFile("kicks/kick-a.wav")?.id === kickId, "lookup by file");

  const voxSrc = path.join(dir, "src");
  fs.mkdirSync(voxSrc);
  const voxFile = path.join(voxSrc, "take.wav");
  fs.writeFileSync(voxFile, tone(48000, 0.2, 200, 0.2, 0.05));
  const manifest = path.join(dir, "manifest.json");
  fs.writeFileSync(manifest, JSON.stringify([
    { word: "alpha", treatment: "whisper", file_path: voxFile, review_status: "kept" },
    { word: "alpha", treatment: "shout", file_path: voxFile, review_status: "discarded" },
  ]));
  const voxDir = path.join(dir, "vox-out");
  const imported = importManifest({
    manifest,
    audioRoot: voxSrc,
    dest: voxDir,
    review: "kept",
    limit: 5,
  });
  assert(imported.imported === 1 && imported.skipped === 1, `importer keeps one reviewed row (${imported.imported}/${imported.skipped})`);
  const names = fs.readdirSync(voxDir).filter((name) => name.endsWith(".wav"));
  assert(names.length === 1 && !names[0].includes("alpha"), "vox filename omits the word");
  const voxIndex = JSON.parse(fs.readFileSync(path.join(voxDir, "index.json"), "utf8"));
  const voxMeta = Object.values(voxIndex.files)[0];
  assert(voxMeta.role === "vox" && voxMeta.treatment === "whisper" && voxMeta.word === "alpha", "vox index records role, treatment, and word");
  assert(voxMeta.gain > 0.9 && voxMeta.gain < 1.2, `imported gain is near unity (${voxMeta.gain})`);
  assert(voxMeta.offset < 0.005, `imported leading silence is trimmed (${voxMeta.offset})`);

  const catalog = {
    samples: [
      { id: kickId, role: "kick", name: "kick", tags: ["kick", "punchy"], duration: 0.2, brightness: 200, file: "kicks/kick-a.wav" },
      { id: 50, role: "kick", name: "kick soft", tags: ["kick"], duration: 0.3, brightness: 100, file: "kicks/kick-b.wav" },
      { id: snareId, role: "snare", name: "snare", tags: ["snare", "snappy"], duration: 0.15, brightness: 1800, file: "snares/snare-a.wav" },
      { id: 7, role: "hat", name: "hat", tags: ["hat"], duration: 0.05, brightness: 6000, file: "hats/hat.wav" },
      { id: 8, role: "openhat", name: "open", tags: ["openhat"], duration: 0.2, brightness: 5000, file: "hats/open.wav" },
      { id: 9, role: "clap", name: "clap", tags: ["clap"], duration: 0.1, brightness: 2000, file: "claps/clap.wav" },
      { id: 10, role: "perc", name: "perc", tags: ["perc"], duration: 0.1, brightness: 1500, file: "percs/perc.wav" },
      { id: 11, role: "crash", name: "crash", tags: ["crash"], duration: 1, brightness: 4000, file: "cymbals/crash.wav" },
      { id: 12, role: "crash", name: "crash long", tags: ["crash"], duration: 2, brightness: 3000, file: "cymbals/crash2.wav" },
      { id: 13, role: "bass", name: "808", tags: ["bass", "808"], duration: 0.8, brightness: 150, pitch: 110, file: "808s/808.wav" },
      { id: 40, role: "vox", name: "alpha · whisper", word: "alpha", treatment: "whisper", tags: ["vox", "whisper"], duration: 0.4, brightness: 800, file: "vox/001_whisper.wav" },
      { id: 41, role: "vox", name: "alpha · shout", word: "alpha", treatment: "shout", tags: ["vox", "shout"], duration: 0.4, brightness: 1200, file: "vox/002_shout.wav" },
    ],
  };
  const prompt = "haunting phonk, punchy kick, snappy snare";
  const candidates = selectCandidates(catalog, prompt);
  assert(candidates.kick[0].id === kickId, "punchy tag ranks the matching kick first");
  assert(candidates.vox[0].treatment === "whisper", "a haunting prompt prefers whisper");
  assert(candidates.kick.length <= 6 && candidates.vox.length <= 8, "candidate caps hold");
  const grammar = composeGrammar(candidates);
  assert(grammar.includes(`"${kickId}"`) && !grammar.includes('"999"'), "grammar only offers listed kick ids");
  assert(grammar.includes("place"), "grammar allows a vocal placement when vocals exist");
  const packed = composeMessages(prompt, candidates);
  console.log(`digest fixture ${packed.digestChars} chars ~${packed.digestTokens} tokens`);

  const bad = {
    title: "Broken",
    bpm: 90,
    channels: {
      kick: { sample: 999, mode: "pattern", pattern: "................", preset: "nope" },
      snare: { sample: snareId, mode: "pattern", pattern: "....X.......x...", preset: "tight" },
      hat: { sample: 7, mode: "pattern", pattern: "X.x.o.X.x.x.x.x.", preset: "tight" },
      openhat: { sample: 8, mode: "pattern", pattern: "......x.........", preset: "tight" },
      clap: { sample: 9, mode: "pattern", pattern: "....x.......x...", preset: "tight" },
      perc: { sample: 10, mode: "pattern", pattern: "..x........x....", preset: "tight" },
      crash: { sample: 11, mode: "pattern", pattern: "x.......x.......", preset: "tight" },
      bass: { sample: 13, mode: "euclid", pattern: "................", euclid: { length: 8, hits: 3, shift: 0, stepRate: "1/8" }, preset: "long" },
    },
    vox: [
      { sample: 999, row: 0, note: "C-4", volume: 90 },
      { sample: 40, row: 0, note: "C-4", volume: 40 },
      { sample: 41, row: 15, note: "D-4", volume: 32 },
    ],
  };
  const plan = repairPlan(bad, prompt, candidates);
  assert(plan.channels.kick.sample === kickId, "illegal kick id clamps to a candidate");
  assert(plan.channels.kick.pattern.includes("x"), "empty kick falls back to the template");
  assert(plan.repaired.includes("kick:template") && plan.repaired.includes("kick:sample"), "repair records the kick substitutions");
  assert(!plan.channels.crash.pattern.slice(1).includes("x") && !plan.channels.crash.pattern.slice(1).includes("X"), "only the first crash hit remains");
  assert(plan.channels.bass.mode === "euclid" && plan.channels.bass.euclid.hits === 3, "euclid settings survive repair");
  assert(plan.vox.length === 2 && plan.vox[0].row === 0 && plan.vox[1].row === 15, "duplicate vocal row is dropped");
  assert(plan.vox[0].volume === 64, "vocal volume clamps to 64");
  const song = expandSong(bad, prompt, catalog);
  assert(song.channels === 10 && song.voxChannels === 2, "expanded song has two vocal columns");
  assert(songHasKickAndSnare(song), "repaired song has a kick and a snare");
  assert(song.patterns[0].data[8][0].sample === plan.vox[0].sample, "even vocal row lands on the first vocal column");
  assert(song.patterns[0].data[9][15].note === "D-4", "odd vocal row lands on the second vocal column");
  assert(song.patterns[0].data[7].some((cell) => cell.note && cell.note !== "C-1"), "bass note follows the sample pitch");
  const hatVolumes = song.patterns[0].data[2].filter((cell) => cell.volume).map((cell) => cell.volume);
  assert(new Set(hatVolumes).size > 1, "hat hits are not all the same volume");

  const fallback = expandSong(null, "dusty boom bap", catalog);
  assert(songHasKickAndSnare(fallback) && fallback.voxChannels === 2, "template compose is playable with vocal columns");
  assert(fallback.tracks.kick === "x...x...x..x.x..", "boom bap kick string survives");

  const old = {
    version: 2,
    kit: { kick: kickId },
    patterns: [{ rows: 16, data: Array.from({ length: 8 }, () => Array.from({ length: 16 }, () => ({ note: null, sample: 0, volume: 0 }))) }],
  };
  old.patterns[0].data[0][0] = { note: "C-4", sample: kickId, volume: 64 };
  migrateSong(old, catalog);
  assert(old.version === SONG_VERSION && old.patterns[0].data[0][0].sample === kickId, "version 2 migrates without rewriting cell.sample");
  assert(!old.voxChannels, "an old song does not grow vocal columns during migrate");

  const kitIndex = path.join(ROOT, "public", "samples", "index.json");
  if (fs.existsSync(kitIndex)) {
    const live = buildCatalog(path.join(ROOT, "public", "samples"), { persistIds: false });
    const livePacked = composeMessages("dusty boom bap hip hop at 90bpm, punchy kick, snappy snare", selectCandidates(live, "dusty boom bap hip hop at 90bpm, punchy kick, snappy snare"));
    console.log(`digest kit ${livePacked.digestChars} chars ~${livePacked.digestTokens} tokens across ${live.samples.length} samples`);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`${failed} failed`);
  process.exit(1);
}
console.log("library ok");
