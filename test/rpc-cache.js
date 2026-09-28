'use strict';
// Uji: cache jawaban RPC yang sudah pasti (src/rpccache.js).
//
// Yang dijaga di sini: apa yang boleh disimpan (hanya yang terikat blok lampau yang
// sudah cukup dalam), apa yang TIDAK boleh (data hidup, receipt pending, blok dekat
// kepala, daftar log dari node tertinggal), dan bahwa simpanannya bertahan setelah
// proses hidup lagi.
// Jalankan: node test/rpc-cache.js
const assert = require('node:assert');
const { RpcPool } = require('../src/rpc');
const { Store } = require('../src/db');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.message}`); }
}

const hex = (n) => '0x' + n.toString(16);
const HEAD = 1_000_000;

// Kolam dengan satu endpoint palsu. `answer(method, params)` -> hasil; tiap panggilan
// yang benar-benar pergi ke "jaringan" dihitung per metode.
function pool(answer, { store = new Store(':memory:'), cache = {}, head = HEAD } = {}) {
  const p = new RpcPool([{ url: 'https://a.example', archive: true }], () => {}, {
    dns_over_https: false,
    cache: { store, chain: 'robinhood', confirmations: 64, ...cache },
  });
  p.calls = {};
  p.post = async (url, body) => {
    const j = JSON.parse(body);
    const one = (c) => {
      p.calls[c.method] = (p.calls[c.method] || 0) + 1;
      return { jsonrpc: '2.0', id: c.id, result: answer(c.method, c.params) };
    };
    return Array.isArray(j) ? j.map(one) : one(j);
  };
  p.head = head;
  return p;
}

const receipt = (block) => ({ blockNumber: hex(block), status: '0x1', logs: [] });

(async () => {
  console.log('rpc-cache:');

  await t('receipt blok lampau: panggilan kedua tidak menyentuh jaringan', async () => {
    const p = pool((m) => (m === 'eth_getTransactionReceipt' ? receipt(HEAD - 5000) : null));
    const a = await p.call('eth_getTransactionReceipt', ['0xAA']);
    const b = await p.call('eth_getTransactionReceipt', ['0xaa']);   // huruf besar/kecil sama
    assert.deepStrictEqual(a, b);
    assert.strictEqual(p.calls.eth_getTransactionReceipt, 1);
    assert.strictEqual(p.cacheStats().rows, 1);
  });

  await t('receipt yang masih pending tidak disimpan', async () => {
    const p = pool(() => null);
    assert.strictEqual(await p.call('eth_getTransactionReceipt', ['0xbb']), null);
    assert.strictEqual(await p.call('eth_getTransactionReceipt', ['0xbb']), null);
    assert.strictEqual(p.calls.eth_getTransactionReceipt, 2);
    assert.strictEqual(p.cacheStats().rows, 0);
  });

  await t('transaksi yang sudah dibukukan disimpan, yang masih di mempool tidak', async () => {
    let block = null;
    const p = pool(() => ({ hash: '0xcc', blockNumber: block == null ? null : hex(block) }));
    await p.call('eth_getTransactionByHash', ['0xcc']);
    await p.call('eth_getTransactionByHash', ['0xcc']);
    assert.strictEqual(p.calls.eth_getTransactionByHash, 2, 'mempool: selalu tanya lagi');
    block = HEAD - 1000;
    await p.call('eth_getTransactionByHash', ['0xcc']);
    const r = await p.call('eth_getTransactionByHash', ['0xcc']);
    assert.strictEqual(r.blockNumber, hex(block));
    assert.strictEqual(p.calls.eth_getTransactionByHash, 3);
  });

  await t('blok yang belum cukup dalam tidak disimpan, yang dalam disimpan', async () => {
    const p = pool((m, prm) => ({ number: prm[0], timestamp: '0x64' }));
    const dekat = hex(HEAD - 10);     // < confirmations (64) dari kepala
    await p.call('eth_getBlockByNumber', [dekat, false]);
    await p.call('eth_getBlockByNumber', [dekat, false]);
    assert.strictEqual(p.calls.eth_getBlockByNumber, 2);
    const dalam = hex(HEAD - 5000);
    await p.call('eth_getBlockByNumber', [dalam, false]);
    await p.call('eth_getBlockByNumber', [dalam, false]);
    assert.strictEqual(p.calls.eth_getBlockByNumber, 3);
  });

  await t('tinggi rantai belum diketahui: tidak ada yang disimpan', async () => {
    const p = pool(() => receipt(1000), { head: 0 });
    await p.call('eth_getTransactionReceipt', ['0xdd']);
    await p.call('eth_getTransactionReceipt', ['0xdd']);
    assert.strictEqual(p.calls.eth_getTransactionReceipt, 2);
    assert.strictEqual(p.cacheStats().rows, 0);
  });

  await t('data hidup tidak pernah disimpan (blockNumber, saldo terkini, eth_call di latest)', async () => {
    const p = pool((m) => (m === 'eth_blockNumber' ? hex(HEAD) : '0x1'));
    for (let i = 0; i < 2; i++) {
      await p.call('eth_blockNumber');
      await p.call('eth_getBalance', ['0xab', 'latest']);
      await p.ethCall('0xab', '0xdata');
      await p.call('eth_gasPrice');
    }
    assert.strictEqual(p.calls.eth_blockNumber, 2);
    assert.strictEqual(p.calls.eth_getBalance, 2);
    assert.strictEqual(p.calls.eth_call, 2);
    assert.strictEqual(p.calls.eth_gasPrice, 2);
    assert.strictEqual(p.cacheStats().rows, 0);
  });

  await t('eth_call & saldo di blok lampau disimpan (jatah node arsip dihemat)', async () => {
    const p = pool(() => '0x2a');
    const blok = HEAD - 200_000;
    await p.callAt('0xab', '0xdata', blok);
    await p.callAt('0xab', '0xdata', blok);
    await p.call('eth_getBalance', ['0xab', hex(blok)]);
    await p.call('eth_getBalance', ['0xab', hex(blok)]);
    assert.strictEqual(p.calls.eth_call, 1);
    assert.strictEqual(p.calls.eth_getBalance, 1);
  });

  await t('getLogs rentang lampau: kedua kali dijawab dari simpanan', async () => {
    const logs = [{ address: '0xab', data: '0x1', blockNumber: hex(HEAD - 9000) }];
    const p = pool((m, prm) => (m === 'eth_getLogs' ? logs : { number: prm[0] }));
    const filter = { fromBlock: hex(HEAD - 10_000), toBlock: hex(HEAD - 9000), topics: [] };
    assert.deepStrictEqual(await p.getLogs(filter), logs);
    // Urutan kolom filter berbeda: kuncinya tetap sama.
    assert.deepStrictEqual(await p.getLogs({ topics: [], toBlock: filter.toBlock, fromBlock: filter.fromBlock }), logs);
    assert.strictEqual(p.calls.eth_getLogs, 1);
  });

  await t('getLogs sampai kepala rantai tidak disimpan', async () => {
    const p = pool((m, prm) => (m === 'eth_getLogs' ? [] : { number: prm[0] }));
    const filter = { fromBlock: hex(HEAD - 100), toBlock: hex(HEAD - 20), topics: [] };
    await p.getLogs(filter);
    await p.getLogs(filter);
    assert.strictEqual(p.calls.eth_getLogs, 2);
  });

  await t('node tertinggal: daftar log kosongnya tidak diabadikan', async () => {
    // Blok ujung rentang tidak ada di endpoint itu -> getLogs gagal, dan blok ujung
    // itu sendiri tidak boleh dijawab dari cache (justru endpointnya yang diuji).
    const p = pool((m) => (m === 'eth_getLogs' ? [] : null));
    const filter = { fromBlock: hex(HEAD - 10_000), toBlock: hex(HEAD - 9000), topics: [] };
    await assert.rejects(p.getLogs(filter), /tertinggal/);
    assert.strictEqual(p.cacheStats().rows, 0);
    // Endpoint pulih: rentang yang sama dibaca ulang, sekarang berisi.
    const logs = [{ data: '0x1' }];
    p.post = async (url, body) => {
      const j = JSON.parse(body);
      const one = (c) => ({ jsonrpc: '2.0', id: c.id, result: c.method === 'eth_getLogs' ? logs : { number: c.params[0] } });
      return Array.isArray(j) ? j.map(one) : one(j);
    };
    p.eps[0].logsCooldownUntil = 0;
    assert.deepStrictEqual(await p.getLogs(filter), logs);
  });

  await t('galat tidak disimpan sebagai jawaban', async () => {
    const store = new Store(':memory:');
    const p = pool(() => null);
    p.post = async (url, body) => {
      const j = JSON.parse(body);
      return { jsonrpc: '2.0', id: j.id, error: { code: 3, message: 'execution reverted' } };
    };
    await assert.rejects(p.call('eth_call', [{ to: '0xab', data: '0x' }, hex(HEAD - 5000)]), /reverted/);
    assert.strictEqual(p.cacheStats().rows, 0);
    assert.ok(store);
  });

  await t('simpanan bertahan setelah proses hidup lagi', async () => {
    const store = new Store(':memory:');
    const a = pool(() => receipt(HEAD - 5000), { store });
    await a.call('eth_getTransactionReceipt', ['0xee']);
    assert.strictEqual(a.calls.eth_getTransactionReceipt, 1);
    // Kolam baru (restart), database yang sama: tidak ada lagi panggilan jaringan.
    const b = pool(() => { throw new Error('tidak boleh menyentuh jaringan'); }, { store });
    const r = await b.call('eth_getTransactionReceipt', ['0xee']);
    assert.strictEqual(r.blockNumber, hex(HEAD - 5000));
    assert.strictEqual(b.calls.eth_getTransactionReceipt, undefined);
  });

  await t('chain lain di database yang sama tidak ikut terbaca', async () => {
    const store = new Store(':memory:');
    const a = pool(() => receipt(HEAD - 5000), { store });
    await a.call('eth_getTransactionReceipt', ['0xff']);
    const b = pool(() => receipt(HEAD - 5000), { store, cache: { chain: 'bsc' } });
    await b.call('eth_getTransactionReceipt', ['0xff']);
    assert.strictEqual(b.calls.eth_getTransactionReceipt, 1, 'bsc harus bertanya sendiri');
    assert.strictEqual(b.cacheStats().rows, 1);
  });

  await t('entri kedaluwarsa & kelebihan batas dibuang saat bersih-bersih', async () => {
    const store = new Store(':memory:');
    const p = pool(() => receipt(HEAD - 5000), { store, cache: { ttl_days: 1 } });
    await p.call('eth_getTransactionReceipt', ['0x01']);
    store.run('UPDATE rpc_cache SET ts = ?', Date.now() - 3 * 86400_000);
    p.cache.sweep();
    assert.strictEqual(p.cacheStats().rows, 0);

    const q = pool(() => receipt(HEAD - 5000), { store, cache: { max_rows: 2 } });
    for (let i = 0; i < 5; i++) {
      // ts baris ditulis dari jam dinding; dimundurkan supaya urutan "tertua" jelas.
      await q.call('eth_getTransactionReceipt', [`0x1${i}`]);
      store.run('UPDATE rpc_cache SET ts=? WHERE k LIKE ?', Date.now() - (5 - i) * 60_000, `%0x1${i}%`);
    }
    q.cache.sweep();
    assert.strictEqual(q.cacheStats().rows, 2);
  });

  await t('jawaban raksasa dilewati, tidak menggelembungkan database', async () => {
    const p = pool(() => ({ blockNumber: hex(HEAD - 5000), data: 'x'.repeat(200 * 1024) }), { cache: { max_entry_kb: 64 } });
    await p.call('eth_getTransactionReceipt', ['0x02']);
    await p.call('eth_getTransactionReceipt', ['0x02']);
    assert.strictEqual(p.calls.eth_getTransactionReceipt, 2);
    assert.strictEqual(p.cacheStats().rows, 0);
    assert.strictEqual(p.cacheStats().tooBig, 2);
  });

  await t('blok yang masih segar tidak ditanyakan ke database sama sekali', async () => {
    // Mesin membaca fee di blok head-3 tiap tick: pencarian seperti itu tidak boleh
    // menambah beban database, dan tidak boleh dihitung sebagai "meleset".
    const p = pool((m, prm) => ({ number: prm[0] }));
    let baca = 0;
    const asli = p.cache.store.get.bind(p.cache.store);
    p.cache.store.get = (...a) => { if (String(a[0]).includes('rpc_cache')) baca++; return asli(...a); };
    for (let i = 0; i < 5; i++) await p.call('eth_getBlockByNumber', [hex(HEAD - 3), false]);
    assert.strictEqual(baca, 0, `database ditanya ${baca} kali untuk blok yang belum pasti`);
    assert.strictEqual(p.cacheStats().misses, 0);
    assert.strictEqual(p.cacheStats().hitPct, 0);
    // Blok yang dalam tetap dihitung: sekali meleset, sisanya kena.
    for (let i = 0; i < 3; i++) await p.call('eth_getBlockByNumber', [hex(HEAD - 5000), false]);
    const st = p.cacheStats();
    assert.strictEqual(st.misses, 1);
    assert.strictEqual(st.hits, 2);
    assert.strictEqual(st.hitPct, 67);
  });

  await t('jawaban dari cache tidak berbagi objek: pemanggil boleh mengubahnya', async () => {
    const p = pool(() => receipt(HEAD - 5000));
    const a = await p.call('eth_getTransactionReceipt', ['0x04']);
    a.status = '0x0';                                  // pemanggil menormalkan jawabannya
    const b = await p.call('eth_getTransactionReceipt', ['0x04']);
    assert.strictEqual(b.status, '0x1', 'isi cache ikut berubah');
  });

  await t('lapis memori dibatasi byte, bukan cuma jumlah entri', async () => {
    const besar = { blockNumber: hex(HEAD - 5000), data: 'x'.repeat(200 * 1024) };
    const p = pool(() => besar, { cache: { mem_mb: 1, max_entry_kb: 512 } });
    for (let i = 0; i < 12; i++) await p.call('eth_getTransactionReceipt', [`0x2${i}`]);
    const st = p.cacheStats();
    assert.strictEqual(st.rows, 12, 'semuanya tetap masuk database');
    assert.ok(st.memBytes <= 1024 * 1024, `memori dibatasi 1 MB, terpakai ${st.memBytes}`);
    assert.ok(st.mem < 12, 'entri tertua dibuang dari memori');
  });

  await t('tanpa store: kolam tetap jalan tanpa cache (uji endpoint di Pengaturan)', async () => {
    const p = new RpcPool([{ url: 'https://a.example' }], () => {}, { dns_over_https: false });
    p.post = async (url, body) => ({ jsonrpc: '2.0', id: JSON.parse(body).id, result: receipt(1) });
    assert.strictEqual(p.cacheStats(), null);
    assert.ok(await p.call('eth_getTransactionReceipt', ['0x03']));
  });

  console.log(`\n${pass} ok, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
