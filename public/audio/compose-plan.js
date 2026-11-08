/**
 * Compose plan: pick sample candidates, constrain the model, repair the
 * reply, and expand a playable song. Pure module. No network, no DOM.
 *
 * A missing or illegal field falls back to the genre template. The result
 * always has a kick hit and a snare hit when those roles exist in the catalog.
 */
import { DRUM_ROLES, VOX_CHANNEL_COUNT } from "./channels.js";
import { euclidRows, normalizeEuclid } from "./euclid.js";
import { normalizeChannelFx } from "./instruments.js";
import { normalizeSampleResponse } from "./sample-response.js";
import { SAMPLER_PRESETS, normalizePresetName, presetForPrompt } from "./sampler-presets.js";

export const CANDIDATE_CAP = 6;
export const VOX_CAP = 8;
export const COMPOSE_ROWS = 16;

const NOTES = ["C-", "C#", "D-", "D#", "E-", "F-", "F#", "G-", "G#", "A-", "A#", "B-"];

export const TEMPLATES = {
  "boom-bap": {
    title: "Boom Bap",
    bpm: 90,
    tracks: {
      kick: "x...x...x..x.x..",
      snare: "....x.......x...",
      hat: "x.x.x.x.x.x.x.x.",
      openhat: "......x.........",
      clap: "....x.......x...",
      perc: "..x........x....",
      crash: "x...............",
      bass: "x.....x.x.......",
    },
  },
  house: {
    title: "Four on the Floor",
    bpm: 124,
    tracks: {
      kick: "x...x...x...x...",
      snare: "....x.......x...",
      hat: "x.x.x.x.x.x.x.x.",
      openhat: "......x.......x.",
      clap: "....x.......x...",
      perc: "..x...x...x...x.",
      crash: "x...............",
      bass: "x...x...x...x...",
    },
  },
  trap: {
    title: "Trap",
    bpm: 140,
    tracks: {
      kick: "x.....x.x.......",
      snare: "....x.......x...",
      hat: "xxxxxxxxxxxxxxxx",
      openhat: "......x.........",
      clap: "....x.......x...",
      perc: "x.x.........x.x.",
      crash: "x...............",
      bass: "x.........x.....",
    },
  },
  dnb: {
    title: "DnB Break",
    bpm: 174,
    tracks: {
      kick: "x.....x.x.......",
      snare: "....x.....x.x...",
      hat: "x.x.x.x.x.x.x.x.",
      openhat: "..x.......x.....",
      clap: "........x.......",
      perc: "x.x.x...........",
      crash: "x...............",
      bass: "x..x..x.x.......",
    },
  },
  breakbeat: {
    title: "Breakbeat",
    bpm: 132,
    tracks: {
      kick: "x..x..x.....x...",
      snare: "....x..x....x...",
      hat: "x.x.x.xxx.x.x.x.",
      openhat: "..........x.....",
      clap: "....x.......x...",
      perc: ".x.x........x.x.",
      crash: "x...............",
      bass: "x...x..x.x......",
    },
  },
  lofi: {
    title: "Lofi Loop",
    bpm: 82,
    tracks: {
      kick: "x.....x....x....",
      snare: "....x.......x...",
      hat: "x.x.x.x.x.x.x.x.",
      openhat: "........x.......",
      clap: "....x...........",
      perc: "......x....x....",
      crash: "................",
      bass: "x.......x.......",
    },
  },
  techno: {
    title: "Techno",
    bpm: 132,
    tracks: {
      kick: "x...x...x...x...",
      snare: "....x.......x...",
      hat: "..x...x...x...x.",
      openhat: "............x...",
      clap: "................",
      perc: "x.x.x.x.x.x.x.x.",
      crash: "x...............",
      bass: "x...x...x...x...",
    },
  },
};

