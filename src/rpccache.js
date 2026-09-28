'use strict';
// Cache jawaban RPC yang SUDAH TIDAK BISA BERUBAH LAGI.
//
// Sebagian besar beban RPC di sini bukan data hidup, melainkan data mati yang dibaca
// berulang-ulang: receipt transaksi yang sama dibaca tiap sinkron (30 detik), header
// blok lampau dibaca lagi tiap kali riwayat dihitung ulang, saldo di blok lampau
// dibaca ulang tiap kali pelacak modal membelah rentang, dan getLogs untuk rentang
// blok yang sama diminta lagi setiap wallet dipindai ulang. Jawabannya tidak mungkin
// berbeda — blok yang sudah lewat tidak berubah — tetapi tiap pembacaan tetap memakan
// jatah endpoint (Alchemy 429 "monthly capacity", ordofi "network is busy").
//
// Jadi: panggilan yang TERIKAT pada satu blok lampau disimpan; jawabannya dipakai
// lagi tanpa menyentuh jaringan. Yang tidak terikat blok (eth_blockNumber, eth_call
// di `latest`, gas, saldo terkini) tidak pernah masuk sini — itu justru data yang
// harus selalu baru.
//
// Dua lapis: Map di memori (proses yang sedang jalan) dan tabel `rpc_cache` di
// SQLite (bertahan lintas restart dan deploy). Kunci memuat chain, jadi satu database
// yang dipakai beberapa chain tidak saling tertukar.
//
// Syarat "sudah pasti": blok yang dirujuk harus tertinggal minimal `confirmations`
// blok dari kepala rantai yang terakhir kita lihat. Selama tinggi rantai belum
// diketahui (belum ada satu pun eth_blockNumber), tidak ada yang disimpan.
const crypto = require('node:crypto');

const numTag = (t) => (typeof t === 'string' && /^0x[0-9a-f]+$/i.test(t) ? parseInt(t, 16) : null);

// Kunci yang stabil: urutan kolom objek tidak boleh mengubah kunci (filter getLogs
// ditulis dengan urutan berbeda di beberapa pemanggil), dan hex besar/kecil sama saja.
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v).sort().map((k) => `${k}:${stable(v[k])}`).join(',')}}`;
  }
  if (typeof v === 'string') return v.toLowerCase();
  return String(v);
}
function keyOf(method, params) {
  const s = `${method}|${stable(params || [])}`;
  // Kunci panjang (filter getLogs dengan banyak topik) diringkas — indeks SQLite
  // tidak perlu memikul kalimat sepanjang itu.
  return s.length <= 160 ? s : `${method}|#${crypto.createHash('sha1').update(s).digest('hex')}`;
}

// Panggilan yang jawabannya terikat pada satu blok. `block` = blok itu; `blockOf` =
// bloknya baru ketahuan dari jawabannya (receipt dan transaksi membawa blockNumber
// sendiri; selama masih pending, keduanya null dan tidak ada yang disimpan).
// Yang tidak ada di sini tidak pernah disimpan.
function pinOf(method, params) {
  switch (method) {
    // Identitas rantai: tidak terikat blok mana pun.
    case 'eth_chainId': return { block: 0 };
    case 'eth_getBlockByNumber': {
      const b = numTag(params?.[0]);      // 'latest'/'pending' -> null, tidak disimpan
      return b == null ? null : { block: b };
    }
    case 'eth_getBlockByHash': return { blockOf: (r) => numTag(r?.number) };
    case 'eth_getTransactionReceipt':
    case 'eth_getTransactionByHash': return { blockOf: (r) => numTag(r?.blockNumber) };
    case 'eth_getBalance':
    case 'eth_getCode':
    case 'eth_getTransactionCount': {
      const b = numTag(params?.[1]);
      return b == null ? null : { block: b };
    }
    case 'eth_getStorageAt': {
      const b = numTag(params?.[2]);
      return b == null ? null : { block: b };
    }
    // eth_call di blok lampau (node arsip): hasilnya fungsi murni dari state blok itu.
    case 'eth_call': {
      const b = numTag(params?.[1]);
      return b == null ? null : { block: b };
    }
    // Rentang yang kedua ujungnya sudah lewat. Blok acuannya ujung KANAN: itu yang
    // paling dekat dengan kepala rantai.
    case 'eth_getLogs': {
      const f = params?.[0];
      if (!f || f.blockHash) return null;
      const a = numTag(f.fromBlock), b = numTag(f.toBlock);
      return a == null || b == null ? null : { block: b };
    }
    default: return null;
  }
}

