const MAX_OPS = 50;

const SCHEMAS = {
  transactions: {
    table: 'transactions', stamp: true,
    cols: {
      date: 'date', item: 'item', categoryId: 'category_id', methodId: 'method_id',
      amount: 'amount', type: 'type', note: 'note',
      isSalary: 'is_salary', isTransfer: 'is_transfer', createdAt: 'created_at',
    },
    bool: ['isSalary', 'isTransfer'],
    req: ['date', 'item', 'amount', 'type'],
  },
  categories: { table: 'categories', stamp: false, cols: { name: 'name', type: 'type' }, bool: [], req: ['name', 'type'] },
  methods: { table: 'methods', stamp: false, cols: { name: 'name' }, bool: [], req: ['name'] },
  planItems: {
    table: 'plan_items', stamp: true,
    cols: {
      periodStart: 'period_start', name: 'name', estimate: 'estimate',
      done: 'done', transactionId: 'transaction_id', order: 'sort_order',
    },
    bool: ['done'],
    req: ['periodStart', 'name'],
  },
};
const NAMES = Object.keys(SCHEMAS);
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const bad = msg => Object.assign(new Error(msg), { status: 400 });
const json = (data, status = 200) =>
  Response.json(data, { status, headers: { 'cache-control': 'no-store' } });

function encode(s, k, v) {
  if (s.bool.includes(k)) return v ? 1 : 0;
  if (v === undefined || v === null) return k === 'note' ? '' : null;
  if (typeof v !== 'string' && typeof v !== 'number') throw bad(`nilai ${k} tidak valid`);
  return v;
}

function decode(s, r) {
  const d = { id: r.id };
  for (const [k, c] of Object.entries(s.cols)) d[k] = s.bool.includes(k) ? !!r[c] : r[c];
  return d;
}

function statement(env, o) {
  if (!o || typeof o !== 'object' || !has(SCHEMAS, o.t)) throw bad('koleksi tidak dikenal');
  const s = SCHEMAS[o.t];
  if (typeof o.id !== 'string' || !o.id || o.id.length > 200) throw bad('id tidak valid');
  const data = o.data && typeof o.data === 'object' ? o.data : {};
  const now = Date.now();

  if (o.op === 'delete') return env.DB.prepare(`DELETE FROM ${s.table} WHERE id = ?`).bind(o.id);

  if (o.op === 'set' || o.op === 'create') {
    for (const k of s.req) {
      if (data[k] === undefined || data[k] === null || data[k] === '') throw bad(`${o.t}.${k} wajib diisi`);
    }
    const keys = Object.keys(s.cols);
    const names = keys.map(k => s.cols[k]);
    const vals = keys.map(k => encode(s, k, data[k]));
    if (s.stamp) { names.push('updated_at'); vals.push(now); }
    const verb = o.op === 'create' ? 'INSERT OR IGNORE' : 'INSERT OR REPLACE';
    const marks = ['?', ...names.map(() => '?')].join(', ');
    return env.DB.prepare(`${verb} INTO ${s.table} (id, ${names.join(', ')}) VALUES (${marks})`)
      .bind(o.id, ...vals);
  }

  if (o.op === 'update') {
    const keys = Object.keys(data).filter(k => has(s.cols, k));
    if (!keys.length) return null;
    const sets = keys.map(k => `${s.cols[k]} = ?`);
    const vals = keys.map(k => encode(s, k, data[k]));
    if (s.stamp) { sets.push('updated_at = ?'); vals.push(now); }
    return env.DB.prepare(`UPDATE ${s.table} SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, o.id);
  }

  throw bad('op tidak dikenal');
}

async function getData(url, env) {
  const from = url.searchParams.get('from');
  if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) throw bad('format from salah');
  const tx = from
    ? env.DB.prepare('SELECT * FROM transactions WHERE date >= ?').bind(from)
    : env.DB.prepare('SELECT * FROM transactions');
  const res = await env.DB.batch([
    tx,
    env.DB.prepare('SELECT * FROM categories'),
    env.DB.prepare('SELECT * FROM methods'),
    env.DB.prepare('SELECT * FROM plan_items'),
  ]);
  const out = {};
  NAMES.forEach((n, i) => { out[n] = res[i].results.map(r => decode(SCHEMAS[n], r)); });
  return json(out);
}

async function postBatch(request, env) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) {
    throw bad('content-type harus application/json');
  }
  const body = await request.json().catch(() => null);
  const ops = body?.ops;
  if (!Array.isArray(ops) || !ops.length || ops.length > MAX_OPS) throw bad(`ops harus 1-${MAX_OPS}`);
  const stmts = ops.map(o => statement(env, o)).filter(Boolean);
  if (stmts.length) await env.DB.batch(stmts);
  return json({ ok: true, n: stmts.length });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      if (url.pathname === '/api/data' && request.method === 'GET') return await getData(url, env);
      if (url.pathname === '/api/batch' && request.method === 'POST') return await postBatch(request, env);
      return json({ error: 'tidak ditemukan' }, 404);
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      return json({ error: e.message || 'error' }, status);
    }
  },
};
