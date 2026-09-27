'use strict';
// Uji pemasangan awal (src/setup.js): penyusun config, penulis .env, dan wizard-nya
// sebagai server sungguhan — kode pemasangan, pembuatan wallet, sampai berkas ditulis
// dan port-nya dilepas lagi untuk dasbor.
//
// Jalankan: node test/pemasangan.js
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupNeeded, pemasanganTerhalang, upsertEnv, buildConfig, applySetup, cleanEndpoint, runSetup } = require('../src/setup');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  GAGAL ${name}\n       ${e.stack.split('\n').slice(0, 3).join('\n       ')}`); }
}

const ROOT = path.join(__dirname, '..');
const TEMPLATE = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'quiver-setup-'));

// Jawaban wizard yang lazim: Robinhood saja, simulasi, satu target.
const jawaban = (extra = {}) => ({
  display: { currency: 'IDR' },
  secrets: { authToken: 'token-dasbor-yang-panjang', ...(extra.secrets || {}) },
  capital: { dry_run: true, fixed_quote_usd: 12, max_quote_per_position_usd: 20, max_total_exposure_usd: 60, daily_budget_usd: 60, ...(extra.capital || {}) },
  chains: extra.chains || {
    robinhood: { enabled: true, endpoints: [{ url: 'https://robinhood-rpc.publicnode.com', max_batch: 40, no_logs: true }] },
    bsc: { enabled: false },
  },
  targets: extra.targets || [{ chain: 'robinhood', address: '0x' + '11'.repeat(20), label: 'target satu' }],
  wallet: extra.wallet || null,
});

(async () => {
  console.log('\nkapan pemasangan dijalankan');
  await t('config.json belum ada -> wizard', () => {
    const d = tmpdir();
    assert.equal(setupNeeded({ cfgPath: path.join(d, 'config.json'), env: {} }), true);
  });
  await t('config.json sudah ada -> boot biasa (instance lama tidak terseret)', () => {
    const d = tmpdir();
    const p = path.join(d, 'config.json');
    fs.writeFileSync(p, '{}');
    assert.equal(setupNeeded({ cfgPath: p, env: {} }), false);
  });
  await t('bisa dipaksa lewat `lp setup` dan LPCOPY_SETUP=1', () => {
    const d = tmpdir();
    const p = path.join(d, 'config.json');
    fs.writeFileSync(p, '{}');
    assert.equal(setupNeeded({ cfgPath: p, cmd: 'setup', env: {} }), true);
    assert.equal(setupNeeded({ cfgPath: p, env: { LPCOPY_SETUP: '1' } }), true);
  });

  await t('config hilang di instance yang sudah berisi data -> wizard DITOLAK', () => {
    const d = tmpdir();
    fs.mkdirSync(path.join(d, 'data'));
    fs.writeFileSync(path.join(d, 'data', 'lpcopy.db'), 'pura-pura database');
    const cfgPath = path.join(d, 'config.json');
    const pesan = pemasanganTerhalang({ root: d, cfgPath });
    assert.match(pesan || '', /config yang hilang/i);
    // Tapi kalau memang diminta sendiri, wizard tetap boleh jalan.
    assert.equal(pemasanganTerhalang({ root: d, cfgPath, diminta: true }), null);
  });
  await t('instal benar-benar baru (tanpa database) tidak dihalangi', () => {
    const d = tmpdir();
    assert.equal(pemasanganTerhalang({ root: d, cfgPath: path.join(d, 'config.json') }), null);
  });
  await t('config masih ada -> tidak ada yang dihalangi', () => {
    const d = tmpdir();
    const cfgPath = path.join(d, 'config.json');
    fs.writeFileSync(cfgPath, '{}');
    fs.mkdirSync(path.join(d, 'data'));
    fs.writeFileSync(path.join(d, 'data', 'lpcopy.db'), 'x');
    assert.equal(pemasanganTerhalang({ root: d, cfgPath }), null);
  });

  console.log('\npenulis .env');
  await t('nilai yang sudah ada diganti di tempat, komentar tetap', () => {
    const awal = '# catatan penting\nLPCOPY_AUTH_TOKEN=\n\n# lain\nALCHEMY_KEY=lama\n';
    const out = upsertEnv(awal, { LPCOPY_AUTH_TOKEN: 'baru', ALCHEMY_KEY: 'kunci2' });
    assert.match(out, /# catatan penting/);
    assert.match(out, /^LPCOPY_AUTH_TOKEN=baru$/m);
    assert.match(out, /^ALCHEMY_KEY=kunci2$/m);
    assert.doesNotMatch(out, /lama/);
  });
  await t('variabel yang belum ada ditambahkan di ujung', () => {
    const out = upsertEnv('LPCOPY_AUTH_TOKEN=x\n', { LPCOPY_NTFY_TOPIC: 'quiver-abc' });
    assert.match(out, /^LPCOPY_NTFY_TOPIC=quiver-abc$/m);
  });
  await t('kolom kosong tidak menghapus nilai lama', () => {
    const out = upsertEnv('LPCOPY_GMGN_API_KEY=simpan-aku\n', { LPCOPY_GMGN_API_KEY: '', LPCOPY_AUTH_TOKEN: null });
    assert.match(out, /^LPCOPY_GMGN_API_KEY=simpan-aku$/m);
  });
  await t('token berisi $& atau spasi tetap utuh', () => {
    const tok = 'a$&b c"d';
    const out = upsertEnv('LPCOPY_AUTH_TOKEN=\n', { LPCOPY_AUTH_TOKEN: tok });
    const { parseEnv } = require('../src/env');
    assert.equal(parseEnv(out).LPCOPY_AUTH_TOKEN, tok);
  });
  await t('baris `export KEY=` juga dikenali', () => {
    const out = upsertEnv('export ALCHEMY_KEY=lama\n', { ALCHEMY_KEY: 'baru' });
    assert.match(out, /^ALCHEMY_KEY=baru$/m);
    assert.doesNotMatch(out, /lama/);
  });

  console.log('\npenyusun config');
  await t('chain yang tidak dipilih dimatikan, yang dipilih memakai endpoint wizard', () => {
    const cfg = buildConfig({ template: TEMPLATE, answers: jawaban() });
    assert.equal(cfg.chains.bsc.enabled, false);
    assert.equal(cfg.chains.robinhood.enabled, true);
    assert.deepEqual(cfg.chains.robinhood.chain.endpoints.map((e) => e.url), ['https://robinhood-rpc.publicnode.com']);
    assert.equal(cfg.chains.robinhood.chain.endpoints[0].no_logs, true);
  });
  await t('batas modal & mode simulasi ditulis ke tiap chain yang aktif', () => {
    const cfg = buildConfig({
      template: TEMPLATE,
      answers: jawaban({ chains: { robinhood: { enabled: true, endpoints: [{ url: 'https://a.contoh/rpc' }] }, bsc: { enabled: true, endpoints: [{ url: 'https://b.contoh/rpc' }] } } }),
    });
    for (const k of ['robinhood', 'bsc']) {
      assert.equal(cfg.chains[k].mode.dry_run, true, k);
      assert.equal(cfg.chains[k].rules.sizing.mode, 'fixed_quote', k);
      assert.equal(cfg.chains[k].rules.sizing.fixed_quote_usd, 12, k);
      assert.equal(cfg.chains[k].rules.sizing.max_total_exposure_usd, 60, k);
    }
  });
  await t('target masuk ke chain-nya sendiri, huruf kecil', () => {
    const cfg = buildConfig({
      template: TEMPLATE,
      answers: jawaban({
        chains: { robinhood: { enabled: true, endpoints: [{ url: 'https://a.contoh/rpc' }] }, bsc: { enabled: true, endpoints: [{ url: 'https://b.contoh/rpc' }] } },
        targets: [{ chain: 'bsc', address: '0x' + 'AB'.repeat(20), label: 'di bsc' }],
      }),
    });
    assert.equal(cfg.chains.robinhood.targets.length, 0);
    assert.equal(cfg.chains.bsc.targets[0].address, '0x' + 'ab'.repeat(20));
    assert.equal(cfg.chains.bsc.targets[0].label, 'di bsc');
  });
  await t('target yang sudah ada di config lama tidak digandakan', () => {
    const base = JSON.parse(JSON.stringify(TEMPLATE));
    base.chains.robinhood.targets = [{ address: '0x' + '11'.repeat(20), label: 'lama' }];
    const cfg = buildConfig({ template: TEMPLATE, base, answers: jawaban() });
    assert.equal(cfg.chains.robinhood.targets.length, 1);
    assert.equal(cfg.chains.robinhood.targets[0].label, 'lama');
  });
  await t('rahasia tidak ikut ke config.json — kolomnya dikosongkan', () => {
    const cfg = buildConfig({
      template: TEMPLATE,
      answers: jawaban({ secrets: { authToken: 'rahasia-panjang-sekali', telegramToken: '123:abc', ntfyTopic: 'quiver-x', gmgnKey: 'gm', publicUrl: 'https://lp.uji-saya.test' } }),
    });
    const teks = JSON.stringify(cfg);
    assert.equal(cfg.server.auth_token, null);
    assert.equal(cfg.telegram.bot_token, null);
    assert.equal(cfg.notify.ntfy_topic, null);
    assert.equal(cfg.gmgn.api_key, null);
    assert.equal(cfg.server.public_url, null);
    for (const r of ['rahasia-panjang-sekali', '123:abc', 'quiver-x', 'lp.uji-saya.test']) assert.ok(!teks.includes(r), `${r} bocor ke config`);
  });
  await t('Alchemy: endpoint di depan, kuncinya tetap ${ALCHEMY_KEY}', () => {
    const cfg = buildConfig({ template: TEMPLATE, answers: jawaban({ secrets: { authToken: 'token-dasbor-yang-panjang', alchemyKey: 'kunci-rahasia' } }) });
    const first = cfg.chains.robinhood.chain.endpoints[0];
    assert.match(first.url, /robinhood-mainnet\.g\.alchemy\.com\/v2\/\$\{ALCHEMY_KEY\}$/);
    assert.ok(!JSON.stringify(cfg).includes('kunci-rahasia'));
  });
  await t('setiap pemasangan meninggalkan cap waktunya', () => {
    const cfg = buildConfig({ template: TEMPLATE, answers: jawaban() });
    assert.ok(cfg.setup.completed_ts > 0);
  });
  await t('tanpa chain / tanpa RPC / alamat ngawur ditolak sebelum ada yang ditulis', () => {
    assert.throws(() => buildConfig({ template: TEMPLATE, answers: jawaban({ chains: { robinhood: { enabled: false }, bsc: { enabled: false } } }) }), /minimal satu chain/i);
    assert.throws(() => buildConfig({ template: TEMPLATE, answers: jawaban({ chains: { robinhood: { enabled: true, endpoints: [] }, bsc: { enabled: false } } }) }), /endpoint RPC/i);
    assert.throws(() => buildConfig({ template: TEMPLATE, answers: jawaban({ targets: [{ chain: 'robinhood', address: 'bukan-alamat' }] }) }), /tidak valid/i);
  });
  await t('URL RPC http ke mesin lain ditolak, ke localhost boleh', () => {
    assert.throws(() => cleanEndpoint({ url: 'http://rpc.contoh.com' }), /https/);
    assert.equal(cleanEndpoint({ url: 'http://127.0.0.1:8545' }).url, 'http://127.0.0.1:8545');
  });

  console.log('\nmenulis berkas');
  await t('config 600, .env 600, kunci 600 — dan config.json ditulis paling akhir', () => {
    const d = tmpdir();
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(d, 'config.example.json'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(d, '.env.example'));
    const home = tmpdir();
    const homeAsli = process.env.HOME;
    process.env.HOME = home;
    try {
      const pk = '0x' + '42'.repeat(32);
      const r = applySetup({
        root: d, cfgPath: path.join(d, 'config.json'), envPath: path.join(d, '.env'),
        answers: jawaban({ secrets: { authToken: 'token-dasbor-yang-panjang', ntfyTopic: 'quiver-abc' }, wallet: { privateKey: pk, mnemonic: 'kata kata rahasia' } }),
      });
      const mode = (p) => (fs.statSync(p).mode & 0o777).toString(8);
      assert.equal(mode(path.join(d, 'config.json')), '600');
      assert.equal(mode(path.join(d, '.env')), '600');
      assert.equal(mode(path.join(home, '.lpcopy', 'key')), '600');
      assert.equal(fs.readFileSync(path.join(home, '.lpcopy', 'key'), 'utf8'), pk);
      assert.equal(fs.readFileSync(path.join(home, '.lpcopy', 'key.mnemonic'), 'utf8'), 'kata kata rahasia');
      assert.match(fs.readFileSync(path.join(d, '.env'), 'utf8'), /^LPCOPY_NTFY_TOPIC=quiver-abc$/m);
      assert.equal(r.wallet.address, new (require('ethers').Wallet)(pk).address.toLowerCase());
    } finally { process.env.HOME = homeAsli; }
  });
  await t('kunci lama dicadangkan, tidak ditimpa', () => {
    const d = tmpdir();
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(d, 'config.example.json'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(d, '.env.example'));
    const home = tmpdir();
    const homeAsli = process.env.HOME;
    process.env.HOME = home;
    try {
      fs.mkdirSync(path.join(home, '.lpcopy'), { recursive: true });
      fs.writeFileSync(path.join(home, '.lpcopy', 'key'), '0x' + '11'.repeat(32), { mode: 0o600 });
      applySetup({
        root: d, cfgPath: path.join(d, 'config.json'), envPath: path.join(d, '.env'),
        answers: jawaban({ wallet: { privateKey: '0x' + '42'.repeat(32) } }),
      });
      const bak = fs.readdirSync(path.join(home, '.lpcopy')).filter((f) => f.startsWith('key.bak-'));
      assert.equal(bak.length, 1);
      assert.equal(fs.readFileSync(path.join(home, '.lpcopy', bak[0]), 'utf8'), '0x' + '11'.repeat(32));
    } finally { process.env.HOME = homeAsli; }
  });

  console.log('\ndwibahasa halaman wizard');
  await t('bawaannya Inggris, dan pilihannya dipakai bersama dasbor', () => {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'setup-page.js'), 'utf8');
    assert.match(src, /return 'en';/, 'bahasa bawaan wizard harus Inggris');
    assert.match(src, /localStorage\.setItem\('lpcopy-lang'/, "pilihan bahasa harus disimpan di kunci yang sama dengan dasbor");
    assert.match(src, /<html lang="en">/);
  });
  await t('setiap teks yang diterjemahkan punya entri Inggris', () => {
    // Penjaga yang sama semangatnya dengan web/check-keys.py: kalau nanti ada kalimat
    // baru dibungkus t() tapi lupa diberi terjemahan, UI Inggris akan menyelipkan
    // kalimat Indonesia — uji ini yang menangkapnya.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'setup-page.js'), 'utf8');
    const js = src.slice(src.indexOf('const JS = '), src.indexOf('const SETUP_PAGE'));
    const dict = new Set();
    for (const m of js.matchAll(/^\s*"((?:\\.|[^"])*)":\s*"/gm)) dict.add(m[1].replace(/\\\$/g, '$'));
    const used = new Set();
    for (const m of js.matchAll(/\bt\(\s*'((?:\\.|[^'])*)'/g)) used.add(m[1].replace(/\\'/g, "'").replace(/\\\$/g, '$'));
    for (const m of js.matchAll(/\bt\([^)]*?\?\s*'((?:\\.|[^'])*)'\s*:\s*'((?:\\.|[^'])*)'/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of js.matchAll(/pick\('[a-z]+',\s*'((?:\\.|[^'])*)',\s*'((?:\\.|[^'])*)'\)/g)) { used.add(m[1]); used.add(m[2]); }
    for (const m of /var TITLES = \[([^\]]*)\]/.exec(js)[1].matchAll(/'([^']*)'/g)) used.add(m[1]);
    for (const m of js.matchAll(/return '([A-Z][^']{10,})';/g)) used.add(m[1]);
    assert.ok(dict.size > 100, `kamus terlalu kecil (${dict.size})`);
    // 'Telegram' sama di dua bahasa — tidak perlu entri.
    const kurang = [...used].filter((x) => x && x !== 'Telegram' && !dict.has(x));
    assert.deepEqual(kurang, [], `tanpa terjemahan Inggris: ${kurang.join(' | ').slice(0, 300)}`);
  });

  console.log('\nwizard sebagai server');
  await t('kode salah ditolak, kode benar membuka /state, finish menulis & melepas port', async () => {
    const d = tmpdir();
    fs.copyFileSync(path.join(ROOT, 'config.example.json'), path.join(d, 'config.example.json'));
    fs.copyFileSync(path.join(ROOT, '.env.example'), path.join(d, '.env.example'));
    const home = tmpdir();
    const homeAsli = process.env.HOME;
    const port = 8900 + Math.floor(Math.random() * 90);
    process.env.HOME = home;
    process.env.LPCOPY_SETUP_PORT = String(port);
    process.env.LPCOPY_SETUP_HOST = '127.0.0.1';
    const cfgPath = path.join(d, 'config.json');
    try {
      const selesai = runSetup({ root: d, cfgPath, envPath: path.join(d, '.env'), log: () => {} });
      const code = fs.readFileSync(path.join(d, 'data', 'setup-code.txt'), 'utf8').trim();
      const url = (p) => `http://127.0.0.1:${port}${p}`;
      const get = (p, kode) => fetch(url(p), { headers: { 'x-setup-code': kode } });
      const post = (p, body, kode) => fetch(url(p), { method: 'POST', headers: { 'content-type': 'application/json', 'x-setup-code': kode }, body: JSON.stringify(body) });

      const halaman = await fetch(url('/'));
      assert.equal(halaman.status, 200);
      assert.match(await halaman.text(), /pemasangan/i);

      assert.equal((await get('/api/setup/state', 'salah123')).status, 401);
      const st = await (await get('/api/setup/state', code)).json();
      assert.equal(st.ok, true);
      assert.equal(st.chains.length, 2);
      assert.ok(st.suggestToken.length >= 20);
      assert.ok(st.chains[0].endpoints.length > 0);

      const w = await (await post('/api/setup/wallet', { mode: 'generate' }, code)).json();
      assert.match(w.wallet.address, /^0x[0-9a-f]{40}$/);
      const teksBalasan = JSON.stringify(w);
      assert.ok(!/[0-9a-f]{64}/.test(teksBalasan), 'kunci privat ikut terkirim ke peramban');

      const r = await (await post('/api/setup/finish', {
        display: { currency: 'IDR' },
        secrets: { authToken: 'token-dasbor-yang-panjang' },
        capital: { dry_run: true, fixed_quote_usd: 12 },
        chains: { robinhood: { enabled: true, endpoints: [{ ref: 0 }] }, bsc: { enabled: false } },
        targets: [],
      }, code)).json();
      assert.equal(r.ok, true);
      assert.equal(r.address, w.wallet.address);

      await selesai;
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      assert.equal(cfg.chains.robinhood.enabled, true);
      assert.equal(cfg.chains.bsc.enabled, false);
      assert.equal(cfg.chains.robinhood.chain.endpoints[0].url, TEMPLATE.chains.robinhood.chain.endpoints[0].url);
      assert.equal(process.env.LPCOPY_AUTH_TOKEN, 'token-dasbor-yang-panjang');
      assert.ok(!fs.existsSync(path.join(d, 'data', 'setup-code.txt')), 'kode pemasangan harus dihapus setelah selesai');
      // Port harus benar-benar bebas: server dasbor mengikatnya sesaat kemudian.
      const uji = require('node:http').createServer(() => {});
      await new Promise((res, rej) => { uji.once('error', rej); uji.listen(port, '127.0.0.1', res); });
      await new Promise((res) => uji.close(res));
    } finally {
      process.env.HOME = homeAsli;
      delete process.env.LPCOPY_SETUP_PORT;
      delete process.env.LPCOPY_SETUP_HOST;
      delete process.env.LPCOPY_AUTH_TOKEN;
    }
  });

  console.log(`\n${pass} lulus, ${fail} gagal`);
  process.exit(fail ? 1 : 0);
})();
