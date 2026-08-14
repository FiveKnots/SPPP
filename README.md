# Inventori Barang Penumpang (SPPP) — Panduan Singkat

## Isi paket
- `index.html`, `style.css`, `app.js` — front end (deploy ke Netlify)
- `Code.gs` — backend Google Apps Script (tempel ke Apps Script editor)
- `Database_SPPP_Clean.xlsx` — data historis yang sudah dibersihkan, siap di-import ke Google Sheets

## Langkah setup

1. **Google Sheets**
   - Buat spreadsheet baru, ganti nama tab pertama menjadi `Database`.
   - Buka `Database_SPPP_Clean.xlsx` → sheet `Database` → salin semua isinya (termasuk header) ke tab `Database` di Google Sheets. Urutan kolom A–Q sudah sesuai kebutuhan `Code.gs`.
   - Sheet `QC_Log` di file Excel berisi daftar 40 perbaikan data yang dilakukan (lihat bagian "Ringkasan pembersihan data" di bawah) — simpan sebagai arsip, tidak perlu diimpor ke sistem.

2. **Apps Script**
   - Di Google Sheets: **Extensions → Apps Script**.
   - Hapus kode bawaan, tempel isi `Code.gs`.
   - Ganti `SECRET_TOKEN` dengan kata sandi rahasia Anda sendiri.
   - **Deploy → New deployment → Web app** → Execute as: *Me*, Who has access: *Anyone* → Deploy → salin **Web App URL**.

3. **Netlify**
   - Masukkan `index.html`, `style.css`, `app.js` ke satu folder, drag-and-drop ke Netlify (Add new site → Deploy manually).
   - Buka situs → klik ikon ⚙️ (Pengaturan) → masukkan Web App URL dan Token → Simpan. Konfigurasi disimpan di browser (localStorage), tidak terkirim ke pihak lain.

## Ringkasan pembersihan data (Database_SPPP_Clean.xlsx)

Dari 1.605 baris mentah di `SPPP__Responses_.xlsx`, hanya **608 baris valid** (996 baris kosong di ekor sheet dibuang, 1 duplikat persis dihapus). Perbaikan yang dilakukan otomatis (38 dari 40 temuan, detail lengkap di sheet `QC_Log`):

- **Format tanggal tidak konsisten** — kolom `TGL ST` bercampur antara tipe *date* asli dan teks `DD/MM/YYYY`; semua dinormalisasi ke `YYYY-MM-DD`.
- **`Masa Simpan s.d.` tidak konsisten** — dihitung ulang sebagai `Tanggal Dokumen SPPP + 30 hari` agar seragam (beberapa baris asli meleset 1 hari atau kosong).
- **Nomor SPPP tidak konsisten** — kurang/lebih digit nol (`00046` → `000046`), karakter kutip liar di depan nomor (`'000109/...`), dan satu salah ketik tahun (`.../2025` → `.../2026`).
- **Salah ketik status** — `REESKPOR` dikoreksi menjadi `REEKSPOR`.
- **Tahun salah ketik di tanggal pembayaran** — beberapa `Tanggal Status` tertulis tahun 2025 padahal dokumennya tahun 2026 (terdeteksi karena tanggal pembayaran tidak boleh mendahului tanggal dokumen SPPP); dikoreksi ke tahun yang benar.
- **Status Barang (teks bebas)** diuraikan menjadi kolom terstruktur: `Status`, `Nomor Dokumen Status`, `Nomor BPJ`, `Tanggal Status`, dengan teks asli tetap disimpan di `Catatan Status` untuk ketertelusuran.

**2 hal butuh pengecekan manual** (tidak bisa diperbaiki otomatis karena datanya memang salah input di sumber, bukan sekadar salah format):
- Satu baris (an. Deng Tong Hui) mengisi kolom Nomor SPPP dengan nomor billing pembayaran, bukan nomor SPPP.
- Nomor `000350/SPPP/T3/SH/2026` dipakai untuk dua penumpang berbeda (Liu Xin dan Zhang Fang) — kemungkinan salah input nomor urut.
