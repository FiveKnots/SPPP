/* =========================================================
   Inventori Barang Penumpang — app.js
   Frontend logic: fetch/save via Google Apps Script Web App,
   SLA (30 hari) calculation, table rendering, modals, laporan.
   ========================================================= */

const SLA_DAYS = 30;
const WARN_THRESHOLD_DAYS_LEFT = 5; // kuning saat sisa waktu <= 5 hari

const STATUS_LABELS = {
  'IN': 'Masih di TPS',
  'DIBAYAR': 'Dibayar',
  'IMPOR SEMENTARA': 'Impor Sementara',
  'GESER KE TPP': 'Geser ke TPP',
  'REEKSPOR': 'Reekspor',
  'LAIN-LAIN': 'Lain-lain'
};

const ACTION_FIELDS = {
  'DIBAYAR': [
    { key: 'nomorDokumenStatus', label: 'Nomor Dokumen Pembayaran *', type: 'text', placeholder: '000001/CD/T3/SH/2026' },
    { key: 'tanggalStatus', label: 'Tanggal Pembayaran *', type: 'date' }
  ],
  'IMPOR SEMENTARA': [
    { key: 'nomorDokumenStatus', label: 'Nomor IS *', type: 'text', placeholder: '116/IS/KPU.03/2026' },
    { key: 'nomorBpj', label: 'Nomor BPJ *', type: 'text', placeholder: '1220/BPJ/KPU.03/2026' },
    { key: 'tanggalStatus', label: 'Tanggal Dokumen *', type: 'date' }
  ],
  'GESER KE TPP': [
    { key: 'nomorDokumenStatus', label: 'Nomor ND TPP *', type: 'text', placeholder: 'BA-85' },
    { key: 'tanggalStatus', label: 'Tanggal ND *', type: 'date' }
  ],
  'REEKSPOR': [
    { key: 'nomorDokumenStatus', label: 'Nomor ST Reekspor *', type: 'text', placeholder: '000123' },
    { key: 'tanggalStatus', label: 'Tanggal Reekspor *', type: 'date' }
  ]
};

let state = {
  data: [],
  filtered: [],
  config: { url: '', token: '' },
  pendingActionRow: null,
  pendingActionStatus: null,
  pagination: { currentPage: 1, itemsPerPage: 15 },
  sort: {
    main: { key: 'tanggalDokumen', dir: 'desc' },
    urgent: { key: null, dir: 'asc' },
    report: { key: null, dir: 'asc' }
  }
};

/* ------------------------------------------------------- */
/* Config (localStorage)                                    */
/* ------------------------------------------------------- */
function loadConfig() {
  state.config.url = localStorage.getItem('sppp_url') || '';
  state.config.token = localStorage.getItem('sppp_token') || '';
}
function saveConfig(url, token) {
  localStorage.setItem('sppp_url', url);
  localStorage.setItem('sppp_token', token);
  state.config.url = url;
  state.config.token = token;
}