class RpcCache {
  constructor({ store, chain = 'robinhood', log = () => {}, confirmations = 64, ttl_days = 30,
    max_rows = 100_000, max_entry_kb = 512, max_mb = 200, mem_entries = 3000, mem_mb = 32 } = {}) {
    this.store = store;
    this.chain = chain;
    this.log = log;
    this.conf = Math.max(0, confirmations);
    this.ttlMs = Math.max(1, ttl_days) * 86400_000;
    this.maxRows = Math.max(1, max_rows);
    this.maxEntry = Math.max(1, max_entry_kb) * 1024;
    this.maxBytes = Math.max(1, max_mb) * 1024 * 1024;
    this.memMax = Math.max(0, mem_entries);
    // Lapis memori dibatasi dua-duanya: jumlah entri DAN totalnya dalam byte. Satu
    // jawaban getLogs bisa ratusan kilobyte — 3.000 entri seperti itu akan memakan
    // memori proses lebih besar daripada seluruh sisa bot.
    this.memBytesMax = Math.max(1, mem_mb) * 1024 * 1024;
    this.memBytes = 0;
    this.mem = new Map();
    this.hits = 0; this.misses = 0; this.writes = 0; this.tooBig = 0;
    try { this.sweep(); } catch (e) { this.log(`cache rpc: bersih-bersih awal gagal (${e.message})`); }
  }

  // null = panggilan ini tidak pernah boleh disimpan.
  plan(method, params) {
    const pin = pinOf(method, params);
    return pin ? { ...pin, method, key: keyOf(method, params) } : null;
  }

  // Blok yang belum cukup dalam tidak akan pernah ada di sini (put menolaknya), jadi
  // tidak usah ditanyakan ke database sama sekali: mesin membaca fee di blok head-3
  // tiap tick untuk tiap posisi, dan itu kueri percuma yang berulang selamanya. Juga
  // menjaga angka "berapa persen dijawab tanpa jaringan" tetap bermakna — yang dihitung
  // cuma pembacaan yang MEMANG bisa disimpan.
  tooFresh(plan, head) {
    return plan.block != null && plan.block > 0 && (!head || plan.block > head - this.conf);
  }

  // undefined = tidak ada di cache (nilai `null` sendiri tidak pernah disimpan).
  //
  // Yang disimpan di memori adalah TEKS JSON-nya, bukan objeknya: tiap pemanggil
  // menerima objek barunya sendiri. Pemanggil yang mengubah jawaban di tempat (ethers
  // suka menormalkan receipt) kalau tidak begini akan ikut mengubah isi cache untuk
  // semua pemanggil berikutnya — dan itu bug yang sangat sukar dilacak.
  get(plan, head) {
    if (!plan || this.tooFresh(plan, head)) return undefined;
    const hit = this.mem.get(plan.key);
    if (hit !== undefined) { this.hits++; return JSON.parse(hit.json); }
    let row;
    try { row = this.store.get('SELECT res FROM rpc_cache WHERE chain=? AND k=?', this.chain, plan.key); }
    catch (e) { this.log(`cache rpc: baca gagal (${e.message})`); return undefined; }
    if (!row) { this.misses++; return undefined; }
    let val;
    try { val = JSON.parse(row.res); } catch { return undefined; }
    this.remember(plan.key, row.res, Buffer.byteLength(row.res));
    this.hits++;
    return val;
  }

