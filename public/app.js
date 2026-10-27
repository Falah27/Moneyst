import { col, doc, setDoc, updateDoc, deleteDoc, query, where, onSnapshot, getDocs } from './db.js';
import {
  rupiah, parseNum, todayISO, monthsAgoISO, fmtDate, periodLabel,
  buildPeriods, inPeriod, defaultIndex, addDaysISO,
} from './utils.js';
import { parseCsv, commitImport, exportCsv } from './csv.js';

const COLORS = ['#2563eb', '#f97316', '#ec4899', '#10b981', '#8b5cf6', '#f59e0b', '#06b6d4', '#ef4444', '#64748b'];
const WALLET_COLORS = [
  ['#2563eb', '#60a5fa'], ['#7c3aed', '#c084fc'], ['#059669', '#34d399'],
  ['#db2777', '#f472b6'], ['#ea580c', '#fb923c'], ['#0891b2', '#22d3ee'],
];
const hashText = value => [...String(value || '')].reduce((n, c) => ((n * 31) + c.charCodeAt(0)) >>> 0, 7);

const DEFAULT_CATS = [
  ['exp-makan', 'Makan', 'expense'], ['exp-jajan', 'Jajan', 'expense'],
  ['exp-transport', 'Transport', 'expense'], ['exp-belanja', 'Belanja', 'expense'],
  ['exp-tagihan', 'Tagihan', 'expense'], ['exp-kesehatan', 'Kesehatan', 'expense'],
  ['exp-hiburan', 'Hiburan', 'expense'], ['exp-amal', 'Amal', 'expense'],
  ['exp-lainnya', 'Lainnya', 'expense'],
  ['inc-gaji', 'Gaji', 'income'], ['inc-hadiah', 'Hadiah', 'income'], ['inc-lainnya', 'Lainnya', 'income'],
];
const DEFAULT_METHODS = [
  ['m-cash', 'Cash'], ['m-dana', 'DANA'], ['m-shopeepay', 'Shopeepay'],
  ['m-livin', 'Livin (Mandiri)'], ['m-octo', 'Octo (CIMB)'],
];

const byName = (a, b) => a.name.localeCompare(b.name, 'id');
const blankForm = () => ({
  id: null, type: 'expense', amount: 0, item: '', categoryId: '',
  methodId: localStorage.getItem('lastMethod') || '', toMethodId: '',
  date: todayISO(), note: '', isSalary: false, planItemId: null, loaded: true,
});

let unsubs = [];
const charts = {}; // sengaja di luar Alpine agar tidak dibungkus proxy

const svg = p =>
  `<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="display:block">${p}</svg>`;
