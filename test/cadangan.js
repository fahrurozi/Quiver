'use strict';
// Uji: cadangan & pemulihan (Pengaturan → Cadangan).
//
// Yang dijaga: berkas cadangan hanya keluar dengan token yang diketik ulang; basis data
// ikut utuh tanpa rpc_cache; wallet hanya sebagai keystore terenkripsi; pemulihan
// tidak menimpa berkas yang sedang dipakai (ditaruh tertunda, ditukar saat boot, yang
// lama disimpan); kegagalan di tengah tidak meninggalkan berkas tertunda setengah jadi;
// config hasil pulihan tidak mengambil alih port/token server ini dan selalu simulasi.
//
// Jalankan: node test/cadangan.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const { Store } = require('../src/db');
const { createSettingsRoutes } = require('../src/settings');
const { applyPendingRestore, parseBackup } = require('../src/backup');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

// Satu instance lengkap di direktori sementara: config.json, basis data, berkas kunci.
function instance({ token = 'tok-rahasia', port = 20180, pk = ethers.Wallet.createRandom().privateKey, live = false, positions = 3 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-cadangan-'));
  const cfgPath = path.join(dir, 'config.json');
  const dbPath = path.join(dir, 'data', 'lpcopy.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const cfg = {
    server: { port, auth_token: token }, db: { path: dbPath }, wallet: { key_file: path.join(dir, 'data', 'wallet.key') },
    mode: { dry_run: !live }, chains: { robinhood: { enabled: true, rules: { tag: `aturan-${port}` } } },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  const keyPath = cfg.wallet.key_file;
  if (pk) fs.writeFileSync(keyPath, pk, { mode: 0o600 });
  const store = new Store(dbPath);
  for (let i = 0; i < positions; i++) {
    store.run(`INSERT INTO positions(venue,pool_ref,token_id,token0,token1,tick_lower,tick_upper,status,opened_ts,cost_quote,quote_symbol,liquidity)
      VALUES('v4','0xpool',?,'0xa','0xb',-100,100,?,?,100,'USDG','1')`, String(1000 + i), i === 0 ? 'open' : 'closed', Date.now());
  }
  store.run(`INSERT INTO rpc_cache(chain,k,method,block,res,bytes,ts) VALUES('robinhood','k1','eth_call',1,?,?,?)`, 'x'.repeat(200_000), 200_000, Date.now());
  const logs = [];
  let restarts = 0;
  let wallet = null;
  const exec = {
    keyPath: () => keyPath,
    loadWallet: () => { if (!wallet) wallet = new ethers.Wallet(fs.readFileSync(keyPath, 'utf8').trim()); return wallet; },
    address: () => { try { return exec.loadWallet().address.toLowerCase(); } catch { return null; } },
    resetWallet: () => { wallet = null; },
  };
  const engine = { dryRun: () => !live, exec, chain: { network: 'robinhood' }, activeEntries: 0, exiting: new Set(), selling: new Set() };
  const r = createSettingsRoutes({
    engine, cfg, cfgPath, store, log: (m) => logs.push(m), readBody: async (req) => req.__body,
    rpc: { stats: () => [], reconfigure() {} }, telegram: null, restart: () => { restarts++; },
  });
  const call = (key, body) => r[key]({ __body: body, headers: {} }, new URL('http://x/'), {});
  return { dir, cfgPath, dbPath, keyPath, store, call, logs, engine, restarts: () => restarts, setLive: (v) => { live = v; } };
}

(async () => {
  console.log('cadangan:');
  const A = instance({ positions: 5 });
  let full;   // cadangan lengkap dari A, dipakai tes-tes pemulihan

  await t('tanpa token / token salah: ditolak', async () => {
    assert.match((await A.call('POST /api/settings/backup', { parts: { config: true } })).error, /Token salah/);
    assert.match((await A.call('POST /api/settings/backup', { token: 'salah', parts: { config: true } })).error, /Token salah/);
    assert.match((await A.call('POST /api/settings/backup', { token: 'tok-rahasia', parts: {} })).error, /minimal satu/);
    assert.match((await A.call('POST /api/settings/backup', { token: 'tok-rahasia', parts: { wallet: true }, password: 'pendek' })).error, /minimal 8/);
  });

  await t('cadangan lengkap: config apa adanya, basis data tanpa rpc_cache, wallet terenkripsi', async () => {
    const r = await A.call('POST /api/settings/backup', { token: 'tok-rahasia', parts: { config: true, db: true, wallet: true }, password: 'password-kuat' });
    assert.ok(r.ok, r.error);
    full = JSON.parse(JSON.stringify(r.backup));   // lewat JSON, persis seperti diunduh
    assert.strictEqual(full.format, 'quiver-backup');
    assert.deepStrictEqual(full.parts.config.json, JSON.parse(fs.readFileSync(A.cfgPath, 'utf8')));
    assert.strictEqual(full.parts.db.stats.positions, 5);
    assert.strictEqual(full.parts.db.stats.open, 1);
    // isi basis data di berkas: posisinya ada, tabel rpc_cache tidak
    const f = path.join(os.tmpdir(), `lpcopy-cadangan-${process.pid}.db`);
    fs.writeFileSync(f, require('node:zlib').gunzipSync(Buffer.from(full.parts.db.gz, 'base64')));
    const { DatabaseSync } = require('node:sqlite');
    const raw = new DatabaseSync(f);
    assert.strictEqual(raw.prepare('SELECT COUNT(*) n FROM positions').get().n, 5);
    assert.ok(!raw.prepare("SELECT 1 FROM sqlite_master WHERE name='rpc_cache'").get(), 'rpc_cache ikut');
    raw.close(); fs.rmSync(f);
    assert.strictEqual(full.parts.wallet.address, A.engine.exec.address());
    assert.ok(!JSON.stringify(full).includes(fs.readFileSync(A.keyPath, 'utf8').trim().slice(2)), 'kunci privat mentah bocor ke berkas');
    const w = await ethers.Wallet.fromEncryptedJson(JSON.stringify(full.parts.wallet.keystore), 'password-kuat');
    assert.strictEqual(w.address.toLowerCase(), A.engine.exec.address());
    // basis data yang sedang dipakai tidak terganggu
    assert.strictEqual(A.store.get('SELECT COUNT(*) n FROM rpc_cache').n, 1);
  });

  await t('pulihkan saat LIVE: ditolak, tidak ada yang ditulis', async () => {
    const B = instance({ live: true, port: 30000, token: 'tok-b' });
    const r = await B.call('POST /api/settings/restore', { token: 'tok-b', parts: { db: true }, backup: full });
    assert.match(r.error, /LIVE/);
    assert.ok(!fs.existsSync(B.dbPath + '.restore-pending'));
  });

  await t('password keystore salah: gagal SEBELUM config/db ditaruh tertunda', async () => {
    const B = instance({ port: 30001, token: 'tok-b' });
    const before = fs.readFileSync(B.keyPath, 'utf8');
    const r = await B.call('POST /api/settings/restore', { token: 'tok-b', parts: { config: true, db: true, wallet: true }, password: 'salah-salah', backup: full });
    assert.match(r.error, /Password keystore salah/);
    assert.ok(!fs.existsSync(B.dbPath + '.restore-pending'));
    assert.ok(!fs.existsSync(B.cfgPath + '.restore-pending'));
    assert.strictEqual(fs.readFileSync(B.keyPath, 'utf8'), before);
    assert.strictEqual(B.restarts(), 0);
  });

  await t('basis data rusak (hash) / berkas asing: ditolak', async () => {
    const B = instance({ port: 30002, token: 'tok-b' });
    const bad = JSON.parse(JSON.stringify(full));
    bad.parts.db.sha256 = '0'.repeat(64);
    assert.match((await B.call('POST /api/settings/restore', { token: 'tok-b', parts: { db: true }, backup: bad })).error, /hash/);
    assert.ok(!fs.existsSync(B.dbPath + '.restore-pending'));
    assert.match((await B.call('POST /api/settings/restore', { token: 'tok-b', parts: { db: true }, backup: { hello: 1 } })).error, /Bukan berkas cadangan/);
    assert.throws(() => parseBackup({ ...full, version: 99 }), /lebih baru/);
    const partial = { ...full, parts: { config: full.parts.config } };
    assert.match((await B.call('POST /api/settings/restore', { token: 'tok-b', parts: { db: true }, backup: partial })).error, /tidak berisi bagian db/);
  });

  await t('pulihkan lengkap ke instance lain: wallet diganti (lama dicadangkan), config & db tertunda, lalu ditukar saat boot', async () => {
    const B = instance({ port: 30003, token: 'tok-b', positions: 1 });
    const oldAddr = B.engine.exec.address();
    const r = await B.call('POST /api/settings/restore', { token: 'tok-b', parts: { config: true, db: true, wallet: true }, password: 'password-kuat', backup: full });
    assert.ok(r.ok, r.error);
    assert.deepStrictEqual(r.staged.sort(), ['config', 'db']);
    assert.strictEqual(r.restarting, true);
    // wallet langsung terpasang, kunci lama tidak dihapus
    assert.strictEqual(B.engine.exec.address(), A.engine.exec.address());
    const baks = fs.readdirSync(path.dirname(B.keyPath)).filter((f) => f.startsWith('wallet.key.bak-'));
    assert.strictEqual(baks.length, 1);
    assert.strictEqual(new ethers.Wallet(fs.readFileSync(path.join(path.dirname(B.keyPath), baks[0]), 'utf8').trim()).address.toLowerCase(), oldAddr);
    // berkas yang sedang dipakai BELUM disentuh
    assert.strictEqual(JSON.parse(fs.readFileSync(B.cfgPath, 'utf8')).server.port, 30003);
    assert.strictEqual(B.store.get('SELECT COUNT(*) n FROM positions').n, 1);
    await new Promise((res) => setTimeout(res, 1700));
    assert.strictEqual(B.restarts(), 1, 'bot dinyalakan ulang');

    // --- boot: proses lama sudah berhenti ---
    B.store.db.close();
    const oldCfg = applyPendingRestore(B.cfgPath);
    const oldDb = applyPendingRestore(B.dbPath);
    assert.ok(oldCfg && fs.existsSync(oldCfg) && oldDb && fs.existsSync(oldDb));
    assert.ok(!fs.existsSync(B.dbPath + '.restore-pending') && !fs.existsSync(B.cfgPath + '.restore-pending'));
    const cfg = JSON.parse(fs.readFileSync(B.cfgPath, 'utf8'));
    assert.strictEqual(cfg.server.port, 30003, 'port milik server ini');
    assert.strictEqual(cfg.server.auth_token, 'tok-b', 'token dasbor milik server ini');
    assert.strictEqual(cfg.db.path, B.dbPath);
    assert.strictEqual(cfg.wallet.key_file, B.keyPath);
    assert.strictEqual(cfg.mode.dry_run, true);
    assert.strictEqual(cfg.chains.robinhood.rules.tag, 'aturan-20180', 'aturan dari cadangan');
    const s2 = new Store(B.dbPath);
    assert.strictEqual(s2.get('SELECT COUNT(*) n FROM positions').n, 5);
    assert.strictEqual(s2.get('SELECT COUNT(*) n FROM rpc_cache').n, 0, 'tabel cache dibuat ulang, kosong');
    s2.db.close();
    // tanpa berkas tertunda: tidak ada yang terjadi
    assert.strictEqual(applyPendingRestore(B.dbPath), null);
  });

  await t('config dari cadangan LIVE tetap mulai di simulasi', async () => {
    const L = instance({ port: 30004, token: 'tok-l', live: true });
    const r = await L.call('POST /api/settings/backup', { token: 'tok-l', parts: { config: true } });
    const B = instance({ port: 30005, token: 'tok-b' });
    assert.ok((await B.call('POST /api/settings/restore', { token: 'tok-b', parts: { config: true }, backup: r.backup })).ok);
    assert.strictEqual(JSON.parse(fs.readFileSync(B.cfgPath + '.restore-pending', 'utf8')).mode.dry_run, true);
  });

  await t('boot: WAL basis data lama ikut dipindah bersama berkasnya', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-cadangan-'));
    const db = path.join(dir, 'lpcopy.db');
    for (const [f, v] of [[db, 'lama'], [db + '-wal', 'wal'], [db + '-shm', 'shm'], [db + '.restore-pending', 'baru']]) fs.writeFileSync(f, v);
    const old = applyPendingRestore(db);
    assert.match(path.basename(old), /^lpcopy\.pre-restore-.+\.db$/);
    assert.strictEqual(fs.readFileSync(db, 'utf8'), 'baru');
    assert.strictEqual(fs.readFileSync(old + '-wal', 'utf8'), 'wal');
    assert.ok(!fs.existsSync(db + '-wal') && !fs.existsSync(db + '-shm'));
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
