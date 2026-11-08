/**
 * GCD-8 sampler strip, including LOAD / CLEAR / STOP.
 * Drum columns and vocal columns share it. An FM layer does not.
 */

export const SAMPLER_FIELDS = [
  ["sam-level", "level"],
  ["sam-start", "start"],
  ["sam-end", "end"],
  ["sam-hold", "envShape"],
  ["sam-amp", "velAmp"],
  ["sam-tone", "velTone"],
  ["sam-vstart", "velStart"],
  ["sam-attack", "velAttack"],
  ["sam-decay", "velDecay"],
];

export function createSamplerPanel(api) {
  function paint() {
    const { $, state } = api;
    const label = $("sam-channel");
    if (!label || !state.song) return;
    const ch = state.ch;
    const sampleCh = api.isSampleColumn(state.song, ch);
    label.textContent = sampleCh ? `CH${ch + 1}` : "LAYER";
    const response = sampleCh ? api.channelSampler(state.song, ch) : api.normalizeSampleResponse(null);
    state.samSync = true;
    for (const [id, key] of SAMPLER_FIELDS) {
      const el = $(id);
      if (!el) continue;
      el.value = String(response[key]);
      el.disabled = !sampleCh;
    }
    const user = sampleCh ? api.channelUserSample(ch) : null;
    const nameEl = $("sam-name");
    if (nameEl) nameEl.textContent = user ? `${user.name} · #${user.id}` : "";
    for (const id of ["sam-load", "sam-stop"]) {
      const el = $(id);
      if (el) el.disabled = !sampleCh;
    }
    const clearBtn = $("sam-clear");
    if (clearBtn) clearBtn.disabled = !sampleCh || !user;
    const hint = $("sam-hint");
    if (hint) {
      if (!sampleCh) hint.textContent = "sample response is per sample channel";
      else if (api.channelFmId(ch)) hint.textContent = "stored for this channel · playback is FM";
      else if (api.isVoxChannel(state.song, ch)) hint.textContent = "vocal one-shot · C-4 is the recorded pitch";
      else hint.textContent = "GCD-8 velocity response";
    }
    state.samSync = false;
  }

  function write(key, value) {
    const { state } = api;
    if (!state.song || !api.isSampleColumn(state.song, state.ch)) return;
    const ch = state.ch;
    state.song.channelSampler ||= {};
    const next = api.normalizeSampleResponse({ ...api.channelSampler(state.song, ch), [key]: Number(value) });
    state.song.channelSampler[ch] = next;
    if (state.voices?.[ch]) state.voices[ch].response = next;
  }

  async function loadFile(file) {
    const { $, state, library } = api;
    const ch = state.ch;
    if (!state.song || !file || !api.isSampleColumn(state.song, ch)) return;
    if (file.size > api.MAX_USER_SAMPLE_BYTES) {
      api.status(`${file.name} is over ${api.MAX_USER_SAMPLE_BYTES / 1048576} MB`, "err");
      return;
    }
    try {
      const ctx = await api.ensureAudio();
      const bytes = await file.arrayBuffer();
      const audio = await ctx.decodeAudioData(bytes.slice(0));
      const song = state.song;
      const role = api.roleForChannel(song, ch) || "other";
      const column = song.patterns[0].data[ch];
      const prior = column.find((cell) => cell?.sample && cell.note && cell.note !== api.NOTE_OFF);
      let fallback = Number(song.kit?.[role]) || 0;
      if (prior) {
        const old = song.userSamples?.find((item) => Number(item.id) === Number(prior.sample));
        fallback = old ? Number(old.fallback) || 0 : Number(prior.sample) || fallback;
      }
      const mime = file.type && file.type.startsWith("audio/") ? file.type : "audio/wav";
      let entry = null;
      try {
        const res = await fetch("/api/samples/upload", {
          method: "POST",
          headers: { "content-type": mime, "x-filename": file.name },
          body: bytes,
        });
        if (res.ok) {
          const body = await res.json();
          if (body.sample?.id != null) {
            library.add(body.sample);
            entry = {
              id: body.sample.id,
              name: body.sample.name || api.userSampleName(file.name),
              file: body.sample.file,
              mime,
              role,
              fallback,
            };
          }
        }
      } catch {
        /* the embedded copy below still loads the hit */
      }
      if (!entry) {
        const id = api.nextUserSampleId(library.list(), song.userSamples);
        entry = {
          id,
          name: api.userSampleName(file.name),
          mime,
          data: api.arrayBufferToBase64(bytes),
          role,
          fallback,
        };
        library.remember(entry);
      }
      song.userSamples = [...(song.userSamples || []), entry];
      api.syncUserSamples(song);
      library.setBuffer(entry.id, audio);
      if (song.kit && role !== "vox") song.kit[role] = entry.id;
      let placed = 0;
      for (const cell of column) {
        if (cell?.note && cell.note !== api.NOTE_OFF) {
          cell.sample = entry.id;
          placed += 1;
        }
      }
      api.pruneUserSamples(song);
      state.selectedSample = entry.id;
      api.paintColumn(ch);
      api.highlightKit();
      paint();
      api.status(
        placed
          ? `${entry.name} loaded on CH${ch + 1} · ${placed} hit${placed === 1 ? "" : "s"} now use it`
          : `${entry.name} loaded · press a note key on CH${ch + 1}`,
        "ok",
      );
      const stored = library.get(entry.id);
      if (stored) api.preview(stored);
    } catch (err) {
      api.status(`could not load ${file.name}: ${err.message || err}`, "err");
    }
  }

  function clear() {
    const { state } = api;
    const ch = state.ch;
    const song = state.song;
    if (!song || !api.isSampleColumn(song, ch)) return;
    const role = api.roleForChannel(song, ch);
    const column = song.patterns[0].data[ch];
    const ids = new Set(column.filter((cell) => api.isLoadedSample(cell?.sample)).map((cell) => Number(cell.sample)));
    if (role && api.isLoadedSample(song.kit?.[role])) ids.add(Number(song.kit[role]));
    if (!ids.size) {
      api.status(`CH${ch + 1} has no loaded sample`);
      return;
    }
    state.voices?.[ch]?.cut(state.ctx?.currentTime ?? 0);
    for (const id of ids) {
      const entry = song.userSamples?.find((item) => Number(item.id) === id);
      const fallback = Number(entry?.fallback) || 0;
      for (const cell of column) {
        if (Number(cell?.sample) !== id) continue;
        if (fallback) cell.sample = fallback;
        else {
          cell.note = null;
          cell.sample = 0;
          cell.volume = 0;
        }
      }
      if (role && Number(song.kit?.[role]) === id) {
        if (fallback) song.kit[role] = fallback;
        else delete song.kit[role];
      }
      if (state.selectedSample === id) state.selectedSample = fallback || 1;
    }
    api.pruneUserSamples(song);
    api.paintColumn(ch);
    api.highlightKit();
    paint();
    api.status(`CH${ch + 1} back on the kit sample`, "ok");
  }

  function stop() {
    const { state } = api;
    if (!state.ctx || !state.voices || !api.isSampleColumn(state.song, state.ch)) return;
    const t = state.ctx.currentTime;
    state.voices[state.ch]?.cut(t);
    if (!state.playing) state.voices[7]?.cut(t);
  }

  function setup() {
    const { $ } = api;
    $("sam-load")?.addEventListener("click", () => $("sam-file").click());
    $("sam-file")?.addEventListener("change", () => {
      const file = $("sam-file").files?.[0];
      $("sam-file").value = "";
      if (file) loadFile(file);
    });
    $("sam-clear")?.addEventListener("click", clear);
    $("sam-stop")?.addEventListener("click", stop);
    for (const [id, key] of SAMPLER_FIELDS) {
      const el = $(id);
      if (!el) continue;
      el.addEventListener("input", () => {
        if (api.state.samSync) return;
        write(key, el.value);
      });
      el.addEventListener("change", () => el.blur());
    }
    paint();
  }

  return { paint, setup };
}
