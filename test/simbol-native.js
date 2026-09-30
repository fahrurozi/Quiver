'use strict';
// Uji simbol token native (0x0) di daftar yang dibangun langsung dari tabel `tokens`.
//
// Pool v4 boleh memakai ETH native sebagai currency0 — alamatnya nol, bukan ERC-20.
// Chain#tokens tidak pernah menyimpan barisnya (symbol()/decimals() tak bisa dipanggil
// ke alamat nol), jadi setiap endpoint yang membaca tabel `tokens` apa adanya dulu
// menampilkan "? / OFY" untuk posisi bersisi ETH. tokenMeta() melengkapinya dari
// QUOTES chain.
//
// Jalankan: node test/simbol-native.js
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { Store } = require('../src/db');
const { createServer } = require('../src/server');

const NATIVE = '0x' + '00'.repeat(20);
const OFY = '0x' + 'ab'.repeat(20);
const WALLET = '0x' + '11'.repeat(20);
const POOL = '0x' + 'cd'.repeat(32);
let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

function dunia() {
  const store = new Store(':memory:');
  const cfg = { mode: { dry_run: true }, rules: {}, gas: {}, loop: {}, prices: {}, chain: { endpoints: [] }, server: {}, notify: {}, wallet: {} };
  const cfgPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lpcopy-simbol-native-')), 'config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(cfg));
  const engine = {
    cfg, store, ethUsd: 2500, positions: { live: [], lastSync: Date.now() }, watcher: { unsupported: new Map() },
    exec: { address: () => null, balances: async () => new Map() }, leftovers: () => [], dryRun: () => true,
  };
  const server = createServer({ engine, store, cfg, cfgPath, chain: {}, rpc: {}, log: () => {}, telegram: null });
  return { store, api: server.api };
}

(async () => {
  console.log('simbol ETH native di pool v4');
  const { store, api } = dunia();
  const now = Date.now();
  // Hanya OFY yang punya baris di `tokens` — persis seperti di chain: sisi native
  // tidak pernah tersimpan.
  store.run('INSERT INTO tokens(address,symbol,name,decimals,seen_ts) VALUES(?,?,?,?,?)', OFY, 'OFY', 'Offy', 18, now);

  store.run('INSERT INTO wallets(address,label,last_scan_ts,positions_n,stats) VALUES(?,?,?,?,?)', WALLET, 'Paus', now, 1, '{}');
  store.run(`INSERT INTO wpositions(wallet,venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,
      liquidity,invested_q,returned_q,pnl_q,quote_symbol,opened_ts,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  WALLET, 'v4', '3431055', POOL, NATIVE, OFY, 3000, -60, 60, '1000', 100, 0, 5, 'ETH', now - 3600000, 'open');

  await t('/api/wallet: posisi riset bersisi native tampil ETH, bukan "?"', async () => {
    const r = await api('GET', '/api/wallet', {}, { address: WALLET });
    const p = r.open[0];
    assert.equal(p.symbol0, 'ETH');
    assert.equal(p.symbol1, 'OFY');
    assert.equal(p.dec0, 18);
  });

  // Posisi bot yang sudah tertutup: simbolnya juga dari tabel `tokens`.
  store.run(`INSERT INTO positions(venue,token_id,pool_ref,token0,token1,fee,tick_lower,tick_upper,
      liquidity,cost_quote,out_quote,quote_symbol,opened_ts,closed_ts,status)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  'v4', '3431054', POOL, NATIVE, OFY, 3000, -60, 60, '0', 0.04, 0.05, 'ETH', now - 7200000, now - 3600000, 'closed');

  await t('/api/positions: posisi tertutup bersisi native tampil ETH', async () => {
    const r = await api('GET', '/api/positions', {}, {});
    const c = r.closed.find((x) => x.token_id === '3431054');
    assert.ok(c, 'posisi tertutup harus ada di daftar');
    assert.equal(c.symbol0, 'ETH');
    assert.equal(c.symbol1, 'OFY');
  });

  // Gerakan target di halaman Aktivitas.
  store.run(`INSERT INTO actions(ts,block,tx_hash,log_index,target,venue,token_id,pool_ref,token0,token1,fee,kind,value_quote,quote_symbol)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  now - 60000, 1, '0x' + 'ef'.repeat(32), 0, WALLET, 'v4', '3431053', POOL, NATIVE, OFY, 3000, 'increase', 0.04, 'ETH');

  await t('/api/activity: gerakan target bersisi native tampil ETH', async () => {
    const r = await api('GET', '/api/activity', {}, {});
    const a = r.activity.find((x) => x.token_id === '3431053');
    assert.ok(a, 'gerakan harus ada di daftar');
    assert.equal(a.symbol0, 'ETH');
    assert.equal(a.symbol1, 'OFY');
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  if (fail) process.exit(1);
})();
