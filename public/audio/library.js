/**
 * Client sample library. One list, lookup by id, lookup by file, add, remove.
 *
 * Kit rows come from the server catalog. `user` rows are embedded audio that
 * still lives in a project. `remember` keeps those entries when COMPOSE or
 * PRESET replaces the song, because the new song does not own them.
 */

export function createLibrary() {
  let entries = [];
  const buffers = new Map();
  const remembered = new Map();

  function num(id) {
    const n = Number(id);
    return Number.isFinite(n) ? n : null;
  }

  const lib = {
    list() {
      return entries.slice();
    },
    get(id) {
      const n = num(id);
      if (n == null) return null;
      return entries.find((entry) => Number(entry.id) === n) || null;
    },
    getByFile(file) {
      if (!file) return null;
      return entries.find((entry) => entry.file === file) || null;
    },
    add(entry) {
      if (!entry || entry.id == null) return null;
      const n = num(entry.id);
      const next = { ...entry, id: n };
      const index = entries.findIndex((item) => Number(item.id) === n);
      if (index >= 0) entries[index] = { ...entries[index], ...next };
      else entries = entries.concat([next]);
      return lib.get(n);
    },
    remove(id) {
      const n = num(id);
      if (n == null) return;
      entries = entries.filter((entry) => Number(entry.id) !== n);
      buffers.delete(n);
      remembered.delete(n);
    },
    replaceAll(next) {
      const keep = new Set((next || []).map((entry) => Number(entry.id)));
      for (const id of buffers.keys()) if (!keep.has(id)) buffers.delete(id);
      entries = (next || []).map((entry) => ({ ...entry }));
    },
    /**
     * Swap the server catalog. Embedded rows the incoming list does not
     * already contain stay, so a rescan does not drop a loaded project sample.
     */
    replaceKit(samples) {
      const incoming = samples || [];
      const ids = new Set(incoming.map((entry) => Number(entry.id)));
      const kept = entries.filter((entry) => (entry.user || entry.persist) && !ids.has(Number(entry.id)));
      lib.replaceAll([...incoming, ...kept]);
    },
    setBuffer(id, buffer) {
      const n = num(id);
      if (n == null) return;
      buffers.set(n, buffer);
    },
    buffer(id) {
      return buffers.get(num(id)) || null;
    },
    dropBuffer(id) {
      buffers.delete(num(id));
    },
    remember(entry) {
      if (!entry?.data || entry.id == null) return;
      remembered.set(Number(entry.id), { ...entry });
    },
    rememberedEntries() {
      return [...remembered.values()];
    },
  };
  return lib;
}
