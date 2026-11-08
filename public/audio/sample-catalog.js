/**
 * Server sample catalog. Ids stick to a file path. A new file takes the next
 * id. A removed file keeps its id reserved so a later reorder does not move
 * the others. Node only: this module reads and writes the sample directory.
 */
import fs from "node:fs";
import path from "node:path";
import { tagsFromPath } from "./wav-info.js";

export const MAX_UPLOAD_BYTES = 8 * 1024 * 1024;

const AUDIO_EXT = new Set([".wav", ".aif", ".aiff", ".flac", ".ogg", ".mp3", ".webm"]);

export const AUDIO_MIME = new Set([
  "audio/wav", "audio/wave", "audio/x-wav",
  "audio/aiff", "audio/x-aiff",
  "audio/flac", "audio/x-flac",
  "audio/ogg", "audio/mpeg", "audio/mp3",
  "audio/webm",
]);

export function roleOf(rel) {
  const n = String(rel || "").replaceAll("\\", "/").toLowerCase();
  if (n.startsWith("vox/") || n.includes("/vox/")) return "vox";
  if (n.includes("808")) return "bass";
  if (n.includes("/kicks/") || n.includes("kick")) return "kick";
  if (n.includes("/snares/") || n.includes("snare")) return "snare";
  if (n.includes("/claps/") || n.includes("clap")) return "clap";
  if (n.includes("/percs/") || n.includes("perc")) return "perc";
  if (n.includes("hats closed") || n.includes("closed hat")) return "hat";
  if (n.includes("hats open") || n.includes("open hat")) return "openhat";
  if (n.includes("crash")) return "crash";
  if (n.includes("ride")) return "ride";
  return "other";
}

export function walkAudio(dir, root = dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkAudio(abs, root, acc);
    else if (AUDIO_EXT.has(path.extname(ent.name).toLowerCase())) {
      acc.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  }
  return acc;
}

export function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function readIdMap(file) {
  const json = readJson(file);
  const files = json?.files && typeof json.files === "object" ? json.files : {};
  const out = {};
  for (const [rel, id] of Object.entries(files)) {
    const n = Number(id);
    if (rel && Number.isInteger(n) && n > 0) out[rel] = n;
  }
  return out;
}

export function assignIds(relPaths, previous) {
  const next = { ...previous };
  let max = 0;
  for (const id of Object.values(next)) max = Math.max(max, Number(id) || 0);
  const fresh = relPaths.filter((rel) => next[rel] == null).sort((a, b) => a.localeCompare(b));
  for (const rel of fresh) next[rel] = ++max;
  return next;
}

function idMapChanged(before, after, rels) {
  for (const rel of rels) if (before[rel] !== after[rel]) return true;
  return false;
}

