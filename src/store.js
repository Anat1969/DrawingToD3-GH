// Saved works (local engines): the drawing, the engine settings and a snapshot.
// IndexedDB in this browser. The sculpture is rebuilt from the drawing on open,
// so a saved work stays small and always matches the current engine.
const DB = 'drawing3d';
const STORE = 'works';

function open() {
  return new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); resolve(out && 'result' in out ? out.result : undefined); };
    t.onerror = () => { db.close(); reject(t.error); };
  });
}

export const saveWork = (work) => tx('readwrite', (s) => s.put(work));
export const getWork = (id) => tx('readonly', (s) => s.get(id));
export const deleteWork = (id) => tx('readwrite', (s) => s.delete(id));
export const listWorks = () => tx('readonly', (s) => s.getAll()).then((l) => (l || []).sort((a, b) => b.date.localeCompare(a.date)));
export const clearWorks = () => tx('readwrite', (s) => s.clear());
export const newId = () => 'w' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
