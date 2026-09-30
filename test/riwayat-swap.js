'use strict';
// Uji riwayat swap (src/swaplog.js): setiap jenis tx penukar aset diberi metode dan
// rute yang benar, dan baris lama yang belum mencatat token/jumlah tetap terbaca
// sebisanya dari detail lamanya (pay/buy zap, positionSales, arah jembatan).
//
// Jalankan: node test/riwayat-swap.js
const assert = require('node:assert');
const { Store } = require('../src/db');
const { ensureChain } = require('../src/networks');
const { swapHistory } = require('../src/swaplog');

const chain = ensureChain({});
const { ADDR } = chain;
const MEME = '0x' + 'a1'.repeat(20);
const E18 = 10n ** 18n;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

function dunia() {
  const store = new Store(':memory:');
  store.run('INSERT INTO tokens(chain,address,symbol,name,decimals,seen_ts) VALUES(?,?,?,?,?,?)', chain.network, MEME, 'MEME', 'Meme', 18, 0);
  store.run(`INSERT INTO positions(id, chain, venue, pool_ref, token0, token1, status, liquidity) VALUES(7, ?, 'v4', '0xpool', ?, ?, 'closed', '0')`,
    chain.network, MEME, ADDR.usdg);
  let ts = 1000;
  const tx = (kind, detail, extra = {}) => store.run(
    'INSERT INTO txs(hash, ts, kind, status, detail, chain, gas_used, gas_price) VALUES(?,?,?,?,?,?,?,?)',
    extra.hash || `0x${kind}${ts}`, ts++, kind, extra.status || 'sukses', JSON.stringify(detail), chain.network, 100000, '0x3b9aca00');
  return { store, tx };
}
const riwayat = (store, o = {}) => swapHistory({ store, chain, ethUsd: 4000, ...o });
const byKind = (list, k) => list.find((x) => x.kind === k);

t('tx bukan swap (mint, approve) tidak ikut', () => {
  const { store, tx } = dunia();
  tx('mint', { position: 7 }); tx('approve_kyber', {}); tx('swap_manual', { tokenIn: MEME, tokenOut: ADDR.usdg, symbolIn: 'MEME', symbolOut: 'USDG', amountIn: 5 });
  const l = riwayat(store);
  assert.deepStrictEqual(l.map((x) => x.kind), ['swap_manual']);
  assert.strictEqual(l[0].method, 'manual');
  assert.strictEqual(l[0].route, 'kyber');
});

t('zap lama: token dari pay/buy, jumlah keluar dari gotOut, rute pool langsung dari via', () => {
  const { store, tx } = dunia();
  tx('zap_swap', { via: 'kyber', pay: ADDR.usdg, buy: MEME, gotOut: (3n * E18).toString(), dex: 'uniswap-v4' });
  tx('zap_swap', { via: '0xpoolref', pay: ADDR.usdg, buy: MEME, payRaw: '2500000' });
  const [langsung, kyber] = riwayat(store);
  assert.strictEqual(kyber.method, 'zap');
  assert.strictEqual(kyber.route, 'kyber');
  assert.strictEqual(kyber.detail.symbolIn, 'USDG');
  assert.strictEqual(kyber.detail.symbolOut, 'MEME');
  assert.strictEqual(kyber.detail.amountOut, 3);
  assert.strictEqual(langsung.route, 'pool');
  assert.strictEqual(langsung.detail.amountIn, 2.5);
});

t('jual sisa: asal dibedakan (tutup LP, jual balik zap, fee, sapuan)', () => {
  const { store, tx } = dunia();
  tx('sell_leftover', { position: 7, positionSales: [{ amount: (2n * E18).toString() }, { amount: E18.toString() }], gotOut: '1500000' });
  tx('sell_leftover', { position: null, source: 'zap', tokenIn: MEME, tokenOut: ADDR.usdg, amountInRaw: E18.toString() });
  tx('sell_leftover', { position: 7, source: 'fee' });
  tx('sell_leftover', { position: null, source: 'wallet' });
  tx('sell_leftover', { position: null });
  const l = riwayat(store).reverse();
  assert.deepStrictEqual(l.map((x) => x.method), ['exit', 'unwind', 'fee_sell', 'sweep', 'leftover']);
  // Baris lama tanpa token: ditebak dari posisinya, jumlah dari positionSales.
  assert.strictEqual(l[0].detail.symbolIn, 'MEME');
  assert.strictEqual(l[0].detail.symbolOut, 'USDG');
  assert.strictEqual(l[0].detail.amountIn, 3);
  assert.strictEqual(l[0].detail.amountOut, 1.5);
  assert.strictEqual(l[0].pair, 'MEME/USDG');
  assert.strictEqual(l[1].detail.amountIn, 1);
});

t('jembatan lama: arah dari wantEth, pool langsung dikenali', () => {
  const { store, tx } = dunia();
  tx('bridge_swap', { pool: '0xp', wantEth: true });
  tx('bridge_swap', { via: 'kyber', wantEth: false, dex: 'orvex' });
  const [kyber, langsung] = riwayat(store);
  assert.strictEqual(langsung.route, 'pool');
  assert.strictEqual(langsung.detail.symbolIn, 'USDG');
  assert.strictEqual(langsung.detail.symbolOut, 'ETH');
  assert.strictEqual(kyber.route, 'kyber');
  assert.strictEqual(kyber.detail.symbolIn, 'ETH');
});

t('klaim fee: jumlah per sisi dari fee_claims, nilai USD dari sisi kuotasi', () => {
  const { store, tx } = dunia();
  tx('claim_fees', { position: 7 }, { hash: '0xklaim' });
  store.run('INSERT INTO fee_claims(tx_hash,position_id,ts,amount0,amount1,value_quote) VALUES(?,?,?,?,?,?)',
    '0xklaim', 7, 1, (4n * E18).toString(), '2000000', 2.4);
  const [k] = riwayat(store);
  assert.strictEqual(k.method, 'claim');
  assert.strictEqual(k.route, null);
  assert.strictEqual(k.claim.amount0, 4);
  assert.strictEqual(k.claim.amount1, 2);
  assert.strictEqual(k.claim.usd, 2.4);
});

t('filter jenis: hanya kind yang diminta, kind asing diabaikan', () => {
  const { store, tx } = dunia();
  tx('swap_manual', {}); tx('claim_fees', { position: 7 }); tx('wrap_eth', { amountInRaw: E18.toString() });
  assert.deepStrictEqual(riwayat(store, { kinds: ['claim_fees'] }).map((x) => x.kind), ['claim_fees']);
  assert.deepStrictEqual(riwayat(store, { kinds: ['burn'] }), []);
  const w = riwayat(store, { kinds: ['wrap_eth'] })[0];
  assert.strictEqual(w.detail.amountIn, 1);
  assert.strictEqual(w.detail.amountOut, 1);
});

console.log(`\n${pass} lolos, ${fail} gagal`);
process.exit(fail ? 1 : 0);