/* ------------------------------------------------------- */
/* Date / SLA helpers                                       */
/* ------------------------------------------------------- */
function parseDate(val) {
  if (!val) return null;
  const d = new Date(val);
  return isNaN(d.getTime()) ? null : d;
}
function toISODate(d) {
  if (!d) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
function daysBetween(a, b) {
  const MS = 24 * 60 * 60 * 1000;
  const da = new Date(a.getFullYear(), a.getMonth(), a.getDate());
  const db = new Date(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((db - da) / MS);
}
function slaInfo(tanggalDokumen) {
  const doc = parseDate(tanggalDokumen);
  if (!doc) return { daysLeft: null, cls: 'neutral', text: '—' };
  const deadline = new Date(doc);
  deadline.setDate(deadline.getDate() + SLA_DAYS);
  const today = new Date();
  const daysLeft = daysBetween(today, deadline);

  let cls = 'ok';
  if (daysLeft <= 0) cls = 'danger';
  else if (daysLeft <= WARN_THRESHOLD_DAYS_LEFT) cls = 'warn';

  let text;
  if (daysLeft > 0) text = `${daysLeft} hari lagi`;
  else if (daysLeft === 0) text = 'Jatuh tempo hari ini';
  else text = `Lewat ${Math.abs(daysLeft)} hari`;

  return { daysLeft, cls, text, deadline };
}
function statusClass(status) {
  return 'status-' + String(status || 'IN').replace(/\s+/g, '-').toUpperCase();
}

/* ------------------------------------------------------- */
/* API                                                       */
/* ------------------------------------------------------- */
async function apiGet() {
  if (!state.config.url || !state.config.token) {
    throw new Error('URL dan Token belum diatur. Buka menu Pengaturan.');
  }
  const url = `${state.config.url}?token=${encodeURIComponent(state.config.token)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Gagal memuat data (' + res.status + ')');
  const json = await res.json();
  if (json && json.status === 'error') throw new Error(json.message || 'Akses ditolak');
  return Array.isArray(json) ? json : [];
}
async function apiPost(payload) {
  if (!state.config.url || !state.config.token) {
    throw new Error('URL dan Token belum diatur. Buka menu Pengaturan.');
  }
  const body = Object.assign({ token: state.config.token }, payload);
  const res = await fetch(state.config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' }, // avoids CORS preflight on Apps Script
    body: JSON.stringify(body)
  });
  const json = await res.json();
  if (json && json.status === 'error') throw new Error(json.message || 'Gagal menyimpan data');
  return json;
}

/* ------------------------------------------------------- */
/* Toast                                                     */
/* ------------------------------------------------------- */
let toastTimer = null;
function showToast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (type ? ' toast-' + type : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}

/* ------------------------------------------------------- */
/* Data loading                                              */
/* ------------------------------------------------------- */
async function refreshData() {
  const syncEl = document.getElementById('syncStatus');
  const loadingEl = document.getElementById('loadingOverlay');
  
  loadingEl.hidden = false;
  syncEl.textContent = 'Memuat...';
  
  try {
    const raw = await apiGet();
    state.data = raw.map(normalizeRecord);
    applyFilters();
    renderDashboard();
    renderReport();
    syncEl.textContent = `Tersinkron • ${new Date().toLocaleTimeString('id-ID')}`;
    showToast('Data berhasil dimuat', 'success');
  } catch (err) {
    syncEl.textContent = 'Gagal memuat data';
    showToast(err.message, 'error');
  } finally {
    loadingEl.hidden = true;
  }
}
function normalizeRecord(r) {
  return {
    nomorSppp: r['Nomor SPPP'] || '',
    tanggalDokumen: r['Tanggal Dokumen SPPP'] || r['Tanggal Masuk'] || '',
    namaPenumpang: r['Nama Penumpang'] || '',
    noPaspor: r['No Paspor'] || r['No. Paspor'] || '',
    deskripsiBarang: r['Deskripsi Barang'] || '',
    flight: r['No Flight / Negara Asal'] || '',
    jumlah: r['Jumlah Barang / Berat'] || '',
    posisi: r['Posisi Barang'] || '',
    admin: r['Admin'] || '',
    keterangan: r['Keterangan Tambahan'] || '',
    dokumentasi: r['Dokumentasi'] || '',
    kontak: r['Info Kontak'] || r['Info Kontak (Email / No HP.)'] || '',
    status: r['Status'] || 'IN',
    nomorDokumenStatus: r['Nomor Dokumen Status'] || '',
    nomorBpj: r['Nomor BPJ'] || '',
    tanggalStatus: r['Tanggal Status'] || '',
    catatanStatus: r['Catatan Status'] || ''
  };
}

/* ------------------------------------------------------- */
/* Sorting (generic, used by all three tables)                */
/* ------------------------------------------------------- */
function compareGeneric(va, vb) {
  const aNull = va === null || va === undefined || va === '';
  const bNull = vb === null || vb === undefined || vb === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;   // baris kosong selalu di akhir
  if (bNull) return -1;
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), 'id', { sensitivity: 'base', numeric: true });
}

// Nilai sort untuk baris data record (dipakai di tabel Data SPPP & Dashboard)
function getRecordSortValue(r, key) {
  switch (key) {
    case 'nomorSppp': return r.nomorSppp;
    case 'namaPenumpang': return r.namaPenumpang;
    case 'deskripsiBarang': return r.deskripsiBarang;
    case 'flight': return r.flight;
    case 'posisi': return r.posisi;
    case 'tanggalDokumen': {
      const d = parseDate(r.tanggalDokumen);
      return d ? d.getTime() : null;
    }
    case 'sisaWaktu': {
      const dl = slaInfo(r.tanggalDokumen).daysLeft;
      return dl === null ? null : dl;
    }
    case 'status': return STATUS_LABELS[r.status] || r.status;
    default: return null;
  }
}

function sortRecords(records, sortState) {
  if (!sortState.key) return records;
  const dir = sortState.dir === 'desc' ? -1 : 1;
  return [...records].sort((a, b) =>
    dir * compareGeneric(getRecordSortValue(a, sortState.key), getRecordSortValue(b, sortState.key))
  );
}

function wireSortableHeaders(tableId, sortStateKey, onSortChange) {
  const table = document.getElementById(tableId);
  table.querySelectorAll('thead th[data-sort]').forEach(th => {
    // bungkus isi teks header dengan label + ikon panah, sekali saja
    if (!th.querySelector('.th-label')) {
      const label = th.textContent;
      th.innerHTML = `<span class="th-label">${label}<span class="sort-icon">&#8645;</span></span>`;
    }
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const s = state.sort[sortStateKey];
      if (s.key === key) {
        s.dir = s.dir === 'asc' ? 'desc' : 'asc';
      } else {
        s.key = key;
        s.dir = 'asc';
      }
      updateSortIndicators(tableId, sortStateKey);
      onSortChange();
    });
  });
  updateSortIndicators(tableId, sortStateKey);
}

