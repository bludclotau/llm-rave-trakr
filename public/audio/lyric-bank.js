/**
 * Vocal rows from the CyberRave word factory.
 *
 * Catalog ids sit at 100000 plus the database id so they never collide with
 * the drum kit (1…) or an uploaded sample (1000…). The browser receives
 * these records. Filesystem paths stay on the server.
 */

export const LYRIC_ID_BASE = 100000;

const WORD = /^[a-z]{2,20}$/;

export function lyricSampleId(dbId) {
  const n = Number(dbId);
  if (!Number.isInteger(n) || n <= 0) return 0;
  return LYRIC_ID_BASE + n;
}

export function lyricDbId(sampleId) {
  const n = Number(sampleId);
  if (!Number.isInteger(n) || n <= LYRIC_ID_BASE) return 0;
  return n - LYRIC_ID_BASE;
}

/** Trim toward the kit peak (0.89). A missing measurement stays at unity. */
export function gainFromDbfs(dbfs) {
  const db = Number(dbfs);
  if (!Number.isFinite(db)) return 1;
  const linear = 10 ** (db / 20);
  if (!(linear > 0)) return 1;
  return Math.min(4, Math.max(0.25, 0.89 / linear));
}

export function lyricRecords(rows) {
  const out = [];
  for (const row of rows || []) {
    const dbId = Number(row?.id);
    const id = lyricSampleId(dbId);
    const word = String(row?.word || "").toLowerCase();
    const treatment = String(row?.treatment || "").trim().toLowerCase();
    if (!id || !WORD.test(word) || !treatment) continue;
    const mood = String(row?.mood || "").trim().toLowerCase();
    const tags = [treatment];
    if (mood) tags.push(mood);
    tags.push("vox");
    const duration = Number(row?.duration);
    out.push({
      id,
      dbId,
      name: `${word} · ${treatment}`,
      file: `lyrics/${dbId}.wav`,
      url: `/api/lyrics/${dbId}/audio`,
      role: "vox",
      muteGroup: null,
      duration: Number.isFinite(duration) ? duration : null,
      gain: gainFromDbfs(row?.peakDbfs ?? row?.peak_dbfs),
      offset: 0,
      tags,
      word,
      treatment,
      mood,
      explicit: Boolean(row?.explicit),
      review: String(row?.review || "new"),
      source: "wordfactory",
    });
  }
  return out;
}

/** Rows the composer may pick. Discarded takes stay out of the digest. */
export function catalogLyrics(records) {
  return (records || []).filter((sample) => sample?.source === "wordfactory" && sample.review !== "discarded");
}

export function mergeLyricCatalog(catalog, records) {
  const kept = (catalog?.samples || []).filter((sample) => sample?.source !== "wordfactory");
  const incoming = catalogLyrics(records);
  const samples = [...kept, ...incoming].sort((a, b) => a.id - b.id);
  const byRole = {};
  for (const sample of samples) (byRole[sample.role] ||= []).push(sample);
  return { ...catalog, samples, byRole };
}

export function groupLyrics(records) {
  const groups = new Map();
  for (const sample of records || []) {
    if (sample?.source !== "wordfactory") continue;
    let group = groups.get(sample.word);
    if (!group) {
      group = {
        word: sample.word,
        mood: sample.mood || "",
        explicit: Boolean(sample.explicit),
        takes: [],
      };
      groups.set(sample.word, group);
    }
    if (sample.explicit) group.explicit = true;
    if (!group.mood && sample.mood) group.mood = sample.mood;
    group.takes.push(sample);
  }
  return [...groups.values()].sort((a, b) => a.word.localeCompare(b.word));
}

export function filterLyricGroups(groups, query = {}) {
  const q = String(query.q || "").trim().toLowerCase();
  const mood = String(query.mood || "").trim().toLowerCase();
  const treatment = String(query.treatment || "").trim().toLowerCase();
  const review = String(query.review || "all").trim().toLowerCase();
  return (groups || []).map((group) => {
    if (q && !group.word.includes(q) && !group.mood.includes(q)) return null;
    if (mood && group.mood !== mood) return null;
    const takes = group.takes.filter((sample) => {
      if (review !== "all" && sample.review !== review) return false;
      if (treatment && sample.treatment !== treatment) return false;
      return true;
    });
    if (!takes.length) return null;
    return { ...group, takes };
  }).filter(Boolean);
}
