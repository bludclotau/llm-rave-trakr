/**
 * Load word-factory vocals for the rave deck.
 * Uses the factory's Python and Postgres. No new Node dependency.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lyricRecords } from "../public/audio/lyric-bank.js";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function parseEnvFile(text) {
  const out = {};
  for (const line of String(text || "").split(/\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const body = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Absolute file under root, or null. A sibling prefix does not match. */
export function audioInside(root, filePath) {
  if (typeof root !== "string" || typeof filePath !== "string") return null;
  if (!root || !filePath || filePath.includes("\0") || root.includes("\0")) return null;
  const base = path.resolve(root);
  const file = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(base, filePath);
  const prefix = base.endsWith(path.sep) ? base : base + path.sep;
  if (!file.startsWith(prefix)) return null;
  return file;
}

export function splitLyricRows(rows, audioRoot, exists = () => true) {
  const safe = [];
  const files = new Map();
  for (const row of rows || []) {
    const file = audioInside(audioRoot, row?.file);
    if (!file || !exists(file)) continue;
    safe.push(row);
    files.set(Number(row.id), file);
  }
  return { records: lyricRecords(safe), files };
}

function runPython(python, script, cwd, env, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(python, [script], {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const out = [];
    const err = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("lyric query timed out"));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => {
      if (err.length < 8) err.push(chunk);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error("lyric query failed"));
        return;
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

export async function loadLyricBank(options = {}) {
  const home = options.home || process.env.WORDFATORY_HOME || "/home/snerloc/vibe-hub/cyberrave-wordfactory";
  const python = options.python || process.env.WORDFATORY_PYTHON || path.join(home, ".venv", "bin", "python");
  const script = options.script || path.join(ROOT, "scripts", "query-lyrics.py");
  const envFile = options.envFile || path.join(home, ".env");
  const audioRoot = options.audioRoot
    || process.env.LYRIC_AUDIO_ROOT
    || "/home/snerloc/wordfactory-audio/samples";
  if (!fs.existsSync(python) || !fs.existsSync(script)) {
    return { ok: false, records: [], files: new Map(), error: "word factory python is not installed" };
  }
  let extra = {};
  if (fs.existsSync(envFile)) {
    try {
      extra = parseEnvFile(fs.readFileSync(envFile, "utf8"));
    } catch {
      extra = {};
    }
  }
  const src = path.join(home, "src");
  const env = {
    ...process.env,
    ...extra,
    PYTHONPATH: [src, process.env.PYTHONPATH].filter(Boolean).join(path.delimiter),
    PYTHONNOUSERSITE: "1",
  };
  const root = options.audioRoot || extra.WF_REGISTER_PATH_PREFIX || audioRoot;
  try {
    const raw = await runPython(python, script, home, env, options.timeoutMs || 15000);
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows)) throw new Error("lyric query failed");
    const split = splitLyricRows(rows, root, (file) => fs.existsSync(file) && fs.statSync(file).isFile());
    return { ok: true, records: split.records, files: split.files, error: null };
  } catch {
    return { ok: false, records: [], files: new Map(), error: "word factory database is unavailable" };
  }
}
