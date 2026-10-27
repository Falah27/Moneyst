const NAMES = ['transactions', 'categories', 'methods', 'planItems', 'budgets', 'recurring'];
const CACHE_KEY = 'moneyst-cache-v1';
const OUTBOX_KEY = 'moneyst-outbox-v1';
const CHUNK = 40;
const docs = Object.fromEntries(NAMES.map(n => [n, new Map()]));
let outbox = [];
let fromCache = true;
const listeners = new Set();
function announce(detail) {
  window.dispatchEvent(new CustomEvent('moneyst:sync', { detail }));
}
export const db = {};
const clean = data => JSON.parse(JSON.stringify(data));
const newId = () => crypto.randomUUID?.() ?? Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

function applyTo(maps, op) {
  const m = maps[op.t];
  if (!m) return;
  if (op.op === 'set') m.set(op.id, { ...op.data, id: op.id });
  else if (op.op === 'create') { if (!m.has(op.id)) m.set(op.id, { ...op.data, id: op.id }); }
  else if (op.op === 'update') { const cur = m.get(op.id); if (cur) m.set(op.id, { ...cur, ...op.data }); }
  else if (op.op === 'delete') m.delete(op.id);
}
const apply = op => applyTo(docs, op);
let saveTimer = null;
function saveCache() { clearTimeout(saveTimer); saveTimer = setTimeout(saveCacheNow, 600); }
function saveCacheNow() {
  clearTimeout(saveTimer);
  try {
    const out = {};
    for (const n of NAMES) out[n] = [...docs[n].values()];
    localStorage.setItem(CACHE_KEY, JSON.stringify({ docs: out }));
  } catch (e) { console.warn('Cache tidak bisa disimpan', e); }
}
function saveOutbox() {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(outbox)); }
  catch (e) { notifyError(new Error('Penyimpanan perangkat penuh, perubahan belum aman.')); }
}
function snapshotFor(l) {
  let rows = [...docs[l.name].values()];
  if (l.from) rows = rows.filter(r => r.date >= l.from);
  return {
    docs: rows.map(r => ({ id: r.id, data: () => r })),
    empty: rows.length === 0,
    metadata: { fromCache, hasPendingWrites: outbox.length > 0 },
  };
}
function emitTo(l) { try { l.cb(snapshotFor(l)); } catch (e) { console.error('Listener', l.name, e); } }
function emitAll() { listeners.forEach(emitTo); }
let emitQueued = false;
function scheduleEmit() {
  if (emitQueued) return;
  emitQueued = true;
  queueMicrotask(() => { emitQueued = false; emitAll(); });
}
function notifyError(e) { listeners.forEach(l => { try { l.errCb?.(e); } catch {} }); }
export const col = name => ({ name });
export const where = (field, op, value) => ({ field, op, value });
export function query(source, ...cons) {
  const q = { ...source };
  for (const c of cons) {
    if (c.field === 'date' && c.op === '>=') q.from = c.value;
    else throw new Error(`where(${c.field} ${c.op}) belum didukung`);
  }
  return q;
}
export const doc = (c, id) => ({ col: c.name, id: id || newId() });
export function onSnapshot(source, a, b, c) {
  const [cb, errCb] = typeof a === 'function' ? [a, b] : [b, c];
  const l = { name: source.name, from: source.from || null, cb, errCb };
  listeners.add(l);
  setTimeout(() => listeners.has(l) && emitTo(l), 0);
  queueSync();
  return () => listeners.delete(l);
}
function write(op) {
  apply(op);
  outbox.push(op);
  saveOutbox();
  saveCache();
  scheduleEmit();
  queueSync(300);
  return Promise.resolve();
}
export const setDoc = (ref, data) => write({ t: ref.col, op: 'set', id: ref.id, data: clean(data) });
export const updateDoc = (ref, data) => write({ t: ref.col, op: 'update', id: ref.id, data: clean(data) });
export const deleteDoc = ref => write({ t: ref.col, op: 'delete', id: ref.id });
async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
    redirect: 'manual',
  });
  if (res.type === 'opaqueredirect' || res.status === 401 || res.status === 403) {
    throw Object.assign(new Error('Sesi login berakhir. Muat ulang halaman ini.'), { auth: true });
  }
  if (!res.ok) {
    let msg = 'HTTP ' + res.status;
    try { msg = (await res.json()).error || msg; } catch {}
    throw Object.assign(new Error(msg), { status: res.status });
  }
  return res.json();
}
async function send(chunk) {
  try { await api('/api/batch', { ops: chunk }); return []; }
  catch (e) {
    if (e.status !== 400) throw e;
    if (chunk.length === 1) return chunk;
    const midpoint = Math.ceil(chunk.length / 2);
    const left = await send(chunk.slice(0, midpoint));
    const right = await send(chunk.slice(midpoint));
    return [...left, ...right];
  }
}
function minFrom() {
  let from = null;
  for (const l of listeners) {
    if (l.name !== 'transactions') continue;
    if (!l.from) return null;
    if (!from || l.from < from) from = l.from;
  }
  return from;
}
let running = false, again = false, timer = null, delay = 3000, fails = 0, lastSync = 0;
function queueSync(ms = 0) { clearTimeout(timer); timer = setTimeout(sync, ms); }
async function sync() {
  if (running) { again = true; return; }
  if (!navigator.onLine) return;
  running = true;
  announce({ pending: true, outboxCount: outbox.length });
  let ok = false;
  try {
    let failed = [];
    while (outbox.length) {
      const chunk = outbox.slice(0, CHUNK);
      failed = await send(chunk);
      outbox.splice(0, chunk.length);
      if (failed.length) {
        outbox.unshift(...failed);
        saveOutbox();
        break;
      }
      saveOutbox();
    }
    const from = minFrom();
    const r = await api('/api/data' + (from ? `?from=${from}` : ''));
    for (const n of NAMES) docs[n] = new Map((r[n] || []).map(d => [d.id, d]));
    outbox.forEach(apply);
    fromCache = false; fails = 0; delay = 3000; lastSync = Date.now(); ok = true;
    announce({ ok: true, at: lastSync, pending: outbox.length > 0, outboxCount: outbox.length });
    saveCache();
    emitAll();
    if (failed.length) {
      notifyError(Object.assign(
        new Error(`${failed.length} perubahan ditolak server. Periksa data lalu coba lagi.`),
        { status: 400 },
      ));
      announce({ error: `${failed.length} perubahan ditolak server.`, pending: true, outboxCount: outbox.length });
    }
  } catch (e) {
    fails++;
    if (e.auth || e.status || fails >= 3) notifyError(e.auth || e.status ? e : new Error('Tidak bisa terhubung ke server.'));
    announce({ error: e.message, pending: outbox.length > 0, outboxCount: outbox.length });
  } finally {
    running = false;
    if (ok) { if (again) { again = false; queueSync(); } }
    else { again = false; queueSync(delay); delay = Math.min(delay * 2, 60000); }
  }
}
window.addEventListener('online', () => { delay = 3000; queueSync(); });
window.addEventListener('pagehide', saveCacheNow);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') return saveCacheNow();
  if (outbox.length || Date.now() - lastSync > 15000) queueSync();
});
export async function getDocs(source) {
  const r = await api('/api/data' + (source.from ? `?from=${source.from}` : ''));
  const m = new Map((r[source.name] || []).map(d => [d.id, d]));
  outbox.forEach(op => applyTo({ [source.name]: m }, op));
  const rows = [...m.values()];
  return { docs: rows.map(d => ({ id: d.id, data: () => d })), empty: !rows.length };
}
export function writeBatch() {
  const ops = [];
  const add = (kind, ref, data) => {
    ops.push({ t: ref.col, op: kind, id: ref.id, data: clean(data) });
    return batch;
  };
  const batch = {
    set: (ref, data) => add('set', ref, data),
    create: (ref, data) => add('create', ref, data),
    async commit() {
      for (let i = 0; i < ops.length; i += CHUNK) {
        const chunk = ops.slice(i, i + CHUNK);
        await api('/api/batch', { ops: chunk });
        chunk.forEach(apply);
      }
      saveCache(); scheduleEmit(); queueSync(500);
    },
  };
  return batch;
}
(function load() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (c?.docs) for (const n of NAMES) docs[n] = new Map((c.docs[n] || []).map(d => [d.id, d]));
  } catch (e) { console.warn('Cache rusak, diabaikan', e); }
  try { outbox = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { outbox = []; }
  outbox.forEach(apply);
})();
