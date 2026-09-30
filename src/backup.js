'use strict';
// Cadangan & pemulihan satu instance: pengaturan (config.json), basis data, dan wallet.
//
// Satu berkas JSON, isinya dipilih pengguna:
//   config  — config.json APA ADANYA DI DISK: nilai dari .env sudah berbentuk ${NAMA}
//             (writeCfg), jadi rahasia di .env tidak ikut. Rahasia yang diketik lewat
//             dasbor (API key RPC, token Telegram) memang ada di config.json dan ikut.
//   db      — salinan basis data (sqlite backup API, tidak mengunci mesin) TANPA tabel
//             rpc_cache: 90%+ ukuran berkasnya, cuma cache yang terisi lagi sendiri.
//             Di-gzip lalu base64.
//   wallet  — keystore V3 terenkripsi password, sama dengan ekspor wallet. Kunci privat
//             mentah tidak pernah masuk berkas.
//
// Pemulihan config & db TIDAK ditimpa di tempat: proses yang sedang jalan memegang
// koneksi basis data dan salinan config di memori (yang ditulis balik oleh rute lain).
// Berkasnya ditaruh sebagai <berkas>.restore-pending, lalu ditukar saat boot oleh
// applyPendingRestore() sebelum apa pun membukanya. Berkas lama tidak dihapus: dipindah
// ke <nama>.pre-restore-<waktu>.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { promisify } = require('node:util');
const { Worker } = require('node:worker_threads');
const sqlite = require('node:sqlite');

const FORMAT = 'quiver-backup';
const VERSION = 1;
const PENDING = '.restore-pending';
const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');

// Buang rpc_cache lalu VACUUM, di worker: DatabaseSync itu sinkron, dan VACUUM berkas
// ~100 MB di thread utama menahan loop mesin (pemindaian blok, keluar posisi) sedetik lebih.
// `check` = hanya periksa berkas hasil unggahan (integrity + tabel wajib).
const WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(workerData.file);
try {
  const out = {};
  if (workerData.check) {
    const ok = db.prepare('PRAGMA quick_check').get();
    out.check = Object.values(ok || {})[0];
  } else {
    db.exec('DROP TABLE IF EXISTS rpc_cache');
    db.exec('VACUUM');
  }
  const has = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
  out.tables = { positions: has('positions'), state: has('state') };
  const n = (sql) => { try { return db.prepare(sql).get().n; } catch { return null; } };
  out.stats = {
    positions: n('SELECT COUNT(*) n FROM positions'),
    open: n("SELECT COUNT(*) n FROM positions WHERE status='open'"),
    targets: n('SELECT COUNT(*) n FROM targets'),
    lastTs: n('SELECT MAX(ts) n FROM logs'),
  };
  parentPort.postMessage(out);
} finally { db.close(); }
`;
function inWorker(data) {
  return new Promise((resolve, reject) => {
    const w = new Worker(WORKER, { eval: true, workerData: data });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (c) => { if (c) reject(new Error(`worker keluar ${c}`)); });
  });
}

// Salinan basis data yang siap dikemas. `db` = koneksi DatabaseSync yang sedang dipakai.
async function snapshotDb(db, tmpDir) {
  const tmp = path.join(tmpDir, `backup-${process.pid}-${Date.now()}.db`);
  try {
    await sqlite.backup(db, tmp);
    const info = await inWorker({ file: tmp });
    const raw = await fs.promises.readFile(tmp);
    const gz = await gzip(raw, { level: 9 });
    return {
      bytes: raw.length,
      sha256: crypto.createHash('sha256').update(raw).digest('hex'),
      stats: info.stats,
      gz: gz.toString('base64'),
    };
  } finally {
    for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`, `${tmp}-journal`]) fs.rmSync(f, { force: true });
  }
}

async function createBackup({ parts, cfgPath, db, dbPath, wallet, password, meta = {} }) {
  const out = { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(), ...meta, parts: {} };
  if (parts.config) out.parts.config = { json: JSON.parse(fs.readFileSync(cfgPath, 'utf8')) };
  if (parts.db) out.parts.db = await snapshotDb(db, path.dirname(dbPath));
  if (parts.wallet) {
    const keystore = JSON.parse(await wallet.encrypt(password));
    out.parts.wallet = { address: wallet.address.toLowerCase(), keystore };
  }
  return out;
}

