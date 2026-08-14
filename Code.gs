/**
 * ==========================================================
 * Backend Apps Script — Inventori Barang Penumpang (SPPP)
 * ==========================================================
 * 1. Buat Google Sheet baru, tab pertama bernama persis: Database
 * 2. Baris 1 (header), kolom A sampai Q, PERSIS urutan berikut:
 *
 *  A: Nomor SPPP
 *  B: Tanggal Dokumen SPPP
 *  C: Nama Penumpang
 *  D: No Paspor
 *  E: Deskripsi Barang
 *  F: No Flight / Negara Asal
 *  G: Jumlah Barang / Berat
 *  H: Posisi Barang
 *  I: Admin
 *  J: Keterangan Tambahan
 *  K: Dokumentasi
 *  L: Info Kontak
 *  M: Status
 *  N: Nomor Dokumen Status
 *  O: Nomor BPJ
 *  P: Tanggal Status
 *  Q: Catatan Status
 *
 * 3. Import isi "Database_SPPP_Clean.xlsx" (sheet "Database") ke tab ini
 *    untuk mengisi data historis yang sudah dibersihkan.
 * 4. Ganti SECRET_TOKEN di bawah, lalu Deploy > New deployment > Web app
 *    (Execute as: Me, Who has access: Anyone).
 * ==========================================================
 */

const SECRET_TOKEN = "KunciRahasiaKantor123!"; // GANTI dengan kata sandi rahasia Anda
const SHEET_NAME = "Database";

const COLUMNS = [
  "Nomor SPPP", "Tanggal Dokumen SPPP", "Nama Penumpang", "No Paspor",
  "Deskripsi Barang", "No Flight / Negara Asal", "Jumlah Barang / Berat",
  "Posisi Barang", "Admin", "Keterangan Tambahan", "Dokumentasi", "Info Kontak",
  "Status", "Nomor Dokumen Status", "Nomor BPJ", "Tanggal Status", "Catatan Status"
];

function jsonOutput(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function getSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
}

function checkToken(token) {
  return token === SECRET_TOKEN;
}

/* ---------------- GET: list all records ---------------- */
function doGet(e) {
  if (!checkToken(e.parameter.token)) {
    return jsonOutput({ status: "error", message: "Akses Ditolak" });
  }

  const sheet = getSheet();
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const rows = data.slice(1).filter(row => row[0] !== ""); // skip blank rows

  const result = rows.map(row => {
    const obj = {};
    headers.forEach((header, i) => {
      const val = row[i];
      obj[header] = (val instanceof Date)
        ? Utilities.formatDate(val, Session.getScriptTimeZone(), "yyyy-MM-dd")
        : val;
    });
    return obj;
  });

  return jsonOutput(result);
}

/* ---------------- POST: create / updateStatus ---------------- */
function doPost(e) {
  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return jsonOutput({ status: "error", message: "Payload tidak valid" });
  }

  if (!checkToken(body.token)) {
    return jsonOutput({ status: "error", message: "Akses Ditolak" });
  }

  if (body.action === "create") return handleCreate(body);
  if (body.action === "updateStatus") return handleUpdateStatus(body);

  return jsonOutput({ status: "error", message: "Aksi tidak dikenal" });
}

function handleCreate(body) {
  const sheet = getSheet();

  // cegah duplikat Nomor SPPP
  const existing = sheet.getRange(2, 1, Math.max(sheet.getLastRow() - 1, 0), 1).getValues().flat();
  if (existing.indexOf(body.nomorSppp) !== -1) {
    return jsonOutput({ status: "error", message: "Nomor SPPP sudah terdaftar" });
  }

  sheet.appendRow([
    body.nomorSppp || "",
    body.tanggalDokumen || "",
    body.namaPenumpang || "",
    body.noPaspor || "",
    body.deskripsiBarang || "",
    body.flight || "",
    body.jumlah || "",
    body.posisi || "",
    body.admin || "",
    body.keterangan || "",
    body.dokumentasi || "",
    body.kontak || "",
    "IN",   // Status default: masih di TPS
    "", "", "", ""
  ]);

  return jsonOutput({ status: "success", message: "Data berhasil disimpan!" });
}

function handleUpdateStatus(body) {
  const sheet = getSheet();
  const values = sheet.getDataRange().getValues();
  const headers = values[0];
  const colIndex = {};
  headers.forEach((h, i) => { colIndex[h] = i; });

  let targetRow = -1;
  for (let r = 1; r < values.length; r++) {
    if (values[r][colIndex["Nomor SPPP"]] === body.nomorSppp) {
      targetRow = r + 1; // sheet is 1-indexed
      break;
    }
  }
  if (targetRow === -1) {
    return jsonOutput({ status: "error", message: "Nomor SPPP tidak ditemukan" });
  }

  sheet.getRange(targetRow, colIndex["Status"] + 1).setValue(body.status || "");
  sheet.getRange(targetRow, colIndex["Nomor Dokumen Status"] + 1).setValue(body.nomorDokumenStatus || "");
  sheet.getRange(targetRow, colIndex["Nomor BPJ"] + 1).setValue(body.nomorBpj || "");
  sheet.getRange(targetRow, colIndex["Tanggal Status"] + 1).setValue(body.tanggalStatus || "");
  if (body.catatanStatus) {
    sheet.getRange(targetRow, colIndex["Catatan Status"] + 1).setValue(body.catatanStatus);
  }

  return jsonOutput({ status: "success", message: "Status berhasil diperbarui" });
}
