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
  pendingActionStatus: null
};

// Hardcode URL Apps Script Anda di sini
const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbzDn2_ZiN8kw61unXXsshkrF3DM1e3NrAFAmjisPDVt3YFGkbpPIDxsHFObid4uy-Ft9w/exec"; 

/**
 * Generates a SHA-256 hash from a username and password combination.
 */
async function generateHashToken(username, password) {
    const dataString = username.toLowerCase().trim() + ":" + password;
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(dataString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBytes);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

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
  syncEl.textContent = 'Memuat...';
  try {
    const raw = await apiGet();
    state.data = raw.map(normalizeRecord);
    applyFilters();
    renderDashboard();
    renderReport();
    syncEl.textContent = `Tersinkron • ${new Date().toLocaleTimeString('id-ID')}`;
  } catch (err) {
    syncEl.textContent = 'Gagal memuat data';
    showToast(err.message, 'error');
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
/* Filters                                                    */
/* ------------------------------------------------------- */
function applyFilters() {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  const statusF = document.getElementById('filterStatus').value;
  const slaF = document.getElementById('filterSla').value;

  state.filtered = state.data.filter(r => {
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
  state.filtered.sort((a, b) => {
    const da = slaInfo(a.tanggalDokumen).daysLeft;
    const db = slaInfo(b.tanggalDokumen).daysLeft;
    if (da === null) return 1;
    if (db === null) return -1;
    return da - db;
  });
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
    for (const r of state.filtered) {
      tbody.appendChild(buildRow(r, true));
    }
  }
  document.getElementById('rowCount').textContent = `${state.filtered.length} baris`;
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

  const urgent = active
    .map(r => ({ r, info: slaInfo(r.tanggalDokumen) }))
    .filter(x => x.info.cls === 'warn' || x.info.cls === 'danger')
    .sort((a, b) => a.info.daysLeft - b.info.daysLeft)
    .slice(0, 15);

  const tbody = document.querySelector('#urgentTable tbody');
  const emptyEl = document.getElementById('urgentEmpty');
  tbody.innerHTML = '';
  if (!urgent.length) {
    emptyEl.hidden = false;
  } else {
    emptyEl.hidden = true;
    for (const x of urgent) tbody.appendChild(buildRow(x.r, true));
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
  const months = Object.keys(buckets).sort();
  const tbody = document.querySelector('#reportTable tbody');
  tbody.innerHTML = '';
  const monthNames = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
  for (const key of months) {
    const [y, m] = key.split('-');
    const label = `${monthNames[parseInt(m, 10) - 1]} ${y}`;
    const b = buckets[key];
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${label}</td>
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
/* Settings modal (Login)                                  */
/* ------------------------------------------------------- */
document.getElementById('btnSettings').addEventListener('click', () => {
  // Clear the inputs every time the modal opens for security
  document.getElementById('inputUsername').value = '';
  document.getElementById('inputPassword').value = '';
  openModal('modalSettings');
});

document.getElementById('btnSaveSettings').addEventListener('click', async () => {
  const username = document.getElementById('inputUsername').value.trim();
  const password = document.getElementById('inputPassword').value;
  
  if (!username || !password) {
    showToast('Username dan Password wajib diisi.', 'error');
    return;
  }

  const submitBtn = document.getElementById('btnSaveSettings');
  submitBtn.innerText = "Memverifikasi...";
  submitBtn.disabled = true;

  try {
    // Generate the secure hash token
    const hashedToken = await generateHashToken(username, password);
    
    // Save the hardcoded URL and the generated hash
    saveConfig(APPS_SCRIPT_URL, hashedToken);
    
    closeModal('modalSettings');
    await refreshData();
    
  } catch (err) {
    showToast('Terjadi kesalahan saat memproses login.', 'error');
  } finally {
    submitBtn.innerText = "Login & Muat Data";
    submitBtn.disabled = false;
  }
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

/**
 * Generates a SHA-256 hash from a username and password combination.
 */
async function generateHashToken(username, password) {
    // 1. Combine and standardize the inputs (lowercase username to prevent case-sensitivity issues)
    const dataString = username.toLowerCase().trim() + ":" + password;
    
    // 2. Encode the string into a byte array
    const encoder = new TextEncoder();
    const dataBytes = encoder.encode(dataString);
    
    // 3. Generate the SHA-256 hash using the Web Crypto API
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBytes);
    
    // 4. Convert the ArrayBuffer to a readable Hex string
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return hashHex;
}


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
