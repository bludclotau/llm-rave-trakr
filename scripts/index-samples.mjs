#!/usr/bin/env node
/**
 * Measure the drum kit and write public/samples/index.json.
 *
 * Plain Node. No dependencies. Vocal files under vox/ and uploads under
 * user/ are left to their own indexes.
 *
 *   node scripts/index-samples.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { roleOf, walkAudio } from "../public/audio/sample-catalog.js";
import { analyzeWav, tagsFromPath } from "../public/audio/wav-info.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function skippedRel(rel) {
  const norm = String(rel || "").replaceAll("\\", "/");
  return norm.startsWith("vox/") || norm.startsWith("user/");
}

/** One index object keyed by path relative to the sample directory. */
export function buildIndex(sampleDir) {
  const files = {};
  const skipped = [];
  for (const rel of walkAudio(sampleDir)) {
    if (skippedRel(rel)) continue;
    const abs = path.join(sampleDir, ...rel.split("/"));
    const info = analyzeWav(fs.readFileSync(abs), {
      pitch: roleOf(rel) === "bass" || roleOf(rel) === "vox",
    });
    if (!info) {
      skipped.push(rel);
      continue;
    }
    files[rel] = {
      ...info,
      role: roleOf(rel),
      tags: tagsFromPath(rel),
    };
  }
  return { files, skipped };
}

export function writeIndex(sampleDir, index = buildIndex(sampleDir)) {
  const dest = path.join(sampleDir, "index.json");
  fs.writeFileSync(dest, `${JSON.stringify({ files: index.files }, null, 2)}\n`);
  return dest;
}

function main() {
  const sampleDir = path.resolve(process.argv[2] || path.join(ROOT, "public", "samples"));
  const index = buildIndex(sampleDir);
  const dest = writeIndex(sampleDir, index);
  const n = Object.keys(index.files).length;
  console.log(`indexed ${n} files -> ${dest}`);
  if (index.skipped.length) console.log(`skipped ${index.skipped.length} unreadable files`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