const ROLE_HINTS = {
  kick: ["kick", "punch", "boom", "dusty"],
  snare: ["snare", "snap", "rim"],
  hat: ["hat", "closed", "tick"],
  openhat: ["open", "hat"],
  clap: ["clap", "snap"],
  perc: ["perc", "tom", "shaker"],
  crash: ["crash", "ride", "cymbal"],
  bass: ["bass", "808", "sub"],
};

export function guessTemplate(prompt) {
  const text = String(prompt || "").toLowerCase();
  const order = [
    ["dnb", "drum and bass", "jungle"],
    ["trap", "hi-hat roll", "808", "phonk"],
    ["techno", "minimal", "rave"],
    ["house", "four on the floor", "disco"],
    ["breakbeat", "break", "breaks"],
    ["lofi", "lo-fi", "chill", "jazz"],
    ["boom-bap", "boom bap", "hip hop", "hip-hop", "boom"],
  ];
  for (const [key, ...alts] of order) {
    if ([key, ...alts].some((word) => text.includes(word))) return TEMPLATES[key];
  }
  return TEMPLATES["boom-bap"];
}

export function treatmentsForPrompt(prompt) {
  const text = String(prompt || "").toLowerCase();
  if (/haunt|phonk|dark|lofi|lo-fi|ambient|whisper/.test(text)) {
    return ["whisper", "bit-crush", "pitch-down", "telephone", "reverse-tail"];
  }
  if (/shout|rave|hard|aggressive/.test(text)) return ["shout", "robot", "bit-crush"];
  if (/robot|cyber|digital|glitch|phone/.test(text)) return ["robot", "bit-crush", "telephone", "pitch-down"];
  return ["whisper", "shout", "robot", "bit-crush"];
}

export function scoreSample(sample, prompt, role) {
  const text = String(prompt || "").toLowerCase();
  const words = text.split(/[^a-z0-9]+/).filter((word) => word.length > 2);
  const tags = new Set((sample?.tags || []).map((tag) => String(tag).toLowerCase()));
  const name = String(sample?.name || "").toLowerCase();
  let score = sample?.role === role ? 1 : 0;
  for (const word of words) {
    if (tags.has(word)) score += 3;
    else if (name.includes(word)) score += 1;
  }
  for (const hint of ROLE_HINTS[role] || []) {
    if (text.includes(hint) && (tags.has(hint) || name.includes(hint))) score += 2;
  }
  if (role === "vox") {
    const treatment = String(sample?.treatment || "").toLowerCase();
    if (treatmentsForPrompt(text).includes(treatment)) score += 4;
    const word = String(sample?.word || "").toLowerCase();
    if (word && words.includes(word)) score += 3;
  }
  return score;
}

function byScore(prompt, role) {
  return (a, b) => {
    const diff = scoreSample(b, prompt, role) - scoreSample(a, prompt, role);
    if (diff) return diff;
    return Number(a.id) - Number(b.id);
  };
}

export function selectCandidates(catalog, prompt) {
  const samples = Array.isArray(catalog) ? catalog : (catalog?.samples || []);
  const out = {};
  for (const role of DRUM_ROLES) {
    const pool = samples.filter((sample) => sample.role === role);
    out[role] = pool.sort(byScore(prompt, role)).slice(0, CANDIDATE_CAP);
  }
  if (!out.crash.length) {
    const rides = samples.filter((sample) => sample.role === "ride");
    out.crash = rides.sort(byScore(prompt, "crash")).slice(0, CANDIDATE_CAP);
  }
  const vox = samples.filter((sample) => sample.role === "vox");
  out.vox = vox.sort(byScore(prompt, "vox")).slice(0, VOX_CAP);
  return out;
}

function shortName(sample) {
  return String(sample?.name || "")
    .replace(/^wavbvkery\s*-\s*dreams\s*/i, "")
    .slice(0, 28);
}

