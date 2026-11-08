/**
 * User-loaded samples. Pure module: no DOM, no Web Audio.
 *
 * Mirrors the LOAD / CLEAR buttons of gcd8.sampler~ (glima31/gcd8-pd,
 * GPL-3.0). A loaded file is stored inside the project JSON as base64, so
 * SAVE / LOAD carries it, and joins the sample catalog under a numeric id at
 * or above USER_SAMPLE_BASE. The kit WAVs keep their ids, so cell.sample
 * stays a number and resolveCatalogSample works unchanged.
 *
 *   song.userSamples[] = { id, name, mime, data?, file?, role, fallback }
 *     data      base64, only when the server did not accept the upload
 *     file      path under public/samples, when the server stored the file
 *     role      the drum role of the channel it was loaded for
 *     fallback  the kit sample the channel used before the load (0 for none).
 *               CLEAR puts it back.
 */

export const USER_SAMPLE_BASE = 1000;
export const MAX_USER_SAMPLE_BYTES = 8 * 1024 * 1024;

export function isUserSampleId(id) {
  const n = Number(id);
  return Number.isInteger(n) && n >= USER_SAMPLE_BASE;
}

export function userSampleUrl(entry) {
  return `data:${entry.mime || "audio/wav"};base64,${entry.data}`;
}

export function userSampleName(fileName) {
  const base = String(fileName || "sample").replace(/\.[^.]+$/, "").replace(/[^\w .()+-]+/g, "_").trim();
  return (base || "sample").slice(0, 40);
}

export function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** Keep only well-formed entries with unique ids. */
export function normalizeUserSamples(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const id = Number(item?.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    const file = typeof item.file === "string" ? item.file.replaceAll("\\", "/") : "";
    const safeFile = file && !file.includes("..") && !file.startsWith("/") ? file : "";
    const data = typeof item.data === "string" && item.data ? item.data : "";
    if (!isUserSampleId(id) && !safeFile) continue;
    if (!data && !safeFile) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const entry = {
      id,
      name: userSampleName(item.name),
      mime: typeof item.mime === "string" && item.mime.startsWith("audio/") ? item.mime : "audio/wav",
      role: typeof item.role === "string" ? item.role : "other",
      fallback: Number.isFinite(Number(item.fallback)) ? Math.max(0, Number(item.fallback)) : 0,
    };
    if (data) entry.data = data;
    if (safeFile) entry.file = safeFile;
    out.push(entry);
  }
  return out;
}

export function nextUserSampleId(catalog, userSamples) {
  let max = USER_SAMPLE_BASE - 1;
  for (const s of catalog || []) if (isUserSampleId(s?.id)) max = Math.max(max, Number(s.id));
  for (const s of userSamples || []) if (isUserSampleId(s?.id)) max = Math.max(max, Number(s.id));
  return max + 1;
}

/** Catalog row for a stored entry. A file reference points at the server. */
export function catalogEntryFor(entry) {
  const file = entry.file || null;
  return {
    id: entry.id,
    name: entry.name,
    role: entry.role,
    file,
    user: true,
    persist: Boolean(entry.data),
    url: entry.data
      ? userSampleUrl(entry)
      : `/samples/${String(file).split("/").map(encodeURIComponent).join("/")}`,
  };
}

/**
 * Kit rows stay. Embedded or file-only user rows are added when the kit
 * does not already list that id or file.
 */
export function mergeUserSamples(catalog, userSamples) {
  const kit = (catalog || []).filter((s) => !s?.user);
  const ids = new Set(kit.map((sample) => Number(sample.id)));
  const files = new Set(kit.map((sample) => sample.file).filter(Boolean));
  const extra = normalizeUserSamples(userSamples).filter((entry) => {
    if (ids.has(entry.id)) return false;
    if (entry.file && files.has(entry.file)) return false;
    return true;
  });
  return [...kit, ...extra.map(catalogEntryFor)];
}

/** Count the cells in a song that point at a sample id. */
export function countSampleRefs(song, id) {
  let n = 0;
  for (const pat of song?.patterns || []) {
    for (const column of pat?.data || []) {
      for (const cell of column || []) if (Number(cell?.sample) === Number(id)) n += 1;
    }
  }
  return n;
}
