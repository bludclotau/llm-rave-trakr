#!/usr/bin/env node
/**
 * Import a CyberRave word-factory export into public/samples/vox/.
 *
 * The tracker never talks to Postgres. This reads the file export:
 *
 *   wordfactory export-manifest --format json --review kept --output samples.json
 *
 * JSON is an array of rows, or an object with `rows` or `samples`. CSV uses
 * the factory header: word, treatment, file_path, duration_sec, sample_rate,
 * channels, peak_dbfs, loudness_lufs, bark_seed, review_status, created_at.
 *
 * Each file is rewritten as 16-bit mono WAV at 44100 or 48000 Hz, trimmed,
 * and peaked with the kit. The filename is `001_whisper.wav`. The spoken
 * word stays in vox/index.json and is not printed.
 *
 *   node scripts/import-vox.mjs --manifest samples.json --audio-root /path/to/wavs
 *   node scripts/import-vox.mjs --manifest samples.json --review kept --limit 20
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWav, renderNormalizedWav, tagsFromPath } from "../public/audio/wav-info.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP_RATES = new Set([44100, 48000]);

export function parseArgs(argv) {
  const out = {
    manifest: "",
    audioRoot: "",
    dest: path.join(ROOT, "public", "samples", "vox"),
    review: "kept",
    limit: 0,
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === "--manifest") out.manifest = value;
    else if (key === "--audio-root") out.audioRoot = value;
    else if (key === "--out") out.dest = path.resolve(value);
    else if (key === "--review") out.review = value;
    else if (key === "--limit") out.limit = Number(value) || 0;
    else continue;
    i += 1;
  }
  return out;
}

export function loadManifest(file) {
  const text = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    const json = JSON.parse(trimmed);
    if (Array.isArray(json)) return json;
    if (Array.isArray(json.rows)) return json.rows;
    if (Array.isArray(json.samples)) return json.samples;
    throw new Error("manifest JSON has no row list");
  }
  return parseCsv(text);
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  const pushCell = () => {
    row.push(cell);
    cell = "";
  };
  const pushRow = () => {
    if (row.length && row.some((value) => value !== "")) rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") pushCell();
    else if (ch === "\n") {
      pushCell();
      pushRow();
    } else if (ch !== "\r") cell += ch;
  }
  if (cell || row.length) {
    pushCell();
    pushRow();
  }
  if (!rows.length) return [];
  const header = rows[0].map((name) => name.trim());
  return rows.slice(1).map((values) => {
    const item = {};
    header.forEach((name, index) => {
      item[name] = values[index] ?? "";
    });
    return item;
  });
}

function slug(value) {
  const text = String(value || "vox").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return text.slice(0, 24) || "vox";
}

function nextNumber(dir) {
  let max = 0;
  if (!fs.existsSync(dir)) return 1;
  for (const name of fs.readdirSync(dir)) {
    const match = name.match(/^(\d+)_/);
    if (match) max = Math.max(max, Number(match[1]));
  }
  return max + 1;
}

export function resolveAudio(row, audioRoot) {
  const raw = String(row.file_path || row.file || row.path || "").replaceAll("\\", "/");
  if (!raw) return "";
  const candidates = [];
  if (path.isAbsolute(raw)) candidates.push(raw);
  if (audioRoot) {
    candidates.push(path.resolve(audioRoot, raw));
    candidates.push(path.resolve(audioRoot, path.basename(raw)));
  }
  candidates.push(path.resolve(raw));
  return candidates.find((item) => fs.existsSync(item)) || "";
}

function ffmpegWav(input) {
  const result = spawnSync("ffmpeg", [
    "-v", "error",
    "-i", input,
    "-ac", "1",
    "-ar", "48000",
    "-f", "wav",
    "-c:a", "pcm_s16le",
    "pipe:1",
  ], { maxBuffer: 32 * 1024 * 1024 });
  if (result.status !== 0 || !result.stdout?.length) {
    const err = result.stderr ? result.stderr.toString("utf8").slice(0, 200) : "ffmpeg failed";
    throw new Error(err.trim() || "ffmpeg failed");
  }
  return new Uint8Array(result.stdout);
}

function pcmReady(bytes) {
  const parsed = parseWav(bytes);
  if (!parsed) return null;
  const { fmt } = parsed;
  if (fmt.audioFormat !== 1 || fmt.bits !== 16 || fmt.channels !== 1) return null;
  if (!KEEP_RATES.has(fmt.sampleRate)) return null;
  return bytes;
}

export function prepareWav(file) {
  const bytes = fs.readFileSync(file);
  const direct = pcmReady(bytes) || ffmpegWav(file);
  const rendered = renderNormalizedWav(direct);
  if (!rendered?.wav || !rendered.info) throw new Error("could not normalise");
  return rendered;
}

function readVoxIndex(dir) {
  const file = path.join(dir, "index.json");
  try {
    const json = JSON.parse(fs.readFileSync(file, "utf8"));
    return json.files && typeof json.files === "object" ? json.files : {};
  } catch {
    return {};
  }
}

/**
 * Copy matching rows into `dest`. Returns counts only. Does not log words.
 */
export function importManifest({ manifest, audioRoot, dest, review = "kept", limit = 0 }) {
  const rows = loadManifest(manifest);
  fs.mkdirSync(dest, { recursive: true });
  const files = readVoxIndex(dest);
  let number = nextNumber(dest);
  let imported = 0;
  let skipped = 0;
  for (const row of rows) {
    if (limit && imported >= limit) break;
    const status = String(row.review_status || "");
    if (review && review !== "all" && status && status !== review) {
      skipped += 1;
      continue;
    }
    const word = String(row.word || "").trim();
    const treatment = String(row.treatment || "vox").trim();
    if (!word || !treatment) {
      skipped += 1;
      continue;
    }
    const source = resolveAudio(row, audioRoot);
    if (!source) {
      skipped += 1;
      continue;
    }
    let rendered;
    try {
      rendered = prepareWav(source);
    } catch {
      skipped += 1;
      continue;
    }
    const name = `${String(number).padStart(3, "0")}_${slug(treatment)}.wav`;
    number += 1;
    fs.writeFileSync(path.join(dest, name), rendered.wav);
    const tags = [...new Set(["vox", ...tagsFromPath(treatment), slug(treatment)].filter(Boolean))].slice(0, 8);
    files[`vox/${name}`] = {
      ...rendered.info,
      role: "vox",
      word,
      treatment,
      tags,
    };
    imported += 1;
  }
  fs.writeFileSync(path.join(dest, "index.json"), `${JSON.stringify({ files }, null, 2)}\n`);
  return { imported, skipped, rows: rows.length };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.manifest) {
    console.error("usage: node scripts/import-vox.mjs --manifest export.json [--audio-root dir] [--review kept] [--limit N]");
    process.exit(1);
  }
  const result = importManifest(args);
  console.log(`imported ${result.imported} skipped ${result.skipped} of ${result.rows}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