export function digestText(candidates) {
  const lines = [];
  for (const role of [...DRUM_ROLES, "vox"]) {
    const list = candidates?.[role] || [];
    if (!list.length) continue;
    lines.push(`${role}:`);
    for (const sample of list) {
      const tags = (sample.tags || []).slice(0, 4).join(",");
      const dur = sample.duration == null ? "?" : Number(sample.duration).toFixed(2);
      const bright = sample.brightness == null ? "?" : Math.round(sample.brightness);
      const extra = sample.treatment ? ` ${sample.treatment}` : "";
      const word = role === "vox" && sample.word ? ` word=${sample.word}` : "";
      lines.push(`${sample.id} ${shortName(sample)}${extra}${word} [${tags}] ${dur}s b${bright}`);
    }
  }
  return lines.join("\n");
}

function gbnfQuoted(value) {
  return `"\\"${value}\\""`;
}

function idAlt(list) {
  const ids = [...new Set((list || []).map((sample) => String(Number(sample.id))).filter((id) => id !== "NaN"))];
  if (!ids.length) return `"0"`;
  return ids.map((id) => `"${id}"`).join(" | ");
}

export function composeGrammar(candidates) {
  const lines = [
    "space ::= [ \\t\\n]*",
    "hit ::= \"X\" | \"x\" | \"o\" | \".\"",
    "pat ::= \"\\\"\" hit hit hit hit hit hit hit hit hit hit hit hit hit hit hit hit \"\\\"\"",
    `preset ::= ${["tight", "soft", "long", "lofi"].map(gbnfQuoted).join(" | ")}`,
    "mode ::= \"\\\"pattern\\\"\" | \"\\\"euclid\\\"\"",
    "rate ::= \"\\\"1/16\\\"\" | \"\\\"1/8\\\"\" | \"\\\"1/4\\\"\" | \"\\\"1/2\\\"\"",
    `num ::= ${Array.from({ length: 33 }, (_, i) => `"${i}"`).join(" | ")}`,
    "root ::= \"{\" space title-k \",\" space bpm-k \",\" space channels-k \",\" space vox-k space \"}\" space",
    "title-k ::= \"\\\"title\\\"\" space \":\" space title",
    "title ::= \"\\\"\" [A-Za-z0-9 ]+ \"\\\"\"",
    "bpm-k ::= \"\\\"bpm\\\"\" space \":\" space bpm",
    "bpm ::= [6-9][0-9] | \"1\" [0-9] [0-9] | \"200\"",
    "channels-k ::= \"\\\"channels\\\"\" space \":\" space \"{\" space channel-pairs space \"}\"",
  ];
  const pairs = DRUM_ROLES.map((role) => `${role}-ch`);
  lines.push(`channel-pairs ::= ${pairs.join(" \",\" space ")}`);
  for (const role of DRUM_ROLES) {
    lines.push(`${role}-id ::= ${idAlt(candidates?.[role])}`);
    lines.push(
      `${role}-ch ::= "\\"${role}\\"" space ":" space "{" space "\\"sample\\"" space ":" space ${role}-id "," space "\\"mode\\"" space ":" space mode "," space "\\"pattern\\"" space ":" space pat "," space "\\"euclid\\"" space ":" space euclid "," space "\\"preset\\"" space ":" space preset space "}"`,
    );
  }
  lines.push(
    "euclid ::= \"{\" space \"\\\"length\\\"\" space \":\" space num \",\" space \"\\\"hits\\\"\" space \":\" space num \",\" space \"\\\"shift\\\"\" space \":\" space num \",\" space \"\\\"stepRate\\\"\" space \":\" space rate space \"}\"",
  );
  lines.push("vox-k ::= \"\\\"vox\\\"\" space \":\" space vox-list");
  if ((candidates?.vox || []).length) {
    lines.push(`vox-id ::= ${idAlt(candidates.vox)}`);
    lines.push(
      "place ::= \"{\" space \"\\\"sample\\\"\" space \":\" space vox-id \",\" space \"\\\"row\\\"\" space \":\" space num \",\" space \"\\\"note\\\"\" space \":\" space note \",\" space \"\\\"volume\\\"\" space \":\" space vol space \"}\"",
    );
    lines.push("note ::= \"\\\"\" [A-G] \"-\" [0-8] \"\\\"\" | \"\\\"\" [A-G] \"#\" [0-8] \"\\\"\"");
    lines.push("vol ::= \"64\" | [1-9] | [1-5][0-9] | \"6\" [0-3]");
    lines.push("vox-list ::= \"[\" space \"]\" | \"[\" space place (\",\" space place)* \"]\"");
  } else {
    lines.push("vox-list ::= \"[\" space \"]\"");
  }
  return `${lines.join("\n")}\n`;
}

