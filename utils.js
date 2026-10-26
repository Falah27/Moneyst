const pad = n => String(n).padStart(2, '0');
const toISO = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

// pakai tanggal lokal, bukan toISOString() (di WIB sebelum jam 07.00 tanggalnya mundur sehari)
export const todayISO = () => toISO(new Date());

export function monthsAgoISO(n) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - n);
  return toISO(d);
}

export function addDaysISO(s, n) {
  const d = parseISO(s);
  d.setDate(d.getDate() + n);
  return toISO(d);
}

export const rupiah = n => (n < 0 ? '-' : '') + 'Rp ' + Math.abs(n).toLocaleString('id-ID');
export const parseNum = s => parseInt(String(s).replace(/\D/g, ''), 10) || 0;

export const fmtDate = (iso, opts = { day: 'numeric', month: 'short', year: 'numeric' }) =>
  new Intl.DateTimeFormat('id-ID', opts).format(parseISO(iso));

// ---------- Periode gajian ----------
// Periode baru dimulai di tanggal transaksi bertanda isSalary,
// dan berakhir sehari sebelum gaji berikutnya.
export function buildPeriods(txs) {
  const starts = [...new Set(txs.filter(t => t.isSalary).map(t => t.date))].sort();
  const earliest = txs.reduce((m, t) => (!m || t.date < m ? t.date : m), '');

  if (!starts.length) {
    // belum ada gaji tercatat: seluruh data dianggap satu periode
    return [{ start: earliest || todayISO().slice(0, 8) + '01', end: null }];
  }
  // transaksi sebelum gaji pertama tetap punya "periode awal"
  if (earliest && earliest < starts[0]) starts.unshift(earliest);

  return starts.map((s, i) => ({
    start: s,
    end: starts[i + 1] ? addDaysISO(starts[i + 1], -1) : null,
  }));
}

export const inPeriod = (date, p) => date >= p.start && (!p.end || date <= p.end);

export function periodLabel(p) {
  const a = fmtDate(p.start, { day: 'numeric', month: 'short' });
  const b = p.end ? fmtDate(p.end) : 'sekarang';
  return `${a} – ${b}`;
}

// periode yang aktif hari ini (abaikan gaji yang tanggalnya di masa depan)
export function defaultIndex(periods) {
  const t = todayISO();
  for (let i = periods.length - 1; i >= 0; i--) if (periods[i].start <= t) return i;
  return periods.length - 1;
}