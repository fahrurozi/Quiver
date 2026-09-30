'use strict';
// Offline tool: open the encrypted V3 keystore (downloaded via the "Ekspor wallet" button in
// the dashboard) into a raw private key, to import into wallets that do not accept the
// JSON keystore format (e.g. OKX Wallet — only accepts a private key/recovery phrase).
//
// Deliberately NOT on the dashboard path: the raw private key only ever appears in this local
// terminal and never goes over the network. Run: npm run export-key -- <keystore.json>
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { ethers } = require('ethers');

// Password prompt that does not echo keystrokes to the screen (a plain readline shows what is
// typed; here _writeToOutput is muted except for the prompt & newlines).
function askHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const outWrite = rl._writeToOutput.bind(rl);
    rl._writeToOutput = (s) => { if (s === question || s === '\n' || s === '\r\n') outWrite(s); };
    rl.question(question, (v) => { rl.history = rl.history.slice(1); rl.close(); process.stdout.write('\n'); resolve(v); });
  });
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('pakai: npm run export-key -- <path-ke-keystore.json>');
    process.exit(1);
  }
  const p = path.resolve(file);
  if (!fs.existsSync(p)) { console.error(`berkas tidak ditemukan: ${p}`); process.exit(1); }
  const json = fs.readFileSync(p, 'utf8');

  const pass = process.env.QUIVER_KEYSTORE_PASSWORD || await askHidden('Password keystore: ');
  console.log('membuka keystore… (butuh beberapa detik, scrypt sengaja lambat)');
  let wallet;
  try {
    wallet = await ethers.Wallet.fromEncryptedJson(json, pass);
  } catch (e) {
    console.error(`gagal membuka: ${e.shortMessage || e.message}`);
    process.exit(1);
  }

  console.log('\n=== JANGAN discreenshot / disalin ke aplikasi catatan ===');
  console.log(`Alamat       : ${wallet.address}`);
  console.log(`Kunci privat : ${wallet.privateKey}`);
  console.log('===========================================================');
  console.log('\nSetelah dipakai (mis. diimpor ke OKX Wallet), bersihkan jejaknya:');
  console.log('  - Terminal.app: Cmd+K (atau `history -d $(history 1)` di shell ini)');
  console.log('  - Jangan biarkan baris di atas nangkring di scrollback lama.');
}

main();