export function composeMessages(prompt, candidates) {
  const digest = digestText(candidates);
  const example = {
    title: "Boom Bap",
    bpm: 90,
    channels: {},
    vox: [],
  };
  for (const role of DRUM_ROLES) {
    const sample = candidates?.[role]?.[0];
    example.channels[role] = {
      sample: sample?.id || 0,
      mode: "pattern",
      pattern: TEMPLATES["boom-bap"].tracks[role],
      euclid: { length: 16, hits: 4, shift: 0, stepRate: "1/16" },
      preset: "tight",
    };
  }
  const messages = [
    {
      role: "system",
      content:
        "You are a tracker composer. Reply with JSON only. " +
        "Each channel sample id must be one of the ids listed for that role. " +
        "pattern is 16 characters: X accent, x normal, o ghost, . rest. " +
        "mode euclid uses the euclid object instead of pattern. " +
        "preset is tight, soft, long, or lofi. " +
        "vox is a list of at most 8 one-shot placements, usually on a downbeat, using only listed vocal ids. " +
        "Do not write a sentence or a lyric. Vocal words come from the list only. " +
        "Keep the kick sparse. Put the snare on the backbeat. One crash hit.",
    },
    {
      role: "user",
      content: `Library:\n${digest}\n\nExample:\n${JSON.stringify(example)}\n\nCompose this 16-step loop: ${prompt}`,
    },
  ];
  const text = messages.map((message) => message.content).join("\n");
  return { messages, digestChars: text.length, digestTokens: Math.ceil(text.length / 4) };
}

export function normalizePattern(str, rows = COMPOSE_ROWS) {
  const chars = [];
  for (const c of String(str || "").replace(/\s+/g, "")) {
    if (c === "X" || c === "x" || c === "o" || c === ".") chars.push(c);
    else if (c === "1" || c === "*") chars.push("x");
    if (chars.length === rows) break;
  }
  while (chars.length < rows) chars.push(".");
  return chars.join("");
}

export function hasHit(pattern) {
  return /[Xxo]/.test(pattern || "");
}

export function keepFirstHit(pattern) {
  let seen = false;
  return [...normalizePattern(pattern)].map((char) => {
    if (char === ".") return ".";
    if (seen) return ".";
    seen = true;
    return char;
  }).join("");
}

function emptyCell() {
  return { note: null, sample: 0, volume: 0, effect: 0, param: 0 };
}

function hitChar(pattern, index) {
  return pattern[index] === "X" || pattern[index] === "x" || pattern[index] === "o";
}

export function volumeFor(char, role, row, legacy) {
  if (!hitChar(`${char}`, 0) && char !== "X" && char !== "x" && char !== "o") return 0;
  if (legacy) {
    if (role === "hat") return row % 4 === 0 ? 56 : 34;
    if (role === "perc") return row % 4 === 0 ? 64 : 46;
    return 64;
  }
  if (char === "X") return 64;
  if (char === "o") return 24;
  if (role === "hat" || role === "perc") return 48;
  return 64;
}

/** Cell note that plays a bass sample's detected pitch in octave 1. */
export function bassNoteFor(sample) {
  const hz = Number(sample?.pitch);
  if (!Number.isFinite(hz) || hz < 30 || hz > 220) return "C-1";
  const detected = Math.round(69 + 12 * Math.log2(hz / 440));
  const pc = ((detected % 12) + 12) % 12;
  const target = 24 + pc;
  const noteMidi = Math.max(12, Math.min(72, 60 + target - detected));
  const name = NOTES[((noteMidi % 12) + 12) % 12];
  const oct = Math.floor(noteMidi / 12) - 1;
  return name + oct;
}

