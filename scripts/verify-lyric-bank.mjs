/**
 * Lyric bank: ids, gain, catalog merge, path jail. No database and no network.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  catalogLyrics,
  filterLyricGroups,
  gainFromDbfs,
  groupLyrics,
  lyricDbId,
  lyricRecords,
  lyricSampleId,
  mergeLyricCatalog,
} from "../public/audio/lyric-bank.js";
import { audioInside, parseEnvFile, splitLyricRows } from "./lyric-store.mjs";

let failed = 0;
function assert(cond, message) {
  if (cond) {
    console.log(`ok  ${message}`);
    return;
  }
  failed += 1;
  console.error(`FAIL ${message}`);
}

const row = {
  id: 1,
  word: "alpha",
  mood: "haunting",
  treatment: "whisper",
  duration: 0.8,
  peak_dbfs: 0,
  review: "new",
  explicit: false,
};
const [take] = lyricRecords([row]);
assert(lyricSampleId(1) === 100001, "database id 1 is catalog id 100001");
assert(lyricDbId(take.id) === 1, "catalog id maps back to the database id");
assert(take.role === "vox" && take.muteGroup == null, "a vocal is not in the hat mute group");
assert(take.url === "/api/lyrics/1/audio", "audio url uses the database id");
assert(take.gain === 0.89, `0 dbfs trims to 0.89 (${take.gain})`);
assert(gainFromDbfs(-40) === 4, "a quiet take clamps at gain 4");
assert(lyricRecords([{ ...row, word: "nope!" }]).length === 0, "a word outside the factory shape is dropped");
assert(lyricRecords([{ ...row, id: 0 }]).length === 0, "id 0 is dropped");

const discarded = lyricRecords([{ ...row, id: 2, review: "discarded", treatment: "shout" }]);
assert(catalogLyrics([take, ...discarded]).length === 1, "discarded takes stay out of compose");

const kit = {
  samples: [
    { id: 1, role: "kick", source: undefined, file: "kick.wav" },
    { id: 91, role: "vox", source: undefined, file: "vox/001.wav", word: "alpha" },
  ],
};
const merged = mergeLyricCatalog(kit, [take, ...discarded]);
assert(merged.samples.some((sample) => sample.id === 1 && sample.role === "kick"), "kit id stays");
assert(merged.samples.some((sample) => sample.id === 91), "an imported vocal file stays");
assert(merged.samples.some((sample) => sample.id === 100001), "factory vocal is added");
const replaced = mergeLyricCatalog(merged, lyricRecords([{ ...row, treatment: "robot" }]));
assert(replaced.samples.filter((sample) => sample.source === "wordfactory").length === 1, "refresh replaces factory rows");
assert(replaced.samples.find((sample) => sample.id === 100001).treatment === "robot", "refresh keeps the new treatment");

const groups = groupLyrics([
  take,
  ...lyricRecords([{ ...row, id: 3, treatment: "robot", review: "kept" }]),
]);
assert(groups.length === 1 && groups[0].takes.length === 2, "one word groups its treatments");
const haunting = filterLyricGroups(groups, { mood: "haunting", treatment: "whisper", review: "new" });
assert(haunting.length === 1 && haunting[0].takes.length === 1, "mood and treatment filter one take");
assert(filterLyricGroups(groups, { q: "alpha" }).length === 1, "search matches the factory word");
assert(filterLyricGroups(groups, { review: "kept" })[0].takes[0].treatment === "robot", "review filter");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lyric-bank-"));
try {
  const wav = path.join(dir, "alpha.wav");
  fs.writeFileSync(wav, "RIFF");
  assert(audioInside(dir, wav) === path.resolve(wav), "a child wav is inside the audio root");
  assert(audioInside(dir, "alpha.wav") === path.resolve(wav), "a relative name stays under the audio root");
  assert(audioInside(dir, path.join(dir, "..", "nope.wav")) == null, "a parent path is refused");
  assert(audioInside(dir, path.join(dir + "-evil", "alpha.wav")) == null, "a sibling prefix is not the root");
  const env = parseEnvFile("# comment\nexport WF_DB_PASSWORD='secret'\nWF_DB_HOST=127.0.0.1\n");
  assert(env.WF_DB_PASSWORD === "secret" && env.WF_DB_HOST === "127.0.0.1", "env file parses a quoted value");
  const split = splitLyricRows(
    [{ ...row, file: wav }, { ...row, id: 9, file: path.join(dir, "..", "nope.wav") }],
    dir,
    (file) => file === wav,
  );
  assert(split.records.length === 1 && split.files.get(1) === path.resolve(wav), "only a real file under the root is kept");
  assert(!JSON.stringify(split.records).includes(dir), "catalog records omit the filesystem path");
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}

if (failed) {
  console.error(`verify-lyric-bank ${failed} failed`);
  process.exit(1);
}
console.log("verify-lyric-bank ok");
