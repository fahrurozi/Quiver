'use strict';
// Pemasangan awal — satu-satunya jalan dari "git clone" ke bot yang jalan, tanpa
// menyunting JSON dengan tangan.
//
// Dipanggil index.js SEBELUM config dibaca: kalau config.json belum ada (atau
// pemasangan dipaksa lewat `lp setup` / LPCOPY_SETUP=1), di sini dinyalakan server
// kecil berisi wizard, dan boot normal menunggu sampai orangnya selesai. Setelah
// berkas ditulis, server ini ditutup dan proses yang sama lanjut menyalakan bot —
// tidak perlu restart.
//
// Pembagian tempat menyimpan (mengikuti aturan yang sudah dipakai env.js):
//   rahasia (token dasbor, token bot, API key)  -> .env, mode 600
//   kunci privat wallet                         -> wallet.key_file (~/.lpcopy/key), 600
//   sisanya (port, chain, RPC, aturan, target)  -> config.json, 600
// Kunci privat sengaja TIDAK ke .env: LPCOPY_PRIVATE_KEY mematikan tombol ganti/lepas
// wallet di dasbor, dan orang yang baru memasang belum tentu tahu itu.
//
// Halaman wizard-nya dirender server (src/setup-page.js), mandiri tanpa build —
// `npm ci && npm start` di mesin kosong sudah cukup, web/dist belum perlu ada.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { ethers } = require('ethers');
const { NETWORKS, build } = require('./networks');
const { normalizeCfg, bscTemplate, PRIMARY } = require('./multichain');
const { probeRpc, maskUrl, hasSecret } = require('./settings');
const { CURRENCIES, CURRENCIES_EN } = require('./fx');
const { SETUP_PAGE } = require('./setup-page');

const SETUP_VERSION = 1;

// Pemasangan dijalankan kalau config.json belum ada, atau diminta sendiri. Config
// yang SUDAH ada tidak pernah memicu wizard sendiri — instance lama yang dipasang
// sebelum wizard ini ada tidak boleh tiba-tiba mendarat di halaman pemasangan.
function setupNeeded({ cfgPath, cmd = null, env = process.env }) {
  if (cmd === 'setup' || env.LPCOPY_SETUP === '1') return true;
  return !fs.existsSync(cfgPath);
}

// Instance yang SUDAH pernah jalan lalu kehilangan config.json bukan pemasangan baru —
// itu kecelakaan (salah hapus, rsync salah sasaran). Menyajikan wizard di sana berarti
// pm2 melaporkan "online" padahal bot mati, dan satu klik "Simpan" menindih config lama
// di atas database yang sudah berisi posisi. Jadi: berhenti keras, kecuali pemasangan
// memang diminta sendiri (`lp setup` / LPCOPY_SETUP=1).
function pemasanganTerhalang({ root, cfgPath, diminta = false, dbPath = null }) {
  if (diminta) return null;
  if (fs.existsSync(cfgPath)) return null;
  const db = dbPath || path.join(root, 'data', 'lpcopy.db');
  if (!fs.existsSync(db)) return null;
  return [
    `config.json tidak ada, tapi ${db} sudah berisi riwayat instance ini.`,
    'Ini config yang hilang, bukan pemasangan baru — wizard TIDAK dijalankan supaya config',
    'lama tidak tertimpa di atas database yang sudah terisi.',
    '  kembalikan config.json dari cadangan, atau kalau memang mau memasang ulang:',
    '  LPCOPY_SETUP=1 npm start',
  ].join('\n');
}