// Pemeriksaan bentuk berkas. Tidak mempercayai isinya: berkas datang dari unggahan.
function parseBackup(b) {
  if (!b || typeof b !== 'object' || b.format !== FORMAT) throw new Error('Bukan berkas cadangan Quiver.');
  if (!Number.isInteger(b.version) || b.version > VERSION) throw new Error('Versi berkas cadangan lebih baru dari bot ini — perbarui bot dulu.');
  const p = b.parts || {};
  if (p.config && (typeof p.config.json !== 'object' || !p.config.json || Array.isArray(p.config.json))) throw new Error('Bagian pengaturan di berkas cadangan rusak.');
  if (p.db && (typeof p.db.gz !== 'string' || !/^[0-9a-f]{64}$/.test(p.db.sha256 || ''))) throw new Error('Bagian basis data di berkas cadangan rusak.');
  if (p.wallet && (typeof p.wallet.keystore !== 'object' || !p.wallet.keystore)) throw new Error('Bagian wallet di berkas cadangan rusak.');
  return b;
}

// Config hasil pulihan. Yang milik MESIN INI tetap dari config yang sekarang: pintu
// dasbor (port, host, token — memulihkan token lama bisa mengunci pengguna keluar),
// lokasi basis data dan berkas kunci. Mode selalu simulasi: berkas lama bisa saja
// dibuat saat LIVE, dan menyalakan transaksi sungguhan harus keputusan yang diketik.
function mergeConfig(restored, current) {
  const out = JSON.parse(JSON.stringify(restored));
  for (const k of ['server', 'db']) {
    if (current[k] !== undefined) out[k] = current[k]; else delete out[k];
  }
  if (current.wallet?.key_file !== undefined) out.wallet = { ...(out.wallet || {}), key_file: current.wallet.key_file };
  out.mode = { ...(out.mode || {}), dry_run: true };
  return out;
}

// Tulis bagian config/db sebagai berkas tertunda. Basis data diperiksa dulu (hash,
// integritas, tabel wajib) di berkas sementara, baru dipindah ke nama tertunda —
// berkas tertunda yang ada selalu utuh.
async function stageRestore({ backup, parts, cfgPath, dbPath }) {
  const staged = [];
  if (parts.db) {
    const raw = await gunzip(Buffer.from(backup.parts.db.gz, 'base64'));
    if (crypto.createHash('sha256').update(raw).digest('hex') !== backup.parts.db.sha256) throw new Error('Basis data di berkas cadangan rusak (hash tidak cocok).');
    const tmp = `${dbPath}.restore-tmp-${process.pid}`;
    try {
      await fs.promises.writeFile(tmp, raw, { mode: 0o600 });
      const info = await inWorker({ file: tmp, check: true });
      if (info.check !== 'ok') throw new Error(`Basis data di berkas cadangan rusak (${info.check}).`);
      if (!info.tables.positions || !info.tables.state) throw new Error('Berkas basis data bukan milik Quiver (tabel positions/state tidak ada).');
      fs.renameSync(tmp, dbPath + PENDING);
    } finally {
      for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) fs.rmSync(f, { force: true });
    }
    staged.push('db');
  }
  if (parts.config) {
    const current = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    fs.writeFileSync(cfgPath + PENDING, JSON.stringify(mergeConfig(backup.parts.config.json, current), null, 2), { mode: 0o600 });
    staged.push('config');
  }
  return staged;
}

// Dipanggil saat boot, sebelum berkasnya dibuka. Berkas yang sedang dipakai dipindah
// ke <nama>.pre-restore-<waktu><ext> (beserta -wal/-shm: isi terbaru basis data bisa
// masih di WAL, dan WAL hanya berlaku di sebelah berkas yang namanya sama).
function applyPendingRestore(file, log = () => {}) {
  const pending = file + PENDING;
  if (!fs.existsSync(pending)) return null;
  const ext = path.extname(file);
  const old = `${file.slice(0, file.length - ext.length)}.pre-restore-${stamp()}${ext}`;
  if (fs.existsSync(file)) {
    fs.renameSync(file, old);
    for (const s of ['-wal', '-shm']) if (fs.existsSync(file + s)) fs.renameSync(file + s, old + s);
  }
  fs.renameSync(pending, file);
  log(`pemulihan: ${path.basename(file)} diganti dari cadangan (yang lama: ${path.basename(old)})`);
  return old;
}

module.exports = { FORMAT, VERSION, createBackup, parseBackup, mergeConfig, stageRestore, applyPendingRestore };
