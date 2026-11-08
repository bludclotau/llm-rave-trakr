#!/usr/bin/env node
/**
 * LLM Rave Trakr — static UI, sample catalog, llama.cpp compose proxy.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LAYER_GRAMMAR, LAYER_MAX_TOKENS, expandLayer, layerMessages } from "./public/audio/layer.js";
import { buildCatalog, libraryDigest, saveUpload, MAX_UPLOAD_BYTES } from "./public/audio/sample-catalog.js";
import {
  composeGrammar,
  composeMessages,
  expandSong,
  selectCandidates,
} from "./public/audio/compose-plan.js";
import { mergeLyricCatalog } from "./public/audio/lyric-bank.js";
import { loadLyricBank } from "./scripts/lyric-store.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, "public");
const SAMPLE_DIR = path.join(PUBLIC, "samples");
const PORT = Number(process.env.PORT || 3840);
const LLAMA_URL = process.env.LLAMA_URL || "http://10.1.1.122:8082";
const LLAMA_URL_2 = process.env.LLAMA_URL_2 || "http://10.1.1.122:8081";
const XAI_API_KEY = process.env.XAI_API_KEY || "";
const XAI_BASE_URL = process.env.XAI_BASE_URL || "https://api.x.ai/v1";
const XAI_MODEL = process.env.XAI_MODEL || "grok-4.7";
const COMPOSE_TOKENS = 1400;
const RAVE_UI = process.env.RAVE_UI === "1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wav": "audio/wav",
  ".aif": "audio/aiff",
  ".aiff": "audio/aiff",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".mp3": "audio/mpeg",
  ".webm": "audio/webm",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".md": "text/markdown; charset=utf-8",
};

let catalog = buildCatalog(SAMPLE_DIR);
let lyricRecordsAll = [];
let lyricFiles = new Map();
let lyricMeta = { ok: false, count: 0, error: RAVE_UI ? null : "lyric bank is off" };

function useCatalog(next) {
  catalog = mergeLyricCatalog(next, lyricRecordsAll);
}

async function refreshLyrics() {
  const loaded = await loadLyricBank();
  lyricRecordsAll = loaded.records;
  lyricFiles = loaded.files;
  lyricMeta = {
    ok: loaded.ok,
    count: loaded.records.length,
    error: loaded.ok ? null : loaded.error,
  };
  useCatalog(buildCatalog(SAMPLE_DIR));
  return lyricMeta;
}

function samplesPayload() {
  return {
    samples: catalog.samples,
    roles: Object.fromEntries(
      Object.entries(catalog.byRole).map(([role, list]) => [role, list.map((sample) => sample.id)]),
    ),
  };
}

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(data),
  });
  res.end(data);
}

function sendFile(res, filePath) {
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("not found");
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Content-Length": st.size,
      "Cache-Control": ext === ".wav" ? "public, max-age=86400" : "no-cache",
    });
    fs.createReadStream(filePath).pipe(res);
  });
}

function extractJson(text) {
  if (!text) return null;
  const trimmed = text.trim();
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1].trim() : trimmed;
  try {
    return JSON.parse(raw);
  } catch {
    /* fall through */
  }
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(raw.slice(start, end + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function composeSpec(prompt) {
  const candidates = selectCandidates(catalog, prompt);
  const packed = composeMessages(prompt, candidates);
  return {
    grammar: composeGrammar(candidates),
    messages: packed.messages,
    maxTokens: COMPOSE_TOKENS,
    digestChars: packed.digestChars,
    digestTokens: packed.digestTokens,
  };
}

async function llamaModels(base) {
  const r = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`models ${r.status}`);
  return r.json();
}

async function chatComplete(base, body) {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`chat ${r.status}: ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function composeWithLlama(nodeUrl, prompt, spec = null) {
  let model = "dolphin";
  try {
    const models = await llamaModels(nodeUrl);
    model = models?.data?.[0]?.id || models?.models?.[0]?.name || model;
  } catch {
    /* use default */
  }
  const completion = await chatComplete(nodeUrl, {
    model,
    temperature: 0.7,
    max_tokens: spec?.maxTokens ?? COMPOSE_TOKENS,
    cache_prompt: true,
    grammar: (spec?.grammar || "").trim(),
    messages: spec?.messages,
  });
  const content = completion?.choices?.[0]?.message?.content || "";
  return { content, model, provider: "llama.cpp", node: nodeUrl };
}

async function composeWithXai(prompt, spec = null) {
  if (!XAI_API_KEY) throw new Error("no XAI_API_KEY");
  const r = await fetch(`${XAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${XAI_API_KEY}`,
    },
    body: JSON.stringify({
      model: XAI_MODEL,
      temperature: 0.7,
      max_tokens: spec?.maxTokens ?? COMPOSE_TOKENS,
      messages: spec?.messages,
    }),
    signal: AbortSignal.timeout(120000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`xai ${r.status}: ${text.slice(0, 400)}`);
  const completion = JSON.parse(text);
  return {
    content: completion?.choices?.[0]?.message?.content || "",
    model: XAI_MODEL,
    provider: "spacexai",
    node: XAI_BASE_URL,
  };
}

function layerPayload(layer, llm) {
  return {
    instrument: layer.instrument,
    channelFx: layer.channelFx,
    cells: layer.cells,
    llm,
  };
}

async function handleLayer(res, parsedBody) {
  const prompt = String(parsedBody.prompt || "").trim();
  if (!prompt) return json(res, 400, { error: "prompt required" });
  const song = parsedBody.song && typeof parsedBody.song === "object" ? parsedBody.song : {};
  const ctx = {
    bpm: song.bpm ?? parsedBody.bpm,
    kick: song.kick ?? parsedBody.kick,
    bass: song.bass ?? parsedBody.bass,
  };
  const offline = Boolean(parsedBody.local || parsedBody.offline || parsedBody.node === "offline");
  if (offline) {
    const layer = expandLayer(null, prompt, ctx);
    return json(res, 200, layerPayload(layer, {
      ok: false,
      provider: "template",
      model: "local-template",
      node: null,
      raw: "",
      errors: [],
    }));
  }

  const spec = {
    grammar: LAYER_GRAMMAR,
    messages: layerMessages(prompt, ctx),
    maxTokens: LAYER_MAX_TOKENS,
  };
  const node = String(parsedBody.node || "dolphin");
  const nodeUrl = node === "qwen" ? LLAMA_URL_2 : LLAMA_URL;
  const errors = [];
  let llm = null;
  try {
    llm = await composeWithLlama(nodeUrl, prompt, spec);
  } catch (err) {
    errors.push(String(err.message || err));
    const fallbackUrl = nodeUrl === LLAMA_URL ? LLAMA_URL_2 : LLAMA_URL;
    try {
      llm = await composeWithLlama(fallbackUrl, prompt, spec);
    } catch (err2) {
      errors.push(String(err2.message || err2));
    }
  }
  if (!llm) {
    try {
      llm = await composeWithXai(prompt, spec);
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }
  const raw = llm?.content || "";
  const parsed = extractJson(raw);
  const layer = expandLayer(parsed, prompt, ctx);
  return json(res, 200, layerPayload(layer, {
    ok: Boolean(parsed) && !layer.fallback,
    provider: llm?.provider || "template",
    model: llm?.model || "local-template",
    node: llm?.node || null,
    raw: raw.slice(0, 4000),
    errors,
  }));
}

function attachLlm(song, spec, llm, parsed, errors) {
  song.llm = {
    ok: Boolean(parsed),
    provider: llm?.provider || "template",
    model: llm?.model || "local-template",
    node: llm?.node || null,
    raw: (llm?.content || "").slice(0, 4000),
    errors,
    digestChars: spec?.digestChars || 0,
    digestTokens: spec?.digestTokens || 0,
    repaired: song.plan?.repaired || [],
  };
  delete song.plan;
  return song;
}

async function handleCompose(req, res, url, forceLayer = false) {
  const body = await readBody(req, 1_000_000);
  let parsedBody = {};
  try {
    parsedBody = body ? JSON.parse(body) : {};
  } catch {
    return json(res, 400, { error: "invalid json" });
  }
  if (forceLayer) parsedBody.mode = "layer";
  if (parsedBody.mode === "layer") return handleLayer(res, parsedBody);
  const prompt = String(parsedBody.prompt || "").trim();
  if (!prompt) return json(res, 400, { error: "prompt required" });
  const spec = composeSpec(prompt);
  if (parsedBody.local) {
    const song = expandSong(null, prompt, catalog);
    return json(res, 200, attachLlm(song, spec, { provider: "template", model: "local-template" }, {}, []));
  }
  const node = String(parsedBody.node || "dolphin");
  const nodeUrl = node === "qwen" ? LLAMA_URL_2 : LLAMA_URL;
  const errors = [];
  let llm = null;
  try {
    llm = await composeWithLlama(nodeUrl, prompt, spec);
  } catch (err) {
    errors.push(String(err.message || err));
    const fallbackUrl = nodeUrl === LLAMA_URL ? LLAMA_URL_2 : LLAMA_URL;
    try {
      llm = await composeWithLlama(fallbackUrl, prompt, spec);
    } catch (err2) {
      errors.push(String(err2.message || err2));
    }
  }
  if (!llm) {
    try {
      llm = await composeWithXai(prompt, spec);
    } catch (err) {
      errors.push(String(err.message || err));
    }
  }
  const raw = llm?.content || "";
  const parsed = extractJson(raw);
  const song = expandSong(parsed || null, prompt, catalog);
  json(res, 200, attachLlm(song, spec, llm, parsed, errors));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let n = 0;
    req.on("data", (chunk) => {
      n += chunk.length;
      if (n > limit) {
        const err = new Error("body too large");
        err.status = 413;
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleUpload(req, res) {
  try {
    const bytes = await readBody(req, MAX_UPLOAD_BYTES);
    const saved = saveUpload(SAMPLE_DIR, {
      filename: req.headers["x-filename"] || "sample.wav",
      mime: req.headers["content-type"] || "",
      bytes,
    });
    useCatalog(saved.catalog);
    if (!saved.sample) return json(res, 500, { error: "upload was not catalogued" });
    return json(res, 200, { sample: saved.sample });
  } catch (err) {
    return json(res, err.status || 400, { error: String(err.message || err) });
  }
}

async function handleHealth(_req, res) {
  const ping = async (url, name) => {
    const t0 = Date.now();
    try {
      const models = await llamaModels(url);
      return {
        name,
        url,
        ok: true,
        ms: Date.now() - t0,
        model: models?.data?.[0]?.id || models?.models?.[0]?.name || null,
      };
    } catch (err) {
      return { name, url, ok: false, ms: Date.now() - t0, error: String(err.message || err) };
    }
  };
  const nodes = await Promise.all([
    ping(LLAMA_URL, "dolphin"),
    ping(LLAMA_URL_2, "qwen"),
  ]);
  json(res, 200, {
    ok: nodes.some((node) => node.ok),
    samples: catalog.samples.length,
    lyrics: lyricMeta.count,
    nodes,
    spacexai: Boolean(XAI_API_KEY),
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "GET" && url.pathname === "/api/health") return handleHealth(req, res);
    if (req.method === "GET" && url.pathname === "/api/samples") return json(res, 200, samplesPayload());
    if (req.method === "GET" && url.pathname === "/api/library") return json(res, 200, libraryDigest(catalog));
    if (req.method === "POST" && url.pathname === "/api/samples/rescan") {
      useCatalog(buildCatalog(SAMPLE_DIR));
      return json(res, 200, samplesPayload());
    }
    if (req.method === "GET" && url.pathname === "/api/lyrics") {
      return json(res, 200, { ...lyricMeta, records: lyricRecordsAll });
    }
    if (req.method === "POST" && url.pathname === "/api/lyrics/refresh") {
      const meta = await refreshLyrics();
      return json(res, meta.ok ? 200 : 503, { ...meta, records: lyricRecordsAll });
    }
    const lyricAudio = url.pathname.match(/^\/api\/lyrics\/(\d+)\/audio$/);
    if (req.method === "GET" && lyricAudio) {
      const file = lyricFiles.get(Number(lyricAudio[1]));
      if (!file) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      return sendFile(res, file);
    }
    if (req.method === "POST" && url.pathname === "/api/samples/upload") return handleUpload(req, res);
    if (req.method === "GET" && url.pathname === "/api/templates") {
      return json(res, 200, { templates: ["boom-bap", "house", "trap", "dnb", "breakbeat", "lofi", "techno"] });
    }
    if (req.method === "POST" && url.pathname === "/api/compose") return handleCompose(req, res, url);
    if (req.method === "POST" && url.pathname === "/api/compose-layer") return handleCompose(req, res, url, true);
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const home = RAVE_UI ? "rave/index.html" : "index.html";
      return sendFile(res, path.join(PUBLIC, home));
    }
    if (req.method === "GET" && RAVE_UI && url.pathname === "/classic") {
      return sendFile(res, path.join(PUBLIC, "index.html"));
    }

    const rel = decodeURIComponent(url.pathname);
    if (rel.includes("..")) {
      res.writeHead(400);
      return res.end("bad path");
    }
    const filePath = path.join(PUBLIC, rel);
    if (!filePath.startsWith(PUBLIC)) {
      res.writeHead(400);
      return res.end("bad path");
    }
    return sendFile(res, filePath);
  } catch (err) {
    json(res, err.status || 500, { error: String(err.message || err) });
  }
});

function listen() {
  server.listen(PORT, "0.0.0.0", () => {
    const mode = RAVE_UI ? " rave" : "";
    console.log(`llm-rave-trakr http://127.0.0.1:${PORT}${mode}`);
    console.log(`samples ${catalog.samples.length}  lyrics ${lyricMeta.count}  llama ${LLAMA_URL}`);
  });
}

if (RAVE_UI) refreshLyrics().finally(listen);
else listen();