// ---- penulis .env ---------------------------------------------------------
// Nilai yang mengandung spasi/#/kutip diapit kutip ganda supaya parseEnv (env.js)
// membacanya utuh.
const quoteEnv = (v) => (/[\s#'"\\]/.test(v) ? `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"` : String(v));

// Sisipkan nilai ke isi .env: baris yang sudah ada diganti di tempat (komentar dan
// urutan berkas contoh tetap utuh), yang belum ada ditambahkan di ujung. Nilai kosong
// TIDAK menghapus apa pun — wizard yang membiarkan kolom kosong berarti "jangan ubah".
function upsertEnv(text, vals) {
  let out = String(text || '');
  const tail = [];
  for (const [k, v] of Object.entries(vals)) {
    if (v == null || v === '') continue;
    const line = `${k}=${quoteEnv(v)}`;
    const re = new RegExp(`^(?:export[ \\t]+)?${k}[ \\t]*=.*$`, 'm');
    // Pengganti berupa fungsi: token bisa berisi $& atau $1 yang akan ditafsirkan
    // sebagai rujukan tangkapan kalau dioper sebagai string.
    if (re.test(out)) out = out.replace(re, () => line);
    else tail.push(line);
  }
  if (tail.length) {
    out = out.replace(/\s*$/, '\n');
    out += `\n# Ditulis oleh pemasangan Quiver ${new Date().toISOString().slice(0, 10)}\n${tail.join('\n')}\n`;
  }
  return out;
}

function writeEnvFile({ envPath, examplePath, vals }) {
  const base = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8')
    : examplePath && fs.existsSync(examplePath) ? fs.readFileSync(examplePath, 'utf8') : '';
  fs.writeFileSync(envPath, upsertEnv(base, vals), { mode: 0o600 });
  try { fs.chmodSync(envPath, 0o600); } catch { /* abaikan */ }
}

// ---- penulis kunci wallet -------------------------------------------------
const keyPathOf = (cfg) => String(cfg?.wallet?.key_file || '~/.lpcopy/key').replace(/^~/, process.env.HOME || '');

// Kunci lama tidak pernah ditimpa diam-diam — aturan yang sama dengan halaman
// Pengaturan: dipindah ke berkas cadangan bertanggal dulu.
function writeKeyFile(p, pk) {
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
  let backup = null;
  if (fs.existsSync(p)) {
    backup = `${p}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(p, backup);
  }
  fs.writeFileSync(p, pk, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* abaikan */ }
  return backup;
}

// ---- penyusun config ------------------------------------------------------
const numOr = (v, dflt) => (Number.isFinite(Number(v)) && String(v).trim() !== '' ? Number(v) : dflt);

// Endpoint dari peramban dibersihkan: hanya kolom yang dikenal, hanya https (atau
// http ke mesin sendiri untuk node lokal).
function cleanEndpoint(e) {
  const url = String(e?.url || '').trim();
  let u;
  try { u = new URL(url); } catch { throw new Error(`URL RPC tidak valid: ${url.slice(0, 60)}`); }
  const lokal = /^(localhost|127\.0\.0\.1|\[::1\])$/i.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && lokal)) throw new Error(`URL RPC harus https: ${maskUrl(url)}`);
  const out = { url };
  if (Number(e.max_batch) > 0) out.max_batch = Math.min(200, Math.round(Number(e.max_batch)));
  if (e.no_logs) out.no_logs = true;
  if (Number(e.max_log_blocks) > 0) out.max_log_blocks = Math.round(Number(e.max_log_blocks));
  if (e.archive) out.archive = true;
  if (e.headers && typeof e.headers === 'object') {
    const h = {};
    for (const [k, v] of Object.entries(e.headers)) if (String(v || '').trim()) h[String(k).slice(0, 64)] = String(v);
    if (Object.keys(h).length) out.headers = h;
  }
  if (e.catatan) out.catatan = String(e.catatan).slice(0, 200);
  return out;
}

// Config akhir = berkas contoh (atau config yang sudah ada, kalau pemasangan diulang)
// ditimpa jawaban wizard. Fungsi murni supaya bisa diuji tanpa menyalakan server.
function buildConfig({ template, base = null, answers }) {
  const cfg = JSON.parse(JSON.stringify(base || template));
  normalizeCfg(cfg);                                   // config lama satu-chain -> chains.*
  const tpl = JSON.parse(JSON.stringify(template));
  normalizeCfg(tpl);
  cfg.chains = cfg.chains || {};

  cfg.display = cfg.display || {};
  cfg.display.currency = answers.display?.currency || null;

  cfg.server = cfg.server || {};
  cfg.server.port = numOr(answers.server?.port, cfg.server.port || 8799);
  cfg.server.host = String(answers.server?.host || cfg.server.host || '127.0.0.1');
  // Rahasia yang ikut ditulis ke .env dikosongkan di config: satu kolom, satu sumber.
  if (answers.secrets?.authToken) cfg.server.auth_token = null;
  if (answers.secrets?.publicUrl) cfg.server.public_url = null;
  if (answers.secrets?.telegramToken) { cfg.telegram = cfg.telegram || {}; cfg.telegram.bot_token = null; }
  if (answers.secrets?.ntfyTopic) { cfg.notify = cfg.notify || {}; cfg.notify.ntfy_topic = null; }
  if (answers.secrets?.gmgnKey) { cfg.gmgn = cfg.gmgn || {}; cfg.gmgn.api_key = null; }

  const cap = answers.capital || {};
  const dryRun = cap.dry_run !== false;
  const aktif = [];
  for (const key of Object.keys(NETWORKS)) {
    const want = answers.chains?.[key] || {};
    const blok = cfg.chains[key] || tpl.chains?.[key] || (key === 'bsc' ? bscTemplate() : null);
    if (!blok) continue;
    cfg.chains[key] = blok;
    blok.enabled = !!want.enabled;
    if (!blok.enabled) continue;
    aktif.push(key);
    blok.chain = blok.chain || {};
    // Daftar endpoint yang tidak dikirim sama sekali = pakai yang sudah ada di config;
    // daftar KOSONG yang dikirim = kesalahan, bukan izin diam-diam memakai bawaan.
    if (Array.isArray(want.endpoints)) {
      if (!want.endpoints.length) throw new Error(`${build(key).label}: belum ada endpoint RPC.`);
      blok.chain.endpoints = want.endpoints.map(cleanEndpoint);
    }
    if (!(blok.chain.endpoints || []).length) throw new Error(`${build(key).label}: belum ada endpoint RPC.`);
    // Alchemy: satu kunci di .env, satu endpoint di depan daftar untuk tiap chain
    // yang punya host-nya (networks.js). URL-nya disimpan sebagai ${ALCHEMY_KEY} —
    // env.js yang menukarnya saat boot, jadi kuncinya tidak pernah masuk config.json.
    const hostAlchemy = NETWORKS[key]?.alchemyHost;
    if (answers.secrets?.alchemyKey && hostAlchemy && !(blok.chain.endpoints || []).some((e) => String(e.url).includes(hostAlchemy))) {
      blok.chain.endpoints = [
        { url: 'https://' + hostAlchemy + '/v2/${ALCHEMY_KEY}', max_batch: 40, archive: true, catatan: 'Alchemy — kuncinya di .env sebagai ALCHEMY_KEY' },
        ...blok.chain.endpoints,
      ];
    }
    blok.mode = { ...(blok.mode || {}), dry_run: dryRun, paused: false };

    // Batas modal dari wizard berlaku sama di tiap chain yang dinyalakan; bedanya
    // diatur belakangan di halaman Aturan.
    blok.rules = blok.rules || {};
    const sz = blok.rules.sizing = { ...(blok.rules.sizing || {}) };
    if (cap.fixed_quote_usd != null && cap.fixed_quote_usd !== '') { sz.mode = 'fixed_quote'; sz.fixed_quote_usd = numOr(cap.fixed_quote_usd, sz.fixed_quote_usd); }
    for (const k of ['min_quote_usd', 'max_quote_per_position_usd', 'max_total_exposure_usd', 'daily_budget_usd']) {
      if (cap[k] != null && cap[k] !== '') sz[k] = numOr(cap[k], sz[k]);
    }

    // Target: ditambahkan, tidak menimpa — daftar di config cuma bibit untuk tabel
    // targets di SQLite (INSERT OR IGNORE saat boot).
    const punya = new Set((blok.targets || []).map((t) => String(t.address || '').toLowerCase()));
    for (const t of answers.targets || []) {
      if ((t.chain || PRIMARY) !== key) continue;
      const addr = String(t.address || '').toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(addr)) throw new Error(`Alamat target tidak valid: ${String(t.address).slice(0, 20)}`);
      if (punya.has(addr)) continue;
      punya.add(addr);
      blok.targets = [...(blok.targets || []), { address: addr, label: String(t.label || '').slice(0, 60) || null, enabled: true }];
    }
  }
  if (!aktif.length) throw new Error('Pilih minimal satu chain.');
  cfg.setup = { completed_ts: Date.now(), version: SETUP_VERSION };
  return cfg;
}

// Tulis semua berkas. Urutannya disengaja: rahasia dulu, config.json paling akhir —
// ia yang menjadi tanda "sudah terpasang", jadi kalau proses mati di tengah jalan
// wizard-nya muncul lagi, bukan bot setengah jadi yang menyala.
function applySetup({ root, cfgPath, envPath, answers, log = () => {} }) {
  const template = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
  const base = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : null;
  const cfg = buildConfig({ template, base, answers });          // validasi sebelum apa pun ditulis

  const s = answers.secrets || {};
  const vals = {
    LPCOPY_AUTH_TOKEN: s.authToken,
    LPCOPY_TELEGRAM_BOT_TOKEN: s.telegramToken,
    LPCOPY_NTFY_TOPIC: s.ntfyTopic,
    LPCOPY_GMGN_API_KEY: s.gmgnKey,
    LPCOPY_DASHBOARD_URL: s.publicUrl,
    ALCHEMY_KEY: s.alchemyKey,
  };
  writeEnvFile({ envPath, examplePath: path.join(root, '.env.example'), vals });
  // Proses ini lanjut menyalakan bot tanpa restart, jadi nilai barunya dipasang
  // sekarang juga: loadDotEnv tidak menimpa variabel yang sudah ada di process.env,
  // dan pada pemasangan yang diulang variabel lamanya sudah telanjur termuat.
  for (const [k, v] of Object.entries(vals)) if (v) process.env[k] = String(v);
  log(`pemasangan: .env ditulis (${envPath})`);

  let wallet = null;
  if (answers.wallet?.privateKey) {
    const p = keyPathOf(cfg);
    const w = new ethers.Wallet(answers.wallet.privateKey);
    const bak = writeKeyFile(p, w.privateKey);
    if (answers.wallet.mnemonic) fs.writeFileSync(`${p}.mnemonic`, answers.wallet.mnemonic, { mode: 0o600 });
    wallet = { address: w.address.toLowerCase(), keyFile: p, backup: bak, mnemonicFile: answers.wallet.mnemonic ? `${p}.mnemonic` : null };
    log(`pemasangan: kunci wallet ditulis (${wallet.address})${bak ? ` — kunci lama dicadangkan: ${path.basename(bak)}` : ''}`);
  }

  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  try { fs.chmodSync(cfgPath, 0o600); } catch { /* abaikan */ }
  log(`pemasangan: config.json ditulis (${cfgPath})`);
  return { cfg, wallet };
}

// ---- server wizard --------------------------------------------------------
// Server ini hidup hanya sampai pemasangan selesai, dan hanya melayani halaman
// wizard + /api/setup/*. Tidak ada rute dasbor di sini: selama belum ada config,
// belum ada database, mesin, atau token — tidak ada yang bisa dibocorkan selain
// yang memang ditanyakan wizard.
const SEC_HEADERS = {
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
};

function readJson(req, max = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > max) { req.destroy(); reject(new Error('badan permintaan kebesaran')); } });
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch { reject(new Error('JSON tidak terbaca')); } });
    req.on('error', reject);
  });
}

// Alamat yang enak dibuka orangnya: 0.0.0.0 / :: tidak bisa diklik.
const bukaUrl = (host, port) => `http://${/^(0\.0\.0\.0|::|)$/.test(host) ? '127.0.0.1' : host}:${port}`;

// Menyalakan wizard dan menunggu sampai berkas ditulis. Promise-nya selesai setelah
// server ditutup rapat — port yang sama langsung dipakai server dasbor sesudahnya.
function runSetup({ root, cfgPath, envPath, diminta = false, log = console.log }) {
  const halangan = pemasanganTerhalang({ root, cfgPath, diminta });
  if (halangan) { log(halangan); return process.exit(1); }
  // Template wajib ada: wizard menyusun config DARI berkas contoh, bukan dari daftar
  // bawaan kedua di dalam kode yang pasti akan menyimpang darinya.
  const tplPath = path.join(root, 'config.example.json');
  if (!fs.existsSync(tplPath)) {
    log(`config.example.json tidak ada di ${root} — wizard pemasangan memakainya sebagai template.`);
    log('  salin dari repo: scp config.example.json <host>:~/<instance>/   (deploy.sh sudah mengirimnya sejak versi ini)');
    return process.exit(1);
  }
  const template = JSON.parse(fs.readFileSync(tplPath, 'utf8'));
  const sourceCfg = fs.existsSync(cfgPath) ? JSON.parse(fs.readFileSync(cfgPath, 'utf8')) : JSON.parse(JSON.stringify(template));
  normalizeCfg(sourceCfg);
  const port = Number(process.env.LPCOPY_SETUP_PORT || sourceCfg.server?.port || 8799);
  const host = String(process.env.LPCOPY_SETUP_HOST || sourceCfg.server?.host || '127.0.0.1');

  // Kode pemasangan. Halaman ini memasang kunci penandatangan dan token dasbor, dan
  // sering dibuka lewat tunnel (cloudflared) walau server-nya sendiri terikat di
  // loopback — jadi kodenya SELALU diminta, bukan cuma saat terikat ke publik.
  // Tercetak di terminal dan disimpan di data/setup-code.txt supaya bisa di-`cat`
  // dari sesi SSH lain.
  const code = crypto.randomBytes(4).toString('hex');
  const codeFile = path.join(root, 'data', 'setup-code.txt');
  try {
    fs.mkdirSync(path.dirname(codeFile), { recursive: true });
    fs.writeFileSync(codeFile, code + '\n', { mode: 0o600 });
  } catch { /* boleh gagal: kodenya tetap tercetak di terminal */ }

  const hits = new Map();
  const blocked = (ip) => { const e = hits.get(ip); return !!e && e.until > Date.now() && e.n >= 10; };
  const fail = (ip) => { const now = Date.now(), e = hits.get(ip); hits.set(ip, { n: (e && e.until > now ? e.n : 0) + 1, until: now + 5 * 60_000 }); };
  const clientIp = (req) => String(req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '?';
  const codeOk = (req) => {
    const a = Buffer.from(String(req.headers['x-setup-code'] || ''));
    const b = Buffer.from(code);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  // Kunci privat tidak pernah kembali ke peramban: ia dibuat/divalidasi di sini,
  // ditahan di memori, dan baru ditulis ke berkas kunci saat wizard diselesaikan.
  let pending = null;

  const chainKeys = Object.keys(NETWORKS);
  const srcEndpoints = (key) => {
    const blok = sourceCfg.chains?.[key] || (key === 'bsc' ? bscTemplate() : null) || {};
    return (blok.chain?.endpoints || []).map((e) => ({ ...e }));
  };
  // Endpoint yang URL-nya memuat rahasia (config lama, pemasangan diulang) dikirim
  // tersamar; peramban merujuknya kembali dengan {ref:i} dan aslinya tidak pernah
  // meninggalkan server.
  const epView = (e, i) => {
    const rahasia = hasSecret(e);
    let hostname = '?';
    try { hostname = new URL(e.url).hostname; } catch { /* biarkan */ }
    return {
      ref: i, url: rahasia ? maskUrl(e.url) : e.url, host: hostname, secret: rahasia,
      max_batch: e.max_batch || 40, no_logs: !!e.no_logs, max_log_blocks: e.max_log_blocks || 0,
      archive: !!e.archive, catatan: e.catatan || '',
    };
  };
  const resolveEps = (key, list) => {
    const src = srcEndpoints(key);
    return (list || []).map((e) => {
      if (e && e.ref != null && e.url == null) {
        const asli = src[Number(e.ref)];
        if (!asli) throw new Error('endpoint tidak dikenal');
        return { ...asli, ...(e.no_logs != null ? { no_logs: !!e.no_logs } : {}), ...(e.archive != null ? { archive: !!e.archive } : {}), ...(e.max_log_blocks != null ? { max_log_blocks: Number(e.max_log_blocks) } : {}) };
      }
      return e;
    }).filter(Boolean);
  };

  const state = () => ({
    ok: true,
    paths: { config: cfgPath, env: envPath, key: keyPathOf(sourceCfg) },
    existing: {
      config: fs.existsSync(cfgPath), env: fs.existsSync(envPath),
      key: fs.existsSync(keyPathOf(sourceCfg)), privateKeyFromEnv: !!process.env.LPCOPY_PRIVATE_KEY,
    },
    server: { port, host, url: bukaUrl(host, port) },
    suggestToken: crypto.randomBytes(18).toString('base64url'),
    currencies: Object.entries(CURRENCIES).map(([kode, nama]) => ({ code: kode, name: nama, nameEn: CURRENCIES_EN[kode] || nama })),
    display: { currency: sourceCfg.display?.currency ?? 'IDR' },
    wallet: pending ? { address: pending.address, mode: pending.mode } : null,
    chains: chainKeys.map((key) => {
      const p = build(key);
      return {
        key, label: p.label, chainId: p.CHAIN_ID, nativeSymbol: p.nativeSymbol, alchemy: !!NETWORKS[key].alchemyHost,
        enabled: sourceCfg.chains?.[key] ? sourceCfg.chains[key].enabled !== false : key === PRIMARY,
        endpoints: srcEndpoints(key).map(epView),
      };
    }),
    capital: {
      dry_run: true,
      ...['fixed_quote_usd', 'min_quote_usd', 'max_quote_per_position_usd', 'max_total_exposure_usd', 'daily_budget_usd']
        .reduce((a, k) => ({ ...a, [k]: template.chains?.[PRIMARY]?.rules?.sizing?.[k] ?? null }), {}),
    },
  });

  return new Promise((resolve, reject) => {
    let selesai = null;
    const json = (res, sc, body) => { res.writeHead(sc, { 'content-type': 'application/json; charset=utf-8', ...SEC_HEADERS }); res.end(JSON.stringify(body)); };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://x');
      const key = `${req.method} ${url.pathname}`;
      try {
        // Ditanya terus oleh peramban setelah "Simpan": begitu jawabannya bukan lagi
        // {setup:true} (server ini sudah mati, dasbor yang menjawab), halaman pindah.
        if (key === 'GET /api/setup/ping') return json(res, 200, { setup: true });

        if (url.pathname.startsWith('/api/setup/')) {
          const ip = clientIp(req);
          if (blocked(ip)) return json(res, 429, { error: 'terlalu banyak percobaan — tunggu 5 menit' });
          if (!codeOk(req)) { fail(ip); return json(res, 401, { error: 'Kode pemasangan salah. Lihat terminal tempat Quiver dijalankan, atau jalankan: cat data/setup-code.txt' }); }
          hits.delete(ip);
        }

        if (key === 'GET /api/setup/state') return json(res, 200, state());

        // Wallet: dibuat/diperiksa sekarang, ditulis nanti. Yang balik ke peramban
        // cuma alamatnya.
        if (key === 'POST /api/setup/wallet') {
          const b = await readJson(req);
          if (b.mode === 'none') { pending = null; return json(res, 200, { ok: true, wallet: null }); }
          if (b.mode === 'generate') {
            const w = ethers.Wallet.createRandom();
            pending = { mode: 'generate', privateKey: w.privateKey, address: w.address.toLowerCase(), mnemonic: w.mnemonic?.phrase || null };
            return json(res, 200, { ok: true, wallet: { address: pending.address, mode: 'generate' } });
          }
          let pk = String(b.privateKey || '').trim();
          if (!/^(0x)?[0-9a-fA-F]{64}$/.test(pk)) return json(res, 200, { error: 'Kunci privat harus 64 karakter hex (boleh diawali 0x).' });
          if (!pk.startsWith('0x')) pk = '0x' + pk;
          let w;
          try { w = new ethers.Wallet(pk); } catch { return json(res, 200, { error: 'Kunci privat tidak valid.' }); }
          pending = { mode: 'import', privateKey: pk, address: w.address.toLowerCase(), mnemonic: null };
          return json(res, 200, { ok: true, wallet: { address: pending.address, mode: 'import' } });
        }

        // Uji satu endpoint — pengujian yang sama dengan halaman Pengaturan, termasuk
        // saran bendera (no_logs / max_log_blocks / archive).
        if (key === 'POST /api/setup/rpc') {
          const b = await readJson(req);
          const ck = String(b.chain || PRIMARY);
          if (!NETWORKS[ck]) return json(res, 200, { error: 'chain tidak dikenal' });
          let ep;
          try { ep = resolveEps(ck, [b.endpoint])[0]; } catch (e) { return json(res, 200, { error: e.message }); }
          if (!ep?.url) return json(res, 200, { error: 'URL RPC kosong' });
          const hasil = await probeRpc({ url: ep.url, headers: ep.headers }, build(ck));
          return json(res, 200, { ok: true, ...hasil });
        }

        if (key === 'POST /api/setup/finish') {
          const b = await readJson(req);
          const answers = { ...b };
          answers.chains = {};
          for (const ck of chainKeys) {
            const want = b.chains?.[ck];
            if (!want?.enabled) { answers.chains[ck] = { enabled: false }; continue; }
            answers.chains[ck] = { enabled: true, endpoints: resolveEps(ck, want.endpoints) };
          }
          answers.wallet = pending ? { privateKey: pending.privateKey, mnemonic: pending.mnemonic } : null;
          if (b.capital?.dry_run === false && !pending && !fs.existsSync(keyPathOf(sourceCfg)) && !process.env.LPCOPY_PRIVATE_KEY) {
            return json(res, 200, { error: 'Mode LIVE butuh wallet — pasang wallet dulu di langkah Wallet.' });
          }
          let hasil;
          try { hasil = applySetup({ root, cfgPath, envPath, answers, log }); }
          catch (e) { return json(res, 200, { error: e.message }); }
          selesai = hasil;
          // Port dasbor diambil dari config yang BARU ditulis: kalau pemasangan
          // dijalankan di port lain (LPCOPY_SETUP_PORT), peramban harus diberi tahu
          // ke mana pindahnya — kalau tidak, ia menunggu di port yang sudah mati.
          const portAkhir = Number(hasil.cfg.server?.port || port);
          json(res, 200, {
            ok: true,
            address: hasil.wallet?.address || null,
            port: portAkhir,
            samePort: portAkhir === port,
            url: bukaUrl(hasil.cfg.server?.host || host, portAkhir),
          });
          // Jawaban dulu, baru tutup — port-nya harus bebas sebelum server dasbor
          // mengikatnya, termasuk koneksi keep-alive yang masih menggantung.
          return setTimeout(() => {
            server.closeAllConnections?.();
            server.close(() => {
              try { fs.unlinkSync(codeFile); } catch { /* sudah hilang */ }
              log('pemasangan selesai — menyalakan Quiver…');
              resolve(selesai);
            });
          }, 100);
        }

        if (url.pathname.startsWith('/api/')) return json(res, 404, { error: 'rute tidak ada' });
        // Sisanya: halaman wizard, jalur mana pun (tautan lama, /dashboard, dll).
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SEC_HEADERS });
        return res.end(SETUP_PAGE());
      } catch (e) {
        return json(res, 400, { error: String(e.message || e) });
      }
    });

    server.on('error', (e) => {
      // Sama seperti server dasbor di index.js: port yang sudah dipakai dijawab dengan
      // petunjuk, bukan tumpahan stack.
      if (e.code === 'EADDRINUSE') {
        log(`port ${port} sudah dipakai — kemungkinan Quiver lain masih jalan.`);
        log(`  cek: lsof -ti tcp:${port}   |   hentikan: lsof -ti tcp:${port} | xargs kill`);
        log(`  atau pasang di port lain: LPCOPY_SETUP_PORT=8800 npm start`);
        return process.exit(1);
      }
      reject(e);
    });
    // Spanduk ini dwibahasa walau sisa log Indonesia: ia pintu masuk pemasangan, dan
    // halaman wizard-nya sendiri bawaannya Inggris (src/setup-page.js).
    server.listen(port, host, () => {
      const garis = '─'.repeat(52);
      log(`\n┌${garis}┐`);
      log(`│  Quiver — first-run setup · pemasangan awal`);
      log(`│  Open / buka  : ${bukaUrl(host, port)}`);
      log(`│  Setup code   : ${code}`);
      log(`│  (also in / tersimpan juga di ${path.relative(root, codeFile)})`);
      log(`└${garis}┘\n`);
      // pm2 melaporkan proses ini "online" walau botnya belum jalan — katakan terang-terangan.
      if (process.env.pm_id !== undefined) log('PERHATIAN: bot BELUM berjalan — instance ini sedang menunggu pemasangan diselesaikan.');
    });
  });
}

module.exports = { setupNeeded, pemasanganTerhalang, upsertEnv, writeEnvFile, buildConfig, applySetup, cleanEndpoint, keyPathOf, writeKeyFile, runSetup, SETUP_VERSION };
