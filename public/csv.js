import { db, col, doc, writeBatch } from './db.js';
import { todayISO } from './utils.js';

const toInt = s => parseInt(String(s ?? '').split(',')[0].replace(/[^\d]/g, ''), 10) || 0; // "Rp 25.000" -> 25000

// menerima "2026-10-25", "25/10/2026", atau "25-10-2026"
function toISO(s) {
  const v = String(s).trim().split(/[ T]/)[0];
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  const p = v.split(/[/.\-]/);
  if (p.length !== 3 || p.some(x => !/^\d+$/.test(x))) return '';
  let [d, m, y] = p;
  if (y.length === 2) y = '20' + y;
  if (+m > 12 || +d > 31) return '';
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// Header CSV: Tanggal, Item, Kategori, Nominal, Tipe, Status, Keterangan, Metode Pembayaran
// (huruf besar/kecil tidak berpengaruh; kolom Status dipakai untuk menandai "Belum Lunas")
export function parseCsv(file) {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      transformHeader: h => h.trim().toLowerCase(),
      error: reject,
      complete: ({ data }) => {
        const rows = [];
        let bad = 0;
        for (const r of data) {
          const date = toISO(r['tanggal'] || '');
          const amount = Math.abs(toInt(r['nominal']));
          if (!date || !amount) { bad++; continue; }

          const type = (r['tipe'] || '').toLowerCase().includes('masuk') ? 'income' : 'expense';
          const category = (r['kategori'] || 'Lainnya').trim();
          const item = (r['item'] || category).trim();

          // Transfer antar dompet: tampil di riwayat, tapi tidak dihitung sebagai pemasukan/pengeluaran
          const isTransfer = /transfer/i.test(category);

          // Status "Belum Lunas" disimpan sebagai catatan
          const unpaid = (r['status'] || '').toLowerCase().includes('belum');

          // Metode kosong atau "-" dianggap Cash
          let method = (r['metode pembayaran'] || '').trim();
          if (!method || method === '-') method = 'Cash';

          const note = [(r['keterangan'] || '').trim(), unpaid ? 'Belum lunas' : '']
            .filter(Boolean)
            .join(' | ');

          rows.push({
            date, item, category, amount, type, method, note, isTransfer,
            // pemasukan yang mengandung kata "gaji" dianggap awal periode (transfer tidak ikut)
            isSalary: type === 'income' && !isTransfer && /gaji/i.test(`${category} ${item}`),
          });
        }
        resolve({ rows, bad });
      },
    });
  });
}

const keyOf = (date, item, amount, type) => `${date}|${item.toLowerCase()}|${amount}|${type}`;

// hash kecil untuk membuat ID yang selalu sama dari isi yang sama
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const timeout = (ms, msg) => new Promise((_, rej) => setTimeout(() => rej(new Error(msg)), ms));

export async function commitImport(rows, cats, methods, existingTxs, onProgress = () => {}) {
  const catMap = new Map(cats.map(c => [`${c.type}:${c.name.toLowerCase()}`, c.id]));
  const methodMap = new Map(methods.map(m => [m.name.toLowerCase(), m.id]));

  // berapa kali tiap baris sudah ada di database
  const have = new Map();
  for (const t of existingTxs) {
    const k = keyOf(t.date, t.item, t.amount, t.type);
    have.set(k, (have.get(k) || 0) + 1);
  }
  const seen = new Map();
  const ids = new Set(existingTxs.map(t => t.id));
  const ops = [];

  const catId = (name, type) => {
    const k = `${type}:${name.toLowerCase()}`;
    let id = catMap.get(k);
    if (!id) {
      id = `c-${type}-${hash(name.toLowerCase())}`;
      catMap.set(k, id);
      ops.push([doc(col('categories'), id), { name, type }]);
    }
    return id;
  };
  const methodId = name => {
    const k = name.toLowerCase();
    let id = methodMap.get(k);
    if (!id) {
      id = `m-${hash(k)}`;
      methodMap.set(k, id);
      ops.push([doc(col('methods'), id), { name }]);
    }
    return id;
  };

  let added = 0, skipped = 0;
  const base = Date.now();
  rows.forEach((r, i) => {
    const k = keyOf(r.date, r.item, r.amount, r.type);
    const n = (seen.get(k) || 0) + 1; // baris kembar ke-n di file ini
    seen.set(k, n);
    // lewati hanya jika database sudah punya sebanyak itu; baris kembar yang sah tetap masuk
    const id = `i-${hash(k)}-${n}`;
    if ((have.get(k) || 0) >= n || ids.has(id)) { skipped++; return; }

    ops.push([doc(col('transactions'), id), {
      date: r.date,
      item: r.item,
      amount: r.amount,
      type: r.type,
      note: r.note,
      categoryId: catId(r.category, r.type),
      methodId: methodId(r.method),
      isSalary: r.isSalary,
      isTransfer: !!r.isTransfer,
      createdAt: base + i,
    }]);
    added++;
  });

  // batch kecil + batas waktu, supaya tidak menggantung selamanya
  const SIZE = 200;
  for (let i = 0; i < ops.length; i += SIZE) {
    const batch = writeBatch(db);
    ops.slice(i, i + SIZE).forEach(([ref, data]) => batch.create(ref, data));
    await Promise.race([
      batch.commit(),
      timeout(30000, 'Server tidak merespons. Data tersimpan sementara di perangkat ini dan akan terkirim otomatis saat koneksi pulih.'),
    ]);
    onProgress(Math.min(i + SIZE, ops.length), ops.length);
  }
  return { added, skipped };
}

export function exportCsv(txs, cats, methods) {
  const cn = new Map(cats.map(c => [c.id, c.name]));
  const mn = new Map(methods.map(m => [m.id, m.name]));
  const rows = [...txs]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map(t => ({
      Tanggal: t.date,
      Item: t.item,
      Kategori: cn.get(t.categoryId) || '',
      Nominal: t.amount,
      Tipe: t.type === 'income' ? 'Pemasukan' : 'Pengeluaran',
      Status: /belum lunas/i.test(t.note || '') ? 'Belum Lunas' : 'Lunas',
      Keterangan: t.note || '',
      'Metode Pembayaran': mn.get(t.methodId) || '',
    }));
  const blob = new Blob(['\ufeff' + Papa.unparse(rows)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `keuangan-${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}