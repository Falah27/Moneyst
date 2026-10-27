import { col, doc, setDoc, updateDoc, deleteDoc, query, where, onSnapshot, getDocs } from './db.js';
import {
  rupiah, parseNum, todayISO, monthsAgoISO, fmtDate, periodLabel,
  buildPeriods, inPeriod, defaultIndex,
} from './utils.js';
import { parseCsv, commitImport, exportCsv } from './csv.js';

const COLORS = ['#10b981', '#6366f1', '#f59e0b', '#ef4444', '#06b6d4', '#8b5cf6', '#ec4899', '#84cc16', '#64748b'];

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
let chart = null; // sengaja di luar Alpine agar tidak dibungkus proxy

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }));
}

document.addEventListener('alpine:init', () => {
  Alpine.data('app', () => ({
    busy: false,
    pending: false, syncErr: '',
    online: navigator.onLine,

    // ----- data (dari Firestore) -----
    txs: [], cats: [], methods: [], planItems: [],

    // ----- routing & periode -----
    route: 'home',
    sel: null, index: 0,
    periods: [], period: { start: todayISO(), end: null },
    periodAll: [], income: 0, expense: 0, groups: [],
    q: '', limit: 150, hasMore: false,

    // ----- UI state -----
    form: blankForm(),
    statsType: 'expense',
    newPlan: { name: '', est: '' },
    newName: { cx: '', ci: '', m: '' },
    history: Number(localStorage.getItem('historyMonths') ?? 12),
    preview: null, previewBad: 0, importMsg: '',

    // helper untuk template
    rupiah, fmtDate, periodLabel, parseNum,
    fmtNum: n => (n ? n.toLocaleString('id-ID') : ''),
    color: i => COLORS[i % COLORS.length],
    chip: active =>
      `rounded-full px-4 py-2 text-sm ${active ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-600'}`,

    // =============== lifecycle ===============
    init() {
      window.addEventListener('hashchange', () => this.readRoute());
      window.addEventListener('online', () => (this.online = true));
      window.addEventListener('offline', () => (this.online = false));
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

      // transfer antar dompet tidak dihitung sebagai pemasukan/pengeluaran
      const real = all.filter(t => !t.isTransfer);
      this.income = real.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
      this.expense = real.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);

      const needle = this.q.trim().toLowerCase();
      const list = needle
        ? all.filter(t => `${t.item} ${this.catName(t.categoryId)} ${t.note || ''}`.toLowerCase().includes(needle))
        : all;
      this.hasMore = list.length > this.limit;

      const map = new Map();
      for (const t of list.slice(0, this.limit)) {
        if (!map.has(t.date)) map.set(t.date, { date: t.date, items: [], expense: 0 });
        const g = map.get(t.date);
        g.items.push(t);
        if (t.type === 'expense' && !t.isTransfer) g.expense += t.amount;
      }
      this.groups = [...map.values()];
      if (this.route === 'stats') this.$nextTick(() => this.drawChart());
    },

    shift(d) {
      const i = Math.max(0, Math.min(this.periods.length - 1, this.index + d));
      this.sel = i === defaultIndex(this.periods) ? null : i; // null = ikut periode terbaru
      this.recompute();
      this.$nextTick(() => this.drawChart());
    },
    more() { this.limit += 150; this.recompute(); },

    catName(id) { return this.cats.find(c => c.id === id)?.name ?? '—'; },
    methodName(id) { return this.methods.find(m => m.id === id)?.name ?? '—'; },
    isXfer(t) { return !!(t.isTransfer && t.toMethodId); },
    catLabel(t) {
      return this.isXfer(t)
        ? `${this.methodName(t.methodId)} → ${this.methodName(t.toMethodId)}`
        : this.catName(t.categoryId);
    },

    get wallets() { return this.methods.filter(m => m.openingDate); },
    get walletTotal() { return this.wallets.reduce((s, m) => s + (m.balance || 0), 0); },

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
      const s = prompt(`Saldo ${m.name} sekarang (Rp)?`, m.openingDate ? String(m.balance || 0) : '');
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
      if (!id || !confirm('Hapus transaksi ini?')) return;
      const old = this.txs.find(t => t.id === id);
      if (old?.isSalary) {
        const i = this.periods.findIndex(p => p.start === old.date);
        this.relocatePlans(old.date, this.periods[i - 1]?.start);
      }
      this.planItems
        .filter(p => p.transactionId === id)
        .forEach(p => updateDoc(doc(col('planItems'), p.id), { done: false, transactionId: null }).catch(e => this.fail(e)));
      deleteDoc(doc(col('transactions'), id)).catch(e => this.fail(e));
      this.go('/');
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
    get statsData() {
      const m = new Map();
      for (const t of this.periodAll) {
        if (t.type === this.statsType && !t.isTransfer) {
          m.set(t.categoryId, (m.get(t.categoryId) || 0) + t.amount);
        }
      }
      return [...m].map(([id, value]) => ({ id, name: this.catName(id), value })).sort((a, b) => b.value - a.value);
    },
    get statsTotal() {
      return this.periodAll
        .filter(t => t.type === this.statsType && !t.isTransfer)
        .reduce((s, t) => s + t.amount, 0);
    },
    setStats(t) { this.statsType = t; this.$nextTick(() => this.drawChart()); },

    drawChart() {
      const el = document.getElementById('donut');
      if (chart) { chart.destroy(); chart = null; }
      const d = this.statsData;
      if (!el || !d.length || !window.Chart) return;
      chart = new Chart(el, {
        type: 'doughnut',
        data: {
          labels: d.map(x => x.name),
          datasets: [{ data: d.map(x => x.value), backgroundColor: d.map((_, i) => COLORS[i % COLORS.length]), borderWidth: 0 }],
        },
        options: { cutout: '68%', maintainAspectRatio: false, plugins: { legend: { display: false } } },
      });
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