function noteOk(note) {
  return typeof note === "string" && /^[A-G](#|-)?[0-8]$/.test(note);
}

function trackerNote(note) {
  if (!noteOk(note)) return "C-4";
  const match = note.match(/^([A-G])(#?)(-?)(\d)$/);
  if (!match) return "C-4";
  return `${match[1]}${match[2] ? "#" : "-"}${match[4]}`;
}

function clampId(id, list) {
  const n = Number(id);
  if ((list || []).some((sample) => Number(sample.id) === n)) return n;
  return list?.[0] ? Number(list[0].id) : 0;
}

function patternFromEuclid(raw) {
  const cfg = normalizeEuclid(raw);
  const rows = euclidRows(cfg, COMPOSE_ROWS);
  const pattern = rows.map((hit, index) => (hit ? (index % 4 === 0 ? "X" : "x") : ".")).join("");
  return { cfg, pattern };
}

/**
 * Turn a model object, or null, into channel patterns. Illegal ids and empty
 * kick or snare patterns are replaced. `repaired` lists what was substituted.
 */
export function repairPlan(parsed, prompt, candidates) {
  const template = guessTemplate(prompt);
  const preset = presetForPrompt(prompt);
  const repaired = [];
  const channels = {};
  const source = parsed && typeof parsed === "object" ? parsed : {};
  const grouped = source.channels && typeof source.channels === "object" ? source.channels : null;
  for (const role of DRUM_ROLES) {
    const list = candidates?.[role] || [];
    const fromNew = grouped?.[role];
    const fromOld = !grouped && source.tracks ? source.tracks[role] : null;
    let mode = fromNew?.mode === "euclid" ? "euclid" : "pattern";
    let euclid = null;
    let pattern;
    if (mode === "euclid") {
      const built = patternFromEuclid(fromNew?.euclid);
      euclid = built.cfg;
      pattern = built.pattern;
    } else if (fromNew?.pattern != null) {
      pattern = normalizePattern(fromNew.pattern);
    } else if (fromOld != null) {
      pattern = normalizePattern(fromOld);
    } else {
      pattern = template.tracks[role];
      repaired.push(`${role}:template`);
    }
    if ((role === "kick" || role === "snare") && !hasHit(pattern)) {
      pattern = template.tracks[role];
      mode = "pattern";
      euclid = null;
      repaired.push(`${role}:template`);
    }
    if (role === "crash") pattern = keepFirstHit(pattern);
    const wanted = fromNew?.sample ?? (source.kit ? list[(Number(source.kit[role]) || 1) - 1]?.id : null);
    const sample = clampId(wanted, list);
    if (list.length && Number(wanted) !== sample) repaired.push(`${role}:sample`);
    if (!list.length && hasHit(pattern)) repaired.push(`${role}:nosample`);
    channels[role] = {
      sample,
      sampleMeta: list.find((item) => Number(item.id) === sample) || null,
      mode,
      pattern,
      euclid,
      preset: normalizePresetName(fromNew?.preset, prompt) || preset,
      legacy: !fromNew && !fromOld,
    };
  }
  const vox = [];
  const seen = new Set();
  const rawVox = Array.isArray(source.vox) ? source.vox.slice(0, 8) : [];
  for (const place of rawVox) {
    const sample = clampId(place?.sample, candidates?.vox || []);
    if (!sample) continue;
    const row = Math.max(0, Math.min(COMPOSE_ROWS - 1, Math.round(Number(place?.row))));
    if (!Number.isFinite(row) || seen.has(row)) {
      repaired.push("vox:row");
      continue;
    }
    const volume = Math.max(1, Math.min(64, Math.round(Number(place?.volume) || 48)));
    seen.add(row);
    vox.push({ sample, row, note: trackerNote(place?.note), volume });
  }
  if (!rawVox.length && (candidates?.vox || []).length) {
    const fallbackRows = [0, 8, 15].filter((row) => !seen.has(row));
    const picks = candidates.vox.slice(0, 2);
    picks.forEach((sample, index) => {
      const row = fallbackRows[index];
      if (row == null) return;
      seen.add(row);
      vox.push({ sample: Number(sample.id), row, note: "C-4", volume: 40 });
    });
    if (picks.length) repaired.push("vox:template");
  }
  return {
    title: String(source.title || template.title).replace(/[^\w ]+/g, "").slice(0, 48) || template.title,
    bpm: Math.max(60, Math.min(200, Number(source.bpm) || template.bpm)),
    channels,
    vox: vox.slice(0, 8),
    repaired,
    preset,
  };
}

export function expandPlan(plan, prompt) {
  const rows = COMPOSE_ROWS;
  const kit = {};
  const tracks = {};
  const channelSampler = {};
  const channelFx = {};
  const channelEuclid = {};
  const columns = DRUM_ROLES.map((role, ch) => {
    const channel = plan.channels[role];
    kit[role] = channel.sample || 0;
    tracks[role] = channel.pattern.replace(/[Xo]/g, "x");
    const preset = SAMPLER_PRESETS[channel.preset] || SAMPLER_PRESETS[plan.preset] || SAMPLER_PRESETS.tight;
    channelSampler[ch] = normalizeSampleResponse(preset.response);
    channelFx[ch] = normalizeChannelFx(preset.fx);
    if (channel.mode === "euclid" && channel.euclid) channelEuclid[ch] = channel.euclid;
    const note = role === "bass" ? bassNoteFor(channel.sampleMeta) : "C-4";
    return [...channel.pattern].map((char, row) => {
      if (char === "." || !channel.sample) return emptyCell();
      return {
        note,
        sample: channel.sample,
        volume: volumeFor(char, role, row, channel.legacy),
        effect: 0,
        param: 0,
      };
    });
  });
  for (let i = 0; i < VOX_CHANNEL_COUNT; i++) {
    channelSampler[DRUM_ROLES.length + i] = normalizeSampleResponse(SAMPLER_PRESETS[plan.preset]?.response);
    channelFx[DRUM_ROLES.length + i] = normalizeChannelFx(SAMPLER_PRESETS.soft.fx);
    columns.push(Array.from({ length: rows }, emptyCell));
  }
  for (const place of plan.vox) {
    const column = place.row % 2 === 0 ? columns[8] : columns[9];
    const cell = column[place.row];
    if (cell?.note) {
      const other = cell === columns[8][place.row] ? columns[9] : columns[8];
      if (!other[place.row]?.note) {
        other[place.row] = { note: place.note, sample: place.sample, volume: place.volume, effect: 0, param: 0 };
      }
      continue;
    }
    column[place.row] = { note: place.note, sample: place.sample, volume: place.volume, effect: 0, param: 0 };
  }
  return {
    title: plan.title,
    bpm: plan.bpm,
    speed: 6,
    rows,
    channels: columns.length,
    voxChannels: VOX_CHANNEL_COUNT,
    order: [0],
    patterns: [{ name: plan.title, rows, data: columns }],
    kit,
    tracks,
    channelSampler,
    channelFx,
    channelEuclid,
    prompt: prompt || "",
  };
}

export function expandSong(parsed, prompt, catalog) {
  const candidates = selectCandidates(catalog, prompt);
  const plan = repairPlan(parsed, prompt, candidates);
  const song = expandPlan(plan, prompt);
  song.plan = { repaired: plan.repaired };
  return song;
}

export function songHasKickAndSnare(song) {
  const data = song?.patterns?.[0]?.data || [];
  const hit = (column) => (column || []).some((cell) => cell?.note && cell.sample);
  return hit(data[0]) && hit(data[1]);
}