export function writeIdMap(file, map) {
  const files = {};
  for (const rel of Object.keys(map).sort((a, b) => a.localeCompare(b))) files[rel] = map[rel];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ files }, null, 2)}\n`);
}

export function readIndex(file) {
  const json = readJson(file);
  const files = json?.files && typeof json.files === "object" ? json.files : {};
  return files;
}

function clampGain(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.min(4, Math.max(0.25, n));
}

function numOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function catalogRecord(rel, id, meta) {
  const info = meta && typeof meta === "object" ? meta : {};
  const role = typeof info.role === "string" && info.role ? info.role : roleOf(rel);
  const tags = Array.isArray(info.tags) && info.tags.length ? info.tags.slice(0, 8) : tagsFromPath(rel);
  const word = typeof info.word === "string" && info.word ? info.word : null;
  const treatment = typeof info.treatment === "string" && info.treatment ? info.treatment : null;
  const base = path.posix.basename(rel).replace(/\.[^.]+$/, "");
  const name = role === "vox" && word ? `${word} · ${treatment || "vox"}` : base;
  return {
    id,
    name,
    file: rel,
    url: `/samples/${rel.split("/").map(encodeURIComponent).join("/")}`,
    role,
    muteGroup: role === "hat" || role === "openhat" ? "hats" : null,
    duration: numOrNull(info.duration),
    peak: numOrNull(info.peak),
    rms: numOrNull(info.rms),
    gain: clampGain(info.gain),
    offset: Math.max(0, Number(info.offset) || 0),
    brightness: numOrNull(info.brightness),
    pitch: numOrNull(info.pitch),
    tags,
    word,
    treatment,
  };
}

export function buildCatalog(sampleDir, { persistIds = true } = {}) {
  const idFile = path.join(sampleDir, "ids.json");
  const previous = readIdMap(idFile);
  const index = {
    ...readIndex(path.join(sampleDir, "index.json")),
    ...readIndex(path.join(sampleDir, "vox", "index.json")),
  };
  const rels = walkAudio(sampleDir).sort((a, b) => a.localeCompare(b));
  const ids = assignIds(rels, previous);
  if (persistIds && idMapChanged(previous, ids, rels)) writeIdMap(idFile, ids);
  const samples = rels.map((rel) => catalogRecord(rel, ids[rel], index[rel]));
  samples.sort((a, b) => a.id - b.id);
  const byRole = {};
  for (const sample of samples) (byRole[sample.role] ||= []).push(sample);
  return { sampleDir, idFile, samples, byRole, ids };
}

export function libraryDigest(catalog) {
  const roles = {};
  for (const sample of catalog.samples || []) {
    (roles[sample.role] ||= []).push({
      id: sample.id,
      name: sample.name,
      tags: (sample.tags || []).slice(0, 6),
      duration: sample.duration,
      brightness: sample.brightness == null ? null : Math.round(sample.brightness),
      treatment: sample.treatment || null,
    });
  }
  return { count: (catalog.samples || []).length, roles };
}

function magicOk(bytes) {
  if (!bytes || bytes.length < 4) return false;
  const head = Buffer.from(bytes.subarray(0, 12)).toString("latin1");
  if (head.startsWith("RIFF") && bytes.length >= 12 && Buffer.from(bytes.subarray(8, 12)).toString("latin1") === "WAVE") return true;
  if (head.startsWith("FORM")) return true;
  if (head.startsWith("fLaC") || head.startsWith("OggS")) return true;
  if (head.startsWith("ID3")) return true;
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) return true;
  if (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return true;
  return false;
}

export function safeAudioName(filename, mime) {
  const base = path.basename(String(filename || "sample")).replace(/[^\w.()+-]+/g, "_").replace(/^\.+/, "");
  let name = (base || "sample").slice(0, 64);
  if (!path.extname(name)) {
    if (String(mime).includes("mpeg") || String(mime).includes("mp3")) name += ".mp3";
    else if (String(mime).includes("flac")) name += ".flac";
    else if (String(mime).includes("ogg")) name += ".ogg";
    else if (String(mime).includes("aiff")) name += ".aiff";
    else if (String(mime).includes("webm")) name += ".webm";
    else name += ".wav";
  }
  return name;
}

export function uploadError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

/**
 * Write one audio file under sampleDir/user and return the rebuilt catalog
 * plus the new record. The destination cannot leave `user/`.
 */
export function saveUpload(sampleDir, { filename, mime, bytes }) {
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (body.length <= 0) throw uploadError("empty upload", 400);
  if (body.length > MAX_UPLOAD_BYTES) throw uploadError("upload is over 8 MB", 413);
  const type = String(mime || "").toLowerCase().split(";")[0].trim();
  if (!AUDIO_MIME.has(type)) throw uploadError("audio MIME type required", 415);
  if (!magicOk(body)) throw uploadError("file is not a supported audio payload", 415);
  const userDir = path.join(sampleDir, "user");
  fs.mkdirSync(userDir, { recursive: true });
  const root = `${path.resolve(userDir)}${path.sep}`;
  let name = safeAudioName(filename, type);
  let dest = path.resolve(userDir, name);
  if (!dest.startsWith(root)) throw uploadError("bad upload path", 400);
  if (fs.existsSync(dest)) {
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    let n = 2;
    while (fs.existsSync(dest)) {
      name = `${stem}-${n}${ext}`;
      dest = path.resolve(userDir, name);
      if (!dest.startsWith(root)) throw uploadError("bad upload path", 400);
      n += 1;
    }
  }
  fs.writeFileSync(dest, body);
  const catalog = buildCatalog(sampleDir);
  const rel = `user/${name}`;
  const sample = catalog.samples.find((item) => item.file === rel) || null;
  return { catalog, sample };
}