const ICONS = [
  [/makan|resto|food/i, '<path d="M3 2v7c0 1.1.9 2 2 2h4a2 2 0 0 0 2-2V2"/><path d="M7 2v20"/><path d="M21 15V2a5 5 0 0 0-5 5v6c0 1.1.9 2 2 2h3Zm0 0v7"/>'],
  [/jajan|snack|kopi|minum/i, '<path d="M10 2v2"/><path d="M14 2v2"/><path d="M6 2v2"/><path d="M16 8a1 1 0 0 1 1 1v8a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4V9a1 1 0 0 1 1-1h14a4 4 0 1 1 0 8h-1"/>'],
  [/transport|bensin|ojek|parkir/i, '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>'],
  [/belanja|shop/i, '<circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"/>'],
  [/tagihan|listrik|pulsa|internet|cicil|pdam/i, '<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8"/><path d="M12 17.5v-11"/>'],
  [/sehat|obat|medis/i, '<path d="M8 3h8v5h5v8h-5v5H8v-5H3V8h5z"/>'],
  [/hibur|game|film|nonton/i, '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18"/><path d="M3 7.5h4"/><path d="M3 12h18"/><path d="M3 16.5h4"/><path d="M17 3v18"/><path d="M17 7.5h4"/><path d="M17 16.5h4"/>'],
  [/amal|sedekah|donasi|zakat/i, '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>'],
  [/gaji|salary/i, '<path d="M16 20V4a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/><rect width="20" height="14" x="2" y="6" rx="2"/>'],
  [/hadiah|bonus|angpao/i, '<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5A4.8 8 0 0 1 12 8a4.8 8 0 0 1 4.5-5 2.5 2.5 0 0 1 0 5"/>'],
  [/hutang|utang|piutang|transfer/i, '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>'],
  [/saving|tabung|invest/i, '<path d="M22 7 13.5 15.5l-5-5L2 17"/><path d="M16 7h6v6"/>'],
  [/lain/i, '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>'],
];
const TAG_ICON = '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5" fill="currentColor"/>';
const iconOf = name => svg((ICONS.find(([re]) => re.test(name || '')) || [])[1] || TAG_ICON);
const short = n => (n >= 1e6 ? +(n / 1e6).toFixed(1) + 'jt' : n >= 1e3 ? Math.round(n / 1e3) + 'rb' : String(n));
const TARGET_SAVE = 20;
const healthOf = rate =>
  rate == null ? { t: '—', c: 'bg-slate-100 text-slate-500' }
  : rate >= TARGET_SAVE ? { t: 'Sehat', c: 'bg-emerald-100 text-emerald-700' }
  : rate >= 0 ? { t: 'Tipis', c: 'bg-amber-100 text-amber-700' }
  : { t: 'Defisit', c: 'bg-rose-100 text-rose-700' };

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }));
}

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    busy: false,
    loading: true,
    pending: false, syncErr: '', syncAt: 0, outboxCount: 0,
    online: navigator.onLine,

    // ----- data (dari Firestore) -----
    txs: [], cats: [], methods: [], planItems: [], budgets: [], recurring: [],

    // ----- routing & periode -----
    route: 'home',
    sel: null, index: 0,
    periods: [], period: { start: todayISO(), end: null },
    periodAll: [], income: 0, expense: 0, groups: [],
    q: '', limit: 150, hasMore: false,

    // ----- UI state -----
    form: blankForm(),
    statsType: 'expense',
    statsTab: 'summary',
    fCat: '', fMethod: '', filtered: false, fSum: { n: 0, income: 0, expense: 0 },
    filterOpen: false, homeHighlights: false,
    toast: null, toastTimer: null,
    trendMode: 'period', trendN: 6, trendKind: 'bar',
    trend: { rows: [], last: null, tiles: [] },
    speedChart: null,
    newPlan: { name: '', est: '' },
    recurringDraft: { item: '', categoryId: '', methodId: '', amount: 0, dayOfMonth: 1, note: '' },
    recurringRuns: new Set(),
    swipeX: 0,
    newName: { cx: '', ci: '', m: '' },
    history: Number(localStorage.getItem('historyMonths') ?? 12),
    preview: null, previewBad: 0, importMsg: '',

    // helper untuk template
    rupiah, fmtDate, periodLabel, parseNum, short, icon: iconOf, health: healthOf,
    seg: active => `rounded-md px-2.5 py-1 ${active ? 'bg-white font-medium shadow-sm' : 'text-slate-500'}`,
    fmtNum: n => (n ? n.toLocaleString('id-ID') : ''),
    color: i => COLORS[i % COLORS.length],
    chip: active =>
      `rounded-full px-4 py-2 text-sm ${active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`,
    chipSm: active =>
      `shrink-0 whitespace-nowrap rounded-full px-3 py-1.5 text-xs ${active ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600'}`,

    // =============== lifecycle ===============
    init() {
      window.addEventListener('hashchange', () => this.readRoute());
      window.addEventListener('online', () => (this.online = true));
      window.addEventListener('offline', () => (this.online = false));
      window.addEventListener('moneyst:sync', e => {
        this.pending = !!e.detail?.pending;
        this.outboxCount = e.detail?.outboxCount || 0;
        if (e.detail?.ok) this.syncAt = e.detail.at;
        if (e.detail?.error) this.syncErr = e.detail.error;
      });
      this.listen();
      this.readRoute();
    },

    stop() { unsubs.forEach(f => f()); unsubs = []; },

    listen() {
      this.stop();
      const err = n => e => { console.error('Listener', n, e); this.syncErr = e.message; };

      const txSource = this.history
        ? query(col('transactions'), where('date', '>=', monthsAgoISO(this.history)))
        : col('transactions');

      unsubs = [
        onSnapshot(txSource, { includeMetadataChanges: true }, snap => {
          this.pending = snap.metadata.hasPendingWrites; // true = ada data belum terkirim ke server
          this.syncErr = '';
          this.txs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          this.loading = false;
          this.recompute();
          // kalau halaman edit dibuka langsung (reload), isi form setelah data tiba
          if (this.route === 'add' && this.form.id && !this.form.loaded) this.openForm(this.form.id);
        }, err('transactions')),

        onSnapshot(col('categories'), { includeMetadataChanges: true }, snap => {
          this.cats = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName);
          // seed hanya jika SERVER memang kosong (bukan sekadar cache kosong)
          if (!snap.metadata.fromCache && snap.empty) {
            DEFAULT_CATS.forEach(([id, name, type]) =>
              setDoc(doc(col('categories'), id), { name, type }).catch(console.error));
          }
        }, err('categories')),

        onSnapshot(col('methods'), { includeMetadataChanges: true }, snap => {
          this.methods = snap.docs.map(d => ({ id: d.id, ...d.data() })).sort(byName);
          if (!snap.metadata.fromCache && snap.empty) {
            DEFAULT_METHODS.forEach(([id, name]) =>
              setDoc(doc(col('methods'), id), { name }).catch(console.error));
          }
        }, err('methods')),

        onSnapshot(col('planItems'), snap => {
          this.planItems = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        }, err('planItems')),
        onSnapshot(col('budgets'), snap => {
          this.budgets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          this.recompute();
        }, err('budgets')),
        onSnapshot(col('recurring'), snap => {
          this.recurring = snap.docs.map(d => ({ id: d.id, ...d.data() }));
          this.processRecurring();
        }, err('recurring')),
      ];
    },

    fail(e) { console.error(e); alert('Gagal menyimpan: ' + e.message); },

    // =============== routing ===============
    go(path) { location.hash = '#' + path; },

    readRoute() {
      const [path, qs] = (location.hash.slice(1) || '/').split('?');
      const sp = new URLSearchParams(qs || '');
      const parts = path.split('/').filter(Boolean);
      const r = parts[0] || 'home';
      this.route = ['add', 'stats', 'plans', 'settings'].includes(r) ? r : 'home';
      if (this.route === 'add') this.openForm(parts[1], sp);
      if (this.route === 'stats') this.$nextTick(() => this.drawChart());
      window.scrollTo(0, 0);
    },

    // =============== periode & daftar transaksi ===============
    recompute() {
      this.periods = buildPeriods(this.txs);
      this.index = this.sel === null
        ? defaultIndex(this.periods)
        : Math.min(this.sel, this.periods.length - 1);
      this.period = this.periods[this.index];

      const all = this.txs
        .filter(t => inPeriod(t.date, this.period))
        .sort((a, b) => b.date.localeCompare(a.date) || (b.createdAt || 0) - (a.createdAt || 0));
      this.periodAll = all;
      this.processRecurring();

      // transfer antar dompet tidak dihitung sebagai pemasukan/pengeluaran
      const real = all.filter(t => !t.isTransfer);
      this.income = real.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
      this.expense = real.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

      const needle = this.q.trim().toLowerCase();
      let list = all;
      if (this.fCat) list = list.filter(t => !this.isXfer(t) && this.catName(t.categoryId) === this.fCat);
      if (this.fMethod) list = list.filter(t => t.methodId === this.fMethod || t.toMethodId === this.fMethod);
      if (needle) list = list.filter(t => `${t.item} ${this.catLabel(t)} ${t.note || ''}`.toLowerCase().includes(needle));
      this.filtered = !!(this.fCat || this.fMethod || needle);
      const sum = { n: list.length, income: 0, expense: 0 };
      for (const t of list) if (!t.isTransfer) sum[t.type === 'income' ? 'income' : 'expense'] += t.amount;
      this.fSum = sum;
      this.hasMore = list.length > this.limit;

      const map = new Map();
      for (const t of this.mergeLegacyTransfers(list).slice(0, this.limit)) {
        if (!map.has(t.date)) map.set(t.date, { date: t.date, items: [], expense: 0 });
        const g = map.get(t.date);
        g.items.push(t);
        if (t.type === 'expense' && !t.isTransfer) g.expense += t.amount;
      }
      this.groups = [...map.values()];
      this.trend = this.buildTrend();
      if (this.route === 'stats') this.$nextTick(() => this.drawChart());
    },

    shift(d) {
      const i = Math.max(0, Math.min(this.periods.length - 1, this.index + d));
      this.sel = i === defaultIndex(this.periods) ? null : i; // null = ikut periode terbaru
      this.fCat = '';
      this.recompute();
      this.$nextTick(() => this.drawChart());
    },
    setStatsTab(tab) {
      this.statsTab = tab;
      this.$nextTick(() => this.drawChart());
    },
    filterWallet(m) {
      this.fMethod = m.id;
      this.recompute();
      this.$nextTick(() => document.querySelector('.transaction-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
    },
    touchStart(e) { this.swipeX = e.changedTouches[0]?.clientX || 0; },
    touchEnd(e) {
      const end = e.changedTouches[0]?.clientX || 0;
      if (Math.abs(end - this.swipeX) < 55) return;
      this.shift(end < this.swipeX ? 1 : -1);
    },
    more() { this.limit += 150; this.recompute(); },

    catName(id) { return this.cats.find(c => c.id === id)?.name ?? '—'; },
    methodName(id) { return this.methods.find(m => m.id === id)?.name ?? '—'; },
    walletColor(m) {
      return WALLET_COLORS[hashText(m.id) % WALLET_COLORS.length];
    },
    get filterCats() {
      return [...new Set(this.periodAll.filter(t => !this.isXfer(t)).map(t => this.catName(t.categoryId)))]
        .filter(n => n !== '—')
        .sort((a, b) => a.localeCompare(b, 'id'));
    },
    isXfer(t) { return !!(t.isTransfer && t.toMethodId); },
    txIcon(t) { return iconOf(this.isXfer(t) ? 'transfer' : this.catName(t.categoryId)); },
    mergeLegacyTransfers(items) {
      const byKey = new Map();
      const paired = new Set();
      const result = [];

      for (const t of items) {
        if (!t.isTransfer || t.toMethodId) {
          result.push(t);
          continue;
        }
        const key = `${t.date}|${t.amount}|${t.note || ''}`;
        const pair = byKey.get(key);
        if (!pair) {
          byKey.set(key, t);
          result.push(t);
          continue;
        }
        if (pair.type === t.type || paired.has(pair.id)) {
          result.push(t);
          continue;
        }

        const outgoing = pair.type === 'expense' ? pair : t;
        const incoming = pair.type === 'income' ? pair : t;
        const index = result.indexOf(pair);
        result[index] = {
          ...outgoing,
          id: `legacy-transfer-${outgoing.id}-${incoming.id}`,
          methodId: outgoing.methodId,
          toMethodId: incoming.methodId,
          item: '',
          _legacyPair: true,
        };
        paired.add(pair.id);
        paired.add(t.id);
      }
      return result.filter(t => !paired.has(t.id) || t._legacyPair);
    },
    catLabel(t) {
      return this.isXfer(t)
        ? `${this.methodName(t.methodId)} → ${this.methodName(t.toMethodId)}`
        : this.catName(t.categoryId);
    },

    methodBal(m) {
      if (!m.openingDate) return null;
      const covered = !this.history || m.openingDate >= monthsAgoISO(this.history);
      return covered ? (m.openingBalance || 0) + this.netSince(m.id, m.openingDate) : (m.balance || 0);
    },
    get wallets() {
      return this.methods.filter(m => m.openingDate)
        .map(m => ({ ...m, bal: this.methodBal(m) }))
        .sort((a, b) => b.bal - a.bal);
    },
    get walletTotal() { return this.wallets.reduce((s, m) => s + m.bal, 0); },

    netSince(id, from) {
      let n = 0;
      for (const t of this.txs) {
        if (t.date < from) continue;
        if (this.isXfer(t)) {
          if (t.methodId === id) n -= t.amount;
          if (t.toMethodId === id) n += t.amount;
        } else if (t.methodId === id) {
          n += t.type === 'income' ? t.amount : -t.amount;
        }
      }
      return n;
    },

    setWallet(m) {
      const s = prompt(`Saldo ${m.name} sekarang (Rp)?`, m.openingDate ? String(this.methodBal(m)) : '');
      if (s === null) return;
      if (!/\d/.test(s)) return alert('Isi dengan angka ya');
      const now = (s.trim().startsWith('-') ? -1 : 1) * parseNum(s);
      const today = todayISO();
      updateDoc(doc(col('methods'), m.id), {
        openingBalance: now - this.netSince(m.id, today), openingDate: today, balance: now,
      }).catch(e => this.fail(e));
    },

    // =============== form tambah / edit ===============
    get catList() { return this.cats.filter(c => c.type === this.form.type); },
    get effCat() { return this.catList.some(c => c.id === this.form.categoryId) ? this.form.categoryId : this.catList[0]?.id; },
    get effMethod() { return this.methods.some(m => m.id === this.form.methodId) ? this.form.methodId : this.methods[0]?.id; },
    get effTo() {
      const ok = this.methods.some(m => m.id === this.form.toMethodId && m.id !== this.effMethod);
      return ok ? this.form.toMethodId : this.methods.find(m => m.id !== this.effMethod)?.id;
    },

    openForm(id, sp) {
      if (id) {
        const t = this.txs.find(x => x.id === id);
        this.form = t
          ? { ...blankForm(), ...t,
              type: t.isTransfer && t.toMethodId ? 'transfer' : t.type, toMethodId: t.toMethodId || '',
              note: t.note || '', isSalary: !!t.isSalary, planItemId: null, loaded: true }
          : { ...blankForm(), id, loaded: false }; // data belum tiba, diisi ulang nanti
        return;
      }
      const f = blankForm();
      if (sp?.get('type') === 'income') f.type = 'income';
      const pid = sp?.get('planItem');
      if (pid) {
        const p = this.planItems.find(x => x.id === pid);
        if (p) { f.planItemId = pid; f.item = p.name; f.amount = p.estimate || 0; }
      }
      this.form = f;
    },

    get itemSuggestions() {
      const q = this.form.item.trim().toLowerCase();
      if (!q) return [];
      const seen = new Set();
      return this.txs
        .filter(t => t.item && t.item.toLowerCase().includes(q) && !this.isXfer(t))
        .sort((a, b) => (b.date || '').localeCompare(a.date || ''))
        .filter(t => { const key = t.item.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; })
        .slice(0, 5);
    },
    applySuggestion(t) {
      this.form.item = t.item;
      this.form.amount = t.amount;
      this.form.categoryId = t.categoryId || '';
      this.form.methodId = t.methodId || this.form.methodId;
      this.form.note = t.note || '';
    },

    setType(t) { this.form.type = t; this.form.categoryId = ''; this.form.isSalary = false; },
    pickCat(c) {
      this.form.categoryId = c.id;
      if (this.form.type === 'income') this.form.isSalary = /gaji/i.test(c.name);
    },

    saveForm() {
      const f = this.form;
      const transfer = f.type === 'transfer';
      if (!f.amount) return alert('Isi nominal dulu ya');
      if (!f.date) return alert('Tanggal belum diisi');
      const methodId = this.effMethod;
      const toMethodId = transfer ? this.effTo : null;
      const categoryId = transfer ? null : this.effCat;
      if (!methodId) return alert('Metode bayar belum tersedia');
      if (transfer && !toMethodId) return alert('Transfer butuh minimal 2 dompet');
      if (!transfer && !categoryId) return alert('Kategori belum tersedia');

      localStorage.setItem('lastMethod', methodId);
      const ref = f.id ? doc(col('transactions'), f.id) : doc(col('transactions'));
      const old = f.id ? this.txs.find(t => t.id === f.id) : null;
      const isSalary = f.type === 'income' && f.isSalary;
      if (old?.isSalary && (!isSalary || old.date !== f.date)) {
        const i = this.periods.findIndex(p => p.start === old.date);
        this.relocatePlans(old.date, isSalary ? f.date : this.periods[i - 1]?.start);
      }

      setDoc(ref, {
        date: f.date,
        item: f.item.trim() || (transfer ? 'Transfer' : this.catName(categoryId)),
        categoryId, methodId, toMethodId,
        amount: f.amount,
        type: transfer ? 'expense' : f.type,
        note: f.note.trim(),
        isSalary,
        recurringId: old?.recurringId || null,
        isTransfer: transfer || (!!old?.isTransfer && !old?.toMethodId),
        createdAt: old?.createdAt ?? Date.now(),
      }).catch(e => this.fail(e));

      if (f.planItemId) {
        updateDoc(doc(col('planItems'), f.planItemId), { done: true, transactionId: ref.id })
          .catch(e => this.fail(e));
      }
      if (isSalary) this.sel = null; // lompat ke periode terbaru
      this.go(f.planItemId ? '/plans' : '/');
    },

    deleteTx() {
      const id = this.form.id;
      const old = this.txs.find(t => t.id === id);
      if (!id || !old) return;
      if (old.isSalary) {
        if (!confirm('Ini transaksi gaji (awal periode). Hapus?')) return;
        const i = this.periods.findIndex(p => p.start === old.date);
        this.relocatePlans(old.date, this.periods[i - 1]?.start);
      }
      const plans = this.planItems.filter(p => p.transactionId === id).map(p => p.id);
      plans.forEach(pid => updateDoc(doc(col('planItems'), pid), { done: false, transactionId: null })
        .catch(e => this.fail(e)));
      deleteDoc(doc(col('transactions'), id)).catch(e => this.fail(e));
      this.go('/');

      if (!old.isSalary) {
        this.showToast('Transaksi dihapus', () => {
          const { id: _omit, ...data } = old;
          setDoc(doc(col('transactions'), id), data).catch(e => this.fail(e));
          plans.forEach(pid => updateDoc(doc(col('planItems'), pid), { done: true, transactionId: id })
            .catch(e => this.fail(e)));
        });
      }
    },

    showToast(msg, undo) {
      clearTimeout(this.toastTimer);
      this.toast = { msg, undo };
      this.toastTimer = setTimeout(() => (this.toast = null), 7000);
    },
    runUndo() {
      const u = this.toast?.undo;
      clearTimeout(this.toastTimer);
      this.toast = null;
      u?.();
    },

    // =============== rencana belanja ===============
    get planList() {
      return this.planItems
        .filter(i => i.periodStart === this.period.start)
        .sort((a, b) => a.order - b.order);
    },
    get planDone() { return this.planList.filter(i => i.done).length; },
    get planEst() { return this.planList.reduce((s, i) => s + (i.estimate || 0), 0); },
    get planReal() { return this.planList.reduce((s, i) => s + this.realOf(i), 0); },
    realOf(i) { return this.txs.find(t => t.id === i.transactionId)?.amount || 0; },

    addPlan() {
      const name = this.newPlan.name.trim();
      if (!name) return;
      setDoc(doc(col('planItems')), {
        periodStart: this.period.start,
        name,
        estimate: parseNum(this.newPlan.est) || null,
        done: false,
        transactionId: null,
        order: Date.now(),
      }).catch(e => this.fail(e));
      this.newPlan = { name: '', est: '' };
    },

    togglePlan(i) {
      if (!i.done) return this.go('/add?planItem=' + i.id); // form terbuka, item tercentang setelah disimpan
      if (!confirm('Batalkan centang? Transaksi terkait ikut dihapus.')) return;
      if (i.transactionId) deleteDoc(doc(col('transactions'), i.transactionId)).catch(e => this.fail(e));
      updateDoc(doc(col('planItems'), i.id), { done: false, transactionId: null }).catch(e => this.fail(e));
    },

    delPlan(i) { deleteDoc(doc(col('planItems'), i.id)).catch(e => this.fail(e)); },

    relocatePlans(from, to) {
      if (!to || from === to) return;
      this.planItems
        .filter(p => p.periodStart === from)
        .forEach(p => updateDoc(doc(col('planItems'), p.id), { periodStart: to })
          .catch(e => this.fail(e)));
    },

    copyPrev() {
      const prev = this.periods[this.index - 1];
      if (!prev) return;
      const exist = new Set(this.planList.map(p => p.name.toLowerCase()));
      this.planItems
        .filter(i => i.periodStart === prev.start && !i.done && !exist.has(i.name.toLowerCase()))
        .forEach((i, n) => setDoc(doc(col('planItems')), {
          periodStart: this.period.start, name: i.name, estimate: i.estimate ?? null,
          done: false, transactionId: null, order: Date.now() + n,
        }).catch(e => this.fail(e)));
    },

    // =============== statistik ===============
    catTotals(type) {
      const m = new Map();
      for (const t of this.periodAll) {
        if (t.type === type && !t.isTransfer) {
          const name = this.catName(t.categoryId);
          m.set(name, (m.get(name) || 0) + t.amount);
        }
      }
      return [...m].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
    },
    get statsData() { return this.catTotals(this.statsType); },
    get statsTotal() { return this.statsData.reduce((s, d) => s + d.value, 0); },

    get topCats() {
      return this.budgetRows.length ? this.budgetRows.slice(0, 6) : (() => {
        const d = this.catTotals('expense');
        const total = d.reduce((s, x) => s + x.value, 0) || 1;
        return d.slice(0, 6).map(x => ({ ...x, pct: Math.round((x.value / total) * 100), budget: null }));
      })();
    },

    get budgetRows() {
      const spent = new Map(this.catTotals('expense').map(x => [x.name, x.value]));
      return this.budgets.filter(b => b.periodStart === this.period.start)
        .map(b => {
          const name = this.catName(b.categoryId);
          const value = spent.get(name) || 0;
          const pct = b.amount ? Math.round(value / b.amount * 100) : 0;
          return {
            ...b, name, value, budget: b.amount, pct, visualPct: Math.min(100, pct),
            over: pct >= 100, warn: pct >= 80,
          };
        }).sort((a, b) => b.value - a.value);
    },
    get budgetTotal() { return this.budgetRows.reduce((s, b) => s + b.budget, 0); },
    get budgetSpent() { return this.budgetRows.reduce((s, b) => s + b.value, 0); },
    get budgetPercent() { return this.budgetTotal ? Math.round(this.budgetSpent / this.budgetTotal * 100) : 0; },
    saveBudget(categoryId, amount) {
      const id = `budget-${this.period.start}-${categoryId}`;
      if (!amount) return deleteDoc(doc(col('budgets'), id)).catch(e => this.fail(e));
      setDoc(doc(col('budgets'), id), { periodStart: this.period.start, categoryId, amount }).catch(e => this.fail(e));
    },
    get budgetEditors() {
      return this.cats.filter(c => c.type === 'expense').map(c => ({
        ...c, amount: this.budgets.find(b => b.periodStart === this.period.start && b.categoryId === c.id)?.amount || 0,
      }));
    },
    saveRecurring() {
      const r = this.recurringDraft;
      if (!r.item.trim() || !r.categoryId || !r.methodId || !r.amount) return alert('Lengkapi item, kategori, dompet, dan nominal');
      const day = Math.max(1, Math.min(31, Number(r.dayOfMonth) || 1));
      const next = this.nextRecurringDate(day);
      setDoc(doc(col('recurring')), { item: r.item.trim(), categoryId: r.categoryId, methodId: r.methodId,
        amount: Number(r.amount), dayOfMonth: day, nextDate: next, note: r.note.trim(), enabled: true })
        .catch(e => this.fail(e));
      this.recurringDraft = { item: '', categoryId: '', methodId: '', amount: 0, dayOfMonth: 1, note: '' };
    },
    nextRecurringDate(day, base = todayISO()) {
      const [year, month, date] = base.split('-').map(Number);
      let y = year, m = month;
      if (date > Math.min(day, new Date(y, m, 0).getDate())) {
        m++;
        if (m === 13) { m = 1; y++; }
      }
      const last = new Date(y, m, 0).getDate();
      return `${y}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
    },
    get recurringPreview() {
      const day = Math.max(1, Math.min(31, Number(this.recurringDraft.dayOfMonth) || 1));
      return this.nextRecurringDate(day);
    },
    removeRecurring(r) { deleteDoc(doc(col('recurring'), r.id)).catch(e => this.fail(e)); },

    processRecurring() {
      if (!this.recurring.length || !this.txs.length && !this.methods.length) return;
      const today = todayISO();
      for (const r of this.recurring.filter(x => x.enabled && x.nextDate <= today)) {
        let next = r.nextDate;
        let count = 0;
        while (next <= today && count++ < 24) {
          const exists = this.txs.some(t => t.recurringId === r.id && t.date === next);
          const runKey = `${r.id}:${next}`;
          if (!exists && !this.recurringRuns.has(runKey)) {
            this.recurringRuns.add(runKey);
            setDoc(doc(col('transactions'), `recurring-${r.id}-${next}`), {
            date: next, item: r.item, categoryId: r.categoryId, methodId: r.methodId,
            amount: r.amount, type: 'expense', note: r.note || '', isSalary: false,
            isTransfer: false, recurringId: r.id, createdAt: Date.now(),
            }).catch(e => this.fail(e));
          }
          const [year, month] = next.split('-').map(Number);
          const nextMonth = month === 12 ? 1 : month + 1;
          const nextYear = month === 12 ? year + 1 : year;
          const lastDay = new Date(nextYear, nextMonth, 0).getDate();
          next = `${nextYear}-${String(nextMonth).padStart(2, '0')}-${String(Math.min(r.dayOfMonth, lastDay)).padStart(2, '0')}`;
        }
        if (next !== r.nextDate) updateDoc(doc(col('recurring'), r.id), { nextDate: next }).catch(e => this.fail(e));
      }
    },

    get speedData() {
      const today = todayISO();
      const end = this.period.end && this.period.end < today ? this.period.end : today;
      const days = Math.max(1, Math.round((new Date(end) - new Date(this.period.start)) / 864e5) + 1);
      const daily = this.budgetTotal / days;
      const sums = new Map();
      this.periodAll.filter(t => t.type === 'expense' && !this.isXfer(t)).forEach(t => sums.set(t.date, (sums.get(t.date) || 0) + t.amount));
      const labels = [], actual = [], ideal = []; let run = 0;
      for (let i = 0; i < days; i++) {
        const date = addDaysISO(this.period.start, i);
        labels.push(date.slice(8)); run += sums.get(date) || 0; actual.push(run); ideal.push(Math.round(daily * (i + 1)));
      }
      return { labels, actual, ideal };
    },

    get byMethod() {
      const m = new Map();
      for (const t of this.periodAll) {
        if (t.type === this.statsType && !t.isTransfer) m.set(t.methodId, (m.get(t.methodId) || 0) + t.amount);
      }
      const arr = [...m]
        .map(([id, value]) => ({ id, name: this.methodName(id), value }))
        .sort((a, b) => b.value - a.value);
      const total = arr.reduce((s, x) => s + x.value, 0) || 1;
      return arr.map(x => ({ ...x, pct: (x.value / total) * 100 }));
    },

    get tileList() {
      const list = this.periodAll.filter(t => t.type === this.statsType && !t.isTransfer);
      const total = list.reduce((s, t) => s + t.amount, 0);
      const today = todayISO();
      const end = this.period.end && this.period.end < today ? this.period.end : today;
      const days = Math.max(1, Math.round((new Date(end) - new Date(this.period.start)) / 864e5) + 1);
      const top = list.reduce((a, t) => (!a || t.amount > a.amount ? t : a), null);
      return [
        { label: 'Rata-rata / hari', value: rupiah(Math.round(total / days)) },
        { label: 'Jumlah transaksi', value: list.length + ' transaksi' },
        { label: 'Hari berjalan', value: days + ' hari' },
        { label: 'Terbesar', value: top ? rupiah(top.amount) : '—', sub: top?.item || '' },
      ];
    },

    trendData() {
      const today = todayISO();
      const end = this.period.end && this.period.end < today ? this.period.end : today;
      const start = [this.period.start, addDaysISO(end, -44)].sort().pop();
      const sums = new Map();
      for (const t of this.periodAll) {
        if (t.type === this.statsType && !t.isTransfer) sums.set(t.date, (sums.get(t.date) || 0) + t.amount);
      }
      const labels = [], values = [];
      for (let d = start, n = 0; d <= end && n < 60; d = addDaysISO(d, 1), n++) {
        labels.push(d.slice(8));
        values.push(sums.get(d) || 0);
      }
      return { labels, values };
    },

    // =============== tren & kesehatan keuangan ===============
    buildTrend() {
      const n = this.trendN;
      const today = todayISO();
      let buckets;
      if (this.trendMode === 'month') {
        const end = this.period.end && this.period.end < today ? this.period.end : today;
        let [y, m] = end.split('-').map(Number);
        buckets = [];
        for (let i = 0; i < n; i++) {
          const key = `${y}-${String(m).padStart(2, '0')}`;
          buckets.unshift({
            key, label: fmtDate(key + '-01', { month: 'short', year: '2-digit' }),
            open: key === today.slice(0, 7), has: d => d.startsWith(key), inc: 0, exp: 0,
          });
          if (--m === 0) { m = 12; y--; }
        }
      } else {
        buckets = this.periods.slice(Math.max(0, this.index - n + 1), this.index + 1).map(p => ({
          key: p.start, label: fmtDate(p.start, { day: 'numeric', month: 'short' }),
          open: !p.end, has: d => inPeriod(d, p), inc: 0, exp: 0,
        }));
      }

      for (const t of this.txs) {
        if (t.isTransfer) continue;
        const b = buckets.find(x => x.has(t.date));
        if (!b) continue;
        if (t.type === 'income') b.inc += t.amount; else b.exp += t.amount;
      }
      while (buckets.length > 1 && !buckets[0].inc && !buckets[0].exp) buckets.shift();

      const rows = buckets.map(({ has, ...b }) => {
        const net = b.inc - b.exp;
        return { ...b, net, rate: b.inc > 0 ? Math.round((net / b.inc) * 100) : null };
      });
      const done = rows.filter(r => !r.open && r.inc > 0);
      const sum = k => done.reduce((s, r) => s + r[k], 0);
      const unit = this.trendMode === 'month' ? 'bulan' : 'periode';
      const avgRate = sum('inc') ? Math.round((sum('net') / sum('inc')) * 100) : null;
      const tiles = [
        { label: 'Rasio tabungan rata-rata', value: avgRate === null ? '—' : avgRate + '%', sub: `target ≥ ${TARGET_SAVE}%` },
        { label: (unit === 'bulan' ? 'Bulan' : 'Periode') + ' surplus',
          value: done.length ? `${done.filter(r => r.net >= 0).length} dari ${done.length}` : '—', sub: 'pemasukan ≥ pengeluaran' },
        { label: `Rata-rata keluar / ${unit}`, value: done.length ? rupiah(Math.round(sum('exp') / done.length)) : '—' },
        { label: `Rata-rata sisa / ${unit}`, value: done.length ? rupiah(Math.round(sum('net') / done.length)) : '—' },
      ];
      return { rows, last: rows[rows.length - 1] || null, tiles };
    },

    setTrend(key, value) {
      this[key] = value;
      this.trend = this.buildTrend();
      this.$nextTick(() => this.drawChart());
    },

    setStats(t) { this.statsType = t; this.$nextTick(() => this.drawChart()); },

    drawChart() {
      Object.values(charts).forEach(c => c.destroy());
      Object.keys(charts).forEach(k => delete charts[k]);
      if (!window.Chart || this.route !== 'stats') return;
      const el = id => document.getElementById(id);
      const legend = { position: 'bottom', labels: { boxWidth: 10, usePointStyle: true } };
      const scales = { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: v => short(v) } } };

      const d = this.statsData;
      if (el('donut') && d.length) {
        charts.donut = new Chart(el('donut'), {
          type: 'doughnut',
          data: { labels: d.map(x => x.name), datasets: [{ data: d.map(x => x.value), backgroundColor: d.map((_, i) => this.color(i)), borderWidth: 0 }] },
          options: { cutout: '68%', maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + rupiah(c.parsed) } } } },
        });
      }

      const tr = this.trendData();
      if (el('trend') && tr.values.some(v => v > 0)) {
        charts.trend = new Chart(el('trend'), {
          type: 'bar',
          data: { labels: tr.labels, datasets: [{ data: tr.values, backgroundColor: this.statsType === 'income' ? '#10b981' : '#2563eb', borderRadius: 4 }] },
          options: { maintainAspectRatio: false, scales, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => ' ' + rupiah(c.parsed.y) } } } },
        });
      }

      const speed = this.speedData;
      if (el('speed') && (speed.actual.some(v => v > 0) || speed.ideal.some(v => v > 0))) {
        charts.speed = new Chart(el('speed'), {
          type: 'line',
          data: {
            labels: speed.labels,
            datasets: [
              { label: 'Pengeluaran kumulatif', data: speed.actual, borderColor: '#f43f5e', backgroundColor: '#f43f5e', tension: 0.25, pointRadius: 2 },
              { label: 'Jatah ideal harian', data: speed.ideal, borderColor: '#2563eb', backgroundColor: '#2563eb', borderDash: [5, 4], tension: 0.25, pointRadius: 0 },
            ],
          },
          options: {
            maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            scales, plugins: { legend, tooltip: { callbacks: { label: c => ` ${c.dataset.label}: ${rupiah(c.parsed.y)}` } } },
          },
        });
      }

      const rows = this.trend.rows;
      if (el('health') && rows.some(r => r.inc || r.exp)) {
        const common = { yAxisID: 'y', borderRadius: 4, tension: 0.3, pointRadius: 3, fill: false };
        charts.health = new Chart(el('health'), {
          type: 'bar',
          data: {
            labels: rows.map(r => r.label + (r.open ? '*' : '')),
            datasets: [
              { type: this.trendKind === 'line' ? 'line' : 'bar', ...common, label: 'Pemasukan', data: rows.map(r => r.inc), backgroundColor: '#10b981', borderColor: '#10b981' },
              { type: this.trendKind === 'line' ? 'line' : 'bar', ...common, label: 'Pengeluaran', data: rows.map(r => r.exp), backgroundColor: '#2563eb', borderColor: '#2563eb' },
              { type: 'line', label: 'Rasio tabungan', data: rows.map(r => r.rate), yAxisID: 'y2', borderColor: '#f59e0b', backgroundColor: '#f59e0b', borderWidth: 2, pointRadius: 3, tension: 0.3, spanGaps: true },
            ],
          },
          options: {
            maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
            scales: {
              x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { callback: v => short(v) } },
              y2: { position: 'right', beginAtZero: true, suggestedMin: -100, suggestedMax: 100, grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } },
            },
            plugins: { legend, tooltip: { callbacks: { label: c => c.dataset.yAxisID === 'y2' ? ` ${c.dataset.label}: ${c.parsed.y ?? '—'}%` : ` ${c.dataset.label}: ${rupiah(c.parsed.y)}` } } },
          },
        });
      }
    },

    // =============== pengaturan ===============
    get lists() {
      return [
        { key: 'cx', title: 'Kategori pengeluaran', col: 'categories', type: 'expense', items: this.cats.filter(c => c.type === 'expense') },
        { key: 'ci', title: 'Kategori pemasukan', col: 'categories', type: 'income', items: this.cats.filter(c => c.type === 'income') },
        { key: 'm', title: 'Metode pembayaran', col: 'methods', type: null, items: this.methods },
      ];
    },
    addTo(s) {
      const name = this.newName[s.key].trim();
      if (!name) return;
      setDoc(doc(col(s.col)), s.type ? { name, type: s.type } : { name }).catch(e => this.fail(e));
      this.newName[s.key] = '';
    },
    removeFrom(s, item) {
      if (confirm(`Hapus "${item.name}"? Transaksi lama dengan item ini akan tampil "—".`)) {
        deleteDoc(doc(col(s.col), item.id)).catch(e => this.fail(e));
      }
    },

    setHistory(v) {
      this.history = Number(v);
      localStorage.setItem('historyMonths', v);
      this.listen();
    },

    async onFile(e) {
      const f = e.target.files[0];
      if (!f) return;
      this.importMsg = '';
      const r = await parseCsv(f);
      this.preview = r.rows;
      this.previewBad = r.bad;
      e.target.value = '';
    },
    async doImport() {
      if (!navigator.onLine) return alert('Import butuh koneksi internet.');
      this.busy = true;
      this.importMsg = 'Menyiapkan…';
      try {
        const snap = await getDocs(col('transactions'));
        const all = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        const r = await commitImport(this.preview, this.cats, this.methods, all,
          (d, t) => (this.importMsg = `Mengirim ${d} dari ${t}…`));
        this.importMsg = `Selesai: ${r.added} transaksi masuk, ${r.skipped} dilewati (sudah ada).`;
        this.preview = null;
      } catch (e) {
        this.importMsg = 'Gagal: ' + e.message;
      }
      this.busy = false;
    },
    async exportAll() {
      if (!navigator.onLine) return alert('Backup butuh koneksi internet.');
      this.busy = true;
      try {
        const snap = await getDocs(col('transactions'));
        exportCsv(snap.docs.map(d => ({ id: d.id, ...d.data() })), this.cats, this.methods);
      } catch (e) { alert('Gagal backup: ' + e.message); }
      this.busy = false;
    },
  }));
});