function updateSortIndicators(tableId, sortStateKey) {
  const s = state.sort[sortStateKey];
  const table = document.getElementById(tableId);
  table.querySelectorAll('thead th[data-sort]').forEach(th => {
    const icon = th.querySelector('.sort-icon');
    const active = th.dataset.sort === s.key;
    th.classList.toggle('sort-active', active);
    if (icon) icon.innerHTML = active ? (s.dir === 'asc' ? '&#9650;' : '&#9660;') : '&#8645;';
  });
}

/* ------------------------------------------------------- */
/* Filters                                                    */
/* ------------------------------------------------------- */
function applyFilters() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const statusF = document.getElementById('filterStatus').value;
  const slaF = document.getElementById('filterSla').value;

  let rows = state.data.filter(r => {
    if (q) {
      const hay = `${r.nomorSppp} ${r.namaPenumpang} ${r.deskripsiBarang}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (statusF && r.status !== statusF) return false;
    if (slaF) {
      const info = slaInfo(r.tanggalDokumen);
      if (info.cls !== slaF) return false;
    }
    return true;
  });

  if (state.sort.main.key) {
    rows = sortRecords(rows, state.sort.main);
  } else {
    // urutan bawaan: sisa waktu paling sedikit dulu
    rows.sort((a, b) => {
      const da = slaInfo(a.tanggalDokumen).daysLeft;
      const db = slaInfo(b.tanggalDokumen).daysLeft;
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    });
  }
  state.filtered = rows;
  state.pagination.currentPage = 1;
  renderMainTable();
}

/* ------------------------------------------------------- */
/* Render: Data SPPP table                                   */
/* ------------------------------------------------------- */
function renderMainTable() {
  const tbody = document.querySelector('#mainTable tbody');
  const emptyEl = document.getElementById('mainEmpty');
  tbody.innerHTML = '';

  if (!state.filtered.length) {
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
    const { currentPage, itemsPerPage } = state.pagination;
    const start = (currentPage - 1) * itemsPerPage;
    const end = start + itemsPerPage;
    const pageData = state.filtered.slice(start, end);
    
    for (const r of pageData) {
      tbody.appendChild(buildRow(r, true));
    }
  }
  document.getElementById('rowCount').textContent = `${state.filtered.length} baris`;
  renderPagination();
}

function renderPagination() {
  const paginationEl = document.getElementById('pagination');
  paginationEl.innerHTML = '';
  
  if (state.filtered.length === 0) return;
  
  const { currentPage, itemsPerPage } = state.pagination;
  const totalPages = Math.ceil(state.filtered.length / itemsPerPage);
  
  if (totalPages <= 1) return;
  
  const container = document.createElement('div');
  container.className = 'pagination-controls';
  
  // Previous button
  const prevBtn = document.createElement('button');
  prevBtn.className = 'pagination-btn';
  prevBtn.textContent = '← Sebelumnya';
  prevBtn.disabled = currentPage === 1;
  prevBtn.addEventListener('click', () => {
    if (currentPage > 1) {
      state.pagination.currentPage--;
      renderMainTable();
      document.querySelector('#mainTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  container.appendChild(prevBtn);
  
  // Page info
  const pageInfo = document.createElement('span');
  pageInfo.className = 'pagination-info';
  pageInfo.textContent = `Halaman ${currentPage} dari ${totalPages}`;
  container.appendChild(pageInfo);
  
  // Next button
  const nextBtn = document.createElement('button');
  nextBtn.className = 'pagination-btn';
  nextBtn.textContent = 'Berikutnya →';
  nextBtn.disabled = currentPage === totalPages;
  nextBtn.addEventListener('click', () => {
    if (currentPage < totalPages) {
      state.pagination.currentPage++;
      renderMainTable();
      document.querySelector('#mainTable').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });
  container.appendChild(nextBtn);
  
  paginationEl.appendChild(container);
}

function buildRow(r, withActions) {
  const tr = document.createElement('tr');
  const info = slaInfo(r.tanggalDokumen);
  if (info.cls === 'warn') tr.classList.add('row-warn');
  if (info.cls === 'danger') tr.classList.add('row-danger');

  const badgeCls = info.cls === 'ok' ? 'badge-ok' : info.cls === 'warn' ? 'badge-warn' : info.cls === 'danger' ? 'badge-danger' : 'badge-neutral';

  tr.innerHTML = `
    <td class="cell-mono">${escapeHtml(r.nomorSppp)}</td>
    <td>${escapeHtml(r.namaPenumpang)}</td>
    <td>${escapeHtml(truncate(r.deskripsiBarang, 60))}</td>
    <td class="cell-muted">${escapeHtml(r.flight)}</td>
    <td class="cell-muted">${escapeHtml(r.posisi)}</td>
    <td class="cell-mono">${escapeHtml(formatDisplayDate(r.tanggalDokumen))}</td>
    <td><span class="badge ${badgeCls}"><span class="badge-dot"></span>${info.text}</span></td>
    <td><span class="status-pill ${statusClass(r.status)}">${STATUS_LABELS[r.status] || r.status}</span></td>
    <td></td>
  `;

  const actionsTd = tr.querySelector('td:last-child');
  const wrap = document.createElement('div');
  wrap.className = 'row-actions';

  const viewBtn = document.createElement('button');
  viewBtn.className = 'icon-btn';
  viewBtn.title = 'Lihat detail';
  viewBtn.textContent = '👁';
  viewBtn.addEventListener('click', () => openViewModal(r));
  wrap.appendChild(viewBtn);

  if (withActions) {
    const actionBtn = document.createElement('button');
    actionBtn.className = 'icon-btn';
    actionBtn.title = 'Ubah status';
    actionBtn.textContent = '⋯';
    actionBtn.addEventListener('click', () => openActionChoiceModal(r));
    wrap.appendChild(actionBtn);
  }
  actionsTd.appendChild(wrap);
  return tr;
}

/* ------------------------------------------------------- */
/* Render: Dashboard                                          */
/* ------------------------------------------------------- */
function renderDashboard() {
  const active = state.data.filter(r => r.status === 'IN');
  let warnCount = 0, dangerCount = 0;
  for (const r of active) {
    const info = slaInfo(r.tanggalDokumen);
    if (info.cls === 'warn') warnCount++;
    if (info.cls === 'danger') dangerCount++;
  }
  const now = new Date();
  const doneThisMonth = state.data.filter(r => {
    if (r.status === 'IN' || !r.tanggalStatus) return false;
    const d = parseDate(r.tanggalStatus);
    return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
  }).length;

  document.getElementById('statActive').textContent = active.length;
  document.getElementById('statWarn').textContent = warnCount;
  document.getElementById('statDanger').textContent = dangerCount;
  document.getElementById('statDoneMonth').textContent = doneThisMonth;

  let urgentRows = active.filter(r => {
    const cls = slaInfo(r.tanggalDokumen).cls;
    return cls === 'warn' || cls === 'danger';
  });

  if (state.sort.urgent.key) {
    urgentRows = sortRecords(urgentRows, state.sort.urgent);
  } else {
    urgentRows.sort((a, b) => slaInfo(a.tanggalDokumen).daysLeft - slaInfo(b.tanggalDokumen).daysLeft);
  }
  urgentRows = urgentRows.slice(0, 15);

  const tbody = document.querySelector('#urgentTable tbody');
  const emptyEl = document.getElementById('urgentEmpty');
  tbody.innerHTML = '';
  if (!urgentRows.length) {
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
    for (const r of urgentRows) tbody.appendChild(buildRow(r, true));
  }
}

/* ------------------------------------------------------- */
/* Render: Laporan                                            */
/* ------------------------------------------------------- */
function renderReport() {
  const buckets = {}; // 'YYYY-MM' -> counts
  for (const r of state.data) {
    const d = parseDate(r.tanggalDokumen);
    if (!d) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!buckets[key]) buckets[key] = { total: 0, DIBAYAR: 0, 'IMPOR SEMENTARA': 0, 'GESER KE TPP': 0, REEKSPOR: 0, 'LAIN-LAIN': 0, IN: 0 };
    buckets[key].total++;
    buckets[key][r.status] = (buckets[key][r.status] || 0) + 1;
  }
  const monthNames = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  let reportRows = Object.keys(buckets).map(key => {
    const [y, m] = key.split('-');
    const b = buckets[key];
    return {
      monthKey: key,
      bulan: `${monthNames[parseInt(m, 10) - 1]} ${y}`,
      total: b.total,
      'DIBAYAR': b.DIBAYAR,
      'IMPOR SEMENTARA': b['IMPOR SEMENTARA'],
      'GESER KE TPP': b['GESER KE TPP'],
      'REEKSPOR': b.REEKSPOR,
      'LAIN-LAIN': b['LAIN-LAIN'],
      'IN': b.IN
    };
  });

  const rs = state.sort.report;
  if (rs.key) {
    const dir = rs.dir === 'desc' ? -1 : 1;
    reportRows.sort((a, b) => {
      const va = rs.key === 'bulan' ? a.monthKey : a[rs.key];
      const vb = rs.key === 'bulan' ? b.monthKey : b[rs.key];
      return dir * compareGeneric(va, vb);
    });
  } else {
    reportRows.sort((a, b) => a.monthKey.localeCompare(b.monthKey));
  }

  const tbody = document.querySelector('#reportTable tbody');
  tbody.innerHTML = '';
  for (const b of reportRows) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${b.bulan}</td>
      <td class="cell-mono">${b.total}</td>
      <td class="cell-mono">${b.DIBAYAR}</td>
      <td class="cell-mono">${b['IMPOR SEMENTARA']}</td>
      <td class="cell-mono">${b['GESER KE TPP']}</td>
      <td class="cell-mono">${b.REEKSPOR}</td>
      <td class="cell-mono">${b['LAIN-LAIN']}</td>
      <td class="cell-mono">${b.IN}</td>
    `;
    tbody.appendChild(tr);
  }

  // status composition bar chart
  const totals = { IN: 0, DIBAYAR: 0, 'IMPOR SEMENTARA': 0, 'GESER KE TPP': 0, REEKSPOR: 0, 'LAIN-LAIN': 0 };
  for (const r of state.data) totals[r.status] = (totals[r.status] || 0) + 1;
  const grand = state.data.length || 1;
  const colors = {
    IN: '#16a34a', DIBAYAR: '#2563eb', 'IMPOR SEMENTARA': '#0e7490',
    'GESER KE TPP': '#c2410c', REEKSPOR: '#6d28d9', 'LAIN-LAIN': '#64748b'
  };
  const barsEl = document.getElementById('statusBars');
  barsEl.innerHTML = '';
  for (const key of Object.keys(totals)) {
    const pct = Math.round((totals[key] / grand) * 100);
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span>${STATUS_LABELS[key]}</span>
      <span class="bar-track"><span class="bar-fill" style="width:${pct}%;background:${colors[key]}"></span></span>
      <span class="cell-mono">${totals[key]} (${pct}%)</span>
    `;
    barsEl.appendChild(row);
  }
}

/* ------------------------------------------------------- */
/* Modal: View detail                                         */
/* ------------------------------------------------------- */
function openViewModal(r) {
  const info = slaInfo(r.tanggalDokumen);
  const body = document.getElementById('viewBody');
  body.innerHTML = `
    <div class="view-grid">
      <div class="view-item"><span class="k">Nomor SPPP</span><span class="v">${escapeHtml(r.nomorSppp)}</span></div>
      <div class="view-item"><span class="k">Status</span><span class="v"><span class="status-pill ${statusClass(r.status)}">${STATUS_LABELS[r.status] || r.status}</span></span></div>
      <div class="view-item"><span class="k">Nama Penumpang</span><span class="v">${escapeHtml(r.namaPenumpang)}</span></div>
      <div class="view-item"><span class="k">No Paspor</span><span class="v">${escapeHtml(r.noPaspor) || '—'}</span></div>
      <div class="view-item wide"><span class="k">Deskripsi Barang</span><span class="v">${escapeHtml(r.deskripsiBarang)}</span></div>
      <div class="view-item"><span class="k">No Flight / Negara Asal</span><span class="v">${escapeHtml(r.flight) || '—'}</span></div>
      <div class="view-item"><span class="k">Jumlah / Berat</span><span class="v">${escapeHtml(r.jumlah) || '—'}</span></div>
      <div class="view-item"><span class="k">Posisi Barang</span><span class="v">${escapeHtml(r.posisi) || '—'}</span></div>
      <div class="view-item"><span class="k">Admin</span><span class="v">${escapeHtml(r.admin) || '—'}</span></div>
      <div class="view-item"><span class="k">Tanggal Dokumen SPPP</span><span class="v">${formatDisplayDate(r.tanggalDokumen) || '—'}</span></div>
      <div class="view-item"><span class="k">Sisa Masa Simpan</span><span class="v">${info.text}${info.deadline ? ' (jatuh tempo ' + formatDisplayDate(info.deadline) + ')' : ''}</span></div>
      <div class="view-item wide"><span class="k">Keterangan Tambahan</span><span class="v">${escapeHtml(r.keterangan) || '—'}</span></div>
      <div class="view-item"><span class="k">Info Kontak</span><span class="v">${escapeHtml(r.kontak) || '—'}</span></div>
      <div class="view-item"><span class="k">Dokumentasi</span><span class="v">${r.dokumentasi ? linkify(r.dokumentasi) : '—'}</span></div>
      <div class="view-divider"></div>
      <div class="view-item"><span class="k">Nomor Dokumen Status</span><span class="v">${escapeHtml(r.nomorDokumenStatus) || '—'}</span></div>
      <div class="view-item"><span class="k">Nomor BPJ</span><span class="v">${escapeHtml(r.nomorBpj) || '—'}</span></div>
      <div class="view-item"><span class="k">Tanggal Status</span><span class="v">${formatDisplayDate(r.tanggalStatus) || '—'}</span></div>
      <div class="view-item wide"><span class="k">Catatan Status</span><span class="v">${escapeHtml(r.catatanStatus) || '—'}</span></div>
    </div>
  `;
  openModal('modalView');
}

/* ------------------------------------------------------- */
/* Modal: Action choice + detail                              */
/* ------------------------------------------------------- */
function openActionChoiceModal(r) {
  state.pendingActionRow = r;
  document.getElementById('actionChoiceLabel').textContent =
    `${r.nomorSppp} — ${r.namaPenumpang}. Pilih tindakan penyelesaian:`;
  openModal('modalActionChoice');
}

document.addEventListener('click', (e) => {
  const choiceBtn = e.target.closest('.action-choice');
  if (choiceBtn) {
    const status = choiceBtn.dataset.status;
    closeModal('modalActionChoice');
    openActionDetailModal(status);
  }
});

function openActionDetailModal(status) {
  state.pendingActionStatus = status;
  const r = state.pendingActionRow;
  document.getElementById('actionDetailTitle').textContent =
    `${STATUS_LABELS[status]} — ${r.nomorSppp}`;

  const container = document.getElementById('actionDetailFields');
  container.innerHTML = '';
  const fields = ACTION_FIELDS[status];
  for (const f of fields) {
    const wrap = document.createElement('label');
    wrap.className = 'field field-wide';
    const inputHtml = f.type === 'date'
      ? `<input type="date" class="input" id="af_${f.key}" value="${toISODate(new Date())}">`
      : `<input type="text" class="input" id="af_${f.key}" placeholder="${f.placeholder || ''}">`;
    wrap.innerHTML = `<span>${f.label}</span>${inputHtml}`;
    container.appendChild(wrap);
  }
  openModal('modalActionDetail');
}

document.getElementById('btnSaveActionDetail').addEventListener('click', async () => {
  const status = state.pendingActionStatus;
  const r = state.pendingActionRow;
  const fields = ACTION_FIELDS[status];
  const payload = { action: 'updateStatus', nomorSppp: r.nomorSppp, status };

  for (const f of fields) {
    const val = document.getElementById(`af_${f.key}`).value.trim();
    if (!val) {
      showToast(`${f.label} wajib diisi.`, 'error');
      return;
    }
    payload[f.key] = val;
  }

  try {
    await apiPost(payload);
    showToast('Status berhasil diperbarui.', 'success');
    closeModal('modalActionDetail');
    await refreshData();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

/* ------------------------------------------------------- */
/* Modal: Tambah data                                         */
/* ------------------------------------------------------- */
document.getElementById('btnAdd').addEventListener('click', () => {
  for (const id of ['addNomorSppp','addNama','addPaspor','addDeskripsi','addFlight','addJumlah','addPosisi','addAdmin','addKeterangan','addKontak']) {
    document.getElementById(id).value = '';
  }
  document.getElementById('addTanggal').value = toISODate(new Date());
  openModal('modalAdd');
});

document.getElementById('btnSaveAdd').addEventListener('click', async () => {
  const nomorSppp = document.getElementById('addNomorSppp').value.trim();
  const tanggal = document.getElementById('addTanggal').value;
  const nama = document.getElementById('addNama').value.trim();
  const deskripsi = document.getElementById('addDeskripsi').value.trim();

  if (!nomorSppp || !tanggal || !nama || !deskripsi) {
    showToast('Nomor SPPP, Tanggal, Nama, dan Deskripsi Barang wajib diisi.', 'error');
    return;
  }

  const payload = {
    action: 'create',
    nomorSppp,
    tanggalDokumen: tanggal,
    namaPenumpang: nama,
    noPaspor: document.getElementById('addPaspor').value.trim(),
    deskripsiBarang: deskripsi,
    flight: document.getElementById('addFlight').value.trim(),
    jumlah: document.getElementById('addJumlah').value.trim(),
    posisi: document.getElementById('addPosisi').value.trim(),
    admin: document.getElementById('addAdmin').value.trim(),
    keterangan: document.getElementById('addKeterangan').value.trim(),
    kontak: document.getElementById('addKontak').value.trim()
  };

  try {
    await apiPost(payload);
    showToast('Data SPPP baru berhasil disimpan.', 'success');
    closeModal('modalAdd');
    await refreshData();
  } catch (err) {
    showToast(err.message, 'error');
  }
});

/* ------------------------------------------------------- */
/* Modal helpers                                              */
/* ------------------------------------------------------- */
function openModal(id) { document.getElementById(id).hidden = false; }
function closeModal(id) { document.getElementById(id).hidden = true; }

document.addEventListener('click', (e) => {
  if (e.target.matches('[data-close]') || e.target.closest('[data-close]')) {
    const overlay = e.target.closest('.modal-overlay');
    if (overlay) overlay.hidden = true;
  }
  if (e.target.classList && e.target.classList.contains('modal-overlay')) {
    e.target.hidden = true;
  }
});

/* ------------------------------------------------------- */
/* Settings modal                                             */
/* ------------------------------------------------------- */
document.getElementById('btnSettings').addEventListener('click', () => {
  document.getElementById('cfgUrl').value = state.config.url;
  document.getElementById('cfgToken').value = state.config.token;
  openModal('modalSettings');
});
document.getElementById('btnSaveSettings').addEventListener('click', async () => {
  const url = document.getElementById('cfgUrl').value.trim();
  const token = document.getElementById('cfgToken').value.trim();
  if (!url || !token) {
    showToast('URL dan Token wajib diisi.', 'error');
    return;
  }
  saveConfig(url, token);
  closeModal('modalSettings');
  await refreshData();
});

/* ------------------------------------------------------- */
/* Tabs                                                       */
/* ------------------------------------------------------- */
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

/* ------------------------------------------------------- */
/* Filters wiring                                             */
/* ------------------------------------------------------- */
document.getElementById('searchInput').addEventListener('input', applyFilters);
document.getElementById('filterStatus').addEventListener('change', applyFilters);
document.getElementById('filterSla').addEventListener('change', applyFilters);
document.getElementById('btnRefresh').addEventListener('click', refreshData);

/* ------------------------------------------------------- */
/* Utils                                                      */
/* ------------------------------------------------------- */
function escapeHtml(s) {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}
function formatDisplayDate(val) {
  const d = parseDate(val);
  if (!d) return '';
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}-${mm}-${d.getFullYear()}`;
}
function linkify(text) {
  return String(text).split(',').map(u => u.trim()).filter(Boolean)
    .map((u, i) => `<a href="${escapeHtml(u)}" target="_blank" rel="noopener">Lampiran ${i + 1}</a>`)
    .join(' · ');
}

/* ------------------------------------------------------- */
/* Sortable headers wiring                                    */
/* ------------------------------------------------------- */
wireSortableHeaders('mainTable', 'main', applyFilters);
wireSortableHeaders('urgentTable', 'urgent', renderDashboard);
wireSortableHeaders('reportTable', 'report', renderReport);

/* ------------------------------------------------------- */
/* Init                                                       */
/* ------------------------------------------------------- */
loadConfig();
if (state.config.url && state.config.token) {
  refreshData();
} else {
  document.getElementById('syncStatus').textContent = 'Belum terhubung';
  setTimeout(() => openModal('modalSettings'), 300);
}