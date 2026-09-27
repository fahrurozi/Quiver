// Sensor nilai portofolio: satu sakelar yang menutup semua angka dolar milik kita
// (saldo, modal, PnL, fee, jumlah token) — untuk berbagi layar, merekam, atau
// membuka dasbor di tempat umum tanpa memamerkan besar dompet.
//
// Yang ditutup ada di pemformat (fmt.js `usd`/`fmtQty`, currency.js `fxText`),
// bukan di tiap komponen: angka baru yang ditambahkan nanti otomatis ikut
// tersensor, dan tidak ada halaman yang lupa. Persen sengaja dibiarkan — "+12%"
// tidak membuka besar modal, dan tanpanya dasbor kehilangan isinya.
//
// Data pasar (volume, likuiditas, MCap) dan angka wallet target lewat `kUsd`, dan
// tidak ikut: itu angka publik orang lain, bukan milik kita.
//
// SATU sakelar untuk semuanya: ikon mata, Pengaturan → Tampilan, dan ikon mata
// mini app Telegram menulis ke tempat yang sama — config `display.hide_values`
// di server — dan semua tab/perangkat membacanya lewat poll /api/overview.
// Menekan mata di HP ikut menutup dasbor yang sedang terbuka di laptop.
// Nilai terakhir disimpan di localStorage supaya halaman tidak sempat
// memperlihatkan angka sebelum poll pertama tiba.
import { useEffect, useState } from 'react';
import { post } from './api';

const KEY = 'lpcopy-privacy-default';
export const MASK = '•••••';

let hidden = false;
try { hidden = localStorage.getItem(KEY) === '1'; } catch { /* abaikan */ }
let pending = 0;   // simpanan yang belum dijawab server
let lastToggle = 0;
// Poll yang berangkat sebelum mata ditekan bisa tiba sesudahnya membawa nilai lama;
// jeda ini lebih panjang dari satu putaran poll (5 detik) supaya ia tidak membaliknya.
const SETTLE_MS = 6000;
const listeners = new Set();

function set(v) {
  v = !!v;
  try { localStorage.setItem(KEY, v ? '1' : '0'); } catch { /* abaikan */ }
  if (v === hidden) return;
  hidden = v;
  listeners.forEach((f) => f(hidden));
}

export const isHidden = () => hidden;
// Dari poll /api/overview.
export function setDefaultHidden(v) {
  if (!pending && Date.now() - lastToggle > SETTLE_MS) set(v);
}

// Ikon mata: langsung berganti di tab ini, lalu disimpan ke server untuk semua.
// Gagal tersimpan -> kembali ke keadaan semula, supaya yang terlihat tidak bohong.
export async function toggleHidden() {
  const next = !hidden;
  set(next);
  pending++;
  lastToggle = Date.now();
  let r;
  try { r = await post('/api/settings/display', { hide_values: next }); }
  catch (e) { r = { error: e.message }; }
  pending--;
  if (r?.error) set(!next);
  return r;
}

// Komponen ikut tergambar ulang saat sensor dinyalakan/dimatikan.
export function usePrivacy() {
  const [v, setV] = useState(hidden);
  useEffect(() => {
    const f = (x) => setV(x);
    listeners.add(f);
    f(hidden);
    return () => listeners.delete(f);
  }, []);
  return [v, toggleHidden];
}
