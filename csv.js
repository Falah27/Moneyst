import { db, col, doc, writeBatch } from './firebase.js';

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

export async function commitImport(rows, cats, methods, existingTxs) {
  const catMap = new Map(cats.map(c => [`${c.type}:${c.name.toLowerCase()}`, c.id]));
  const methodMap = new Map(methods.map(m => [m.name.toLowerCase(), m.id]));
  const existing = new Set(existingTxs.map(t => keyOf(t.date, t.item, t.amount, t.type)));
  const ops = [];

  const catId = (name, type) => {
    const k = `${type}:${name.toLowerCase()}`;
    let id = catMap.get(k);
    if (!id) {
      const ref = doc(col('categories'));
      id = ref.id;
      catMap.set(k, id);
      ops.push([ref, { name, type }]);
    }
    return id;
  };
  const methodId = name => {
    const k = name.toLowerCase();
    let id = methodMap.get(k);
    if (!id) {
      const ref = doc(col('methods'));
      id = ref.id;
      methodMap.set(k, id);
      ops.push([ref, { name }]);
    }
    return id;
  };

  let added = 0, skipped = 0;
  const base = Date.now();
  rows.forEach((r, i) => {
    // baris yang sudah ada di database dilewati (aman jika import dua kali)
    if (existing.has(keyOf(r.date, r.item, r.amount, r.type))) { skipped++; return; }
    ops.push([doc(col('transactions')), {
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

  // Firestore membatasi 500 operasi per batch
  for (let i = 0; i < ops.length; i += 400) {
    const batch = writeBatch(db);
    ops.slice(i, i + 400).forEach(([ref, data]) => batch.set(ref, data));
    await batch.commit();
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
  a.download = `keuangan-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}