  remember(key, json, bytes) {
    if (!this.memMax) return;
    const old = this.mem.get(key);
    if (old !== undefined) this.memBytes -= old.bytes;
    this.mem.set(key, { json, bytes });
    this.memBytes += bytes;
    // Map menjaga urutan masuk: yang tertua dibuang lebih dulu.
    while (this.mem.size > this.memMax || this.memBytes > this.memBytesMax) {
      const k = this.mem.keys().next().value;
      if (k === undefined) break;
      this.memBytes -= this.mem.get(k).bytes;
      this.mem.delete(k);
    }
  }

  // head = tinggi rantai terakhir yang terlihat (0 = belum tahu; tidak menyimpan apa pun).
  put(plan, result, head) {
    if (!plan || result == null) return false;
    const block = plan.block != null ? plan.block : plan.blockOf(result);
    if (block == null) return false;                       // mis. receipt yang masih pending
    if (block > 0 && (!head || block > head - this.conf)) return false;   // belum cukup dalam
    let res;
    try { res = JSON.stringify(result); } catch { return false; }
    const bytes = Buffer.byteLength(res);
    if (bytes > this.maxEntry) { this.tooBig++; return false; }
    this.remember(plan.key, res, bytes);
    try {
      this.store.run(`INSERT INTO rpc_cache(chain,k,method,block,res,bytes,ts) VALUES(?,?,?,?,?,?,?)
        ON CONFLICT(chain,k) DO UPDATE SET res=excluded.res, bytes=excluded.bytes, ts=excluded.ts`,
      this.chain, plan.key, plan.method, block, res, bytes, Date.now());
      this.writes++;
    } catch (e) { this.log(`cache rpc: tulis gagal (${e.message})`); return false; }
    return true;
  }

  // Buang yang kedaluwarsa, lalu yang tertua kalau tabelnya kelewat besar. Cache yang
  // hilang cuma berarti satu panggilan RPC lagi — tidak ada data yang ikut hilang.
  sweep() {
    const t0 = Date.now();
    this.store.run('DELETE FROM rpc_cache WHERE ts < ?', t0 - this.ttlMs);
    const sum = this.store.get('SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM rpc_cache WHERE chain=?', this.chain) || { n: 0, b: 0 };
    if (sum.n <= this.maxRows && sum.b <= this.maxBytes) return 0;
    // Batasnya dilewati: baris tertua dibuang sampai keduanya kembali di bawah batas.
    const rows = this.store.all('SELECT ts, bytes FROM rpc_cache WHERE chain=? ORDER BY ts ASC', this.chain);
    let n = sum.n, b = sum.b, cut = 0, dropped = 0;
    for (const r of rows) {
      if (n <= this.maxRows && b <= this.maxBytes) break;
      n--; b -= r.bytes || 0; cut = r.ts; dropped++;
    }
    if (!dropped) return 0;
    this.store.run('DELETE FROM rpc_cache WHERE chain=? AND ts <= ?', this.chain, cut);
    this.mem.clear(); this.memBytes = 0;
    this.log(`cache rpc: ${dropped} entri lama dibuang (batas ${this.maxRows} baris / ${Math.round(this.maxBytes / 1048576)} MB)`);
    return dropped;
  }

  stats() {
    let n = 0, bytes = 0;
    try {
      const r = this.store.get('SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM rpc_cache WHERE chain=?', this.chain);
      n = Number(r?.n || 0); bytes = Number(r?.b || 0);
    } catch { /* tabelnya belum ada — tampilkan nol */ }
    const asked = this.hits + this.misses;
    return {
      rows: n, bytes, mem: this.mem.size, memBytes: this.memBytes,
      hits: this.hits, misses: this.misses, writes: this.writes, tooBig: this.tooBig,
      hitPct: asked ? Math.round((this.hits / asked) * 100) : 0,
      confirmations: this.conf,
    };
  }
}

module.exports = { RpcCache, keyOf, pinOf };
