// Conversion archive. This browser only, until there are accounts.
// Stores task ids, never model URLs: Meshy URLs are signed and expire.
const KEY = 'drawing3d.archive.v2';
const ACTIVE = 'drawing3d.active.v1';
const LIMIT = 24;

function read(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
}

export function list() { return read(KEY, []); }

export function upsert(entry) {
  const items = list();
  const i = items.findIndex((x) => x.id === entry.id);
  const merged = i >= 0 ? { ...items[i], ...entry } : entry;
  const next = [merged, ...items.filter((x) => x.id !== entry.id)].slice(0, LIMIT);
  if (!write(KEY, next)) {
    // Storage full: drop thumbnails of the oldest half and try again.
    next.forEach((x, k) => { if (k > LIMIT / 2) delete x.thumb; });
    write(KEY, next);
  }
  return merged;
}

export function remove(id) { write(KEY, list().filter((x) => x.id !== id)); }
export function clearAll() { write(KEY, []); }
export function get(id) { return list().find((x) => x.id === id) || null; }

export function setActive(id) { if (id) write(ACTIVE, id); else { try { localStorage.removeItem(ACTIVE); } catch { /* ignore */ } } }
export function getActive() { return read(ACTIVE, null); }
