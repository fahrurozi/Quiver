// Sensor nilai portofolio: satu sakelar yang menutup semua angka dolar milik kita
// (saldo, modal, PnL, fee, jumlah token) — untuk berbagi layar, merekam, atau
// membuka dasbor di tempat umum tanpa memamerkan besar dompet.
//
// Yang ditutup ada di pemformat (fmt.js `usd`/`fmtQty`, currency.js `fxFormat`),
// bukan di tiap komponen: angka baru yang ditambahkan nanti otomatis ikut
// tersensor, dan tidak ada halaman yang lupa. Persen sengaja dibiarkan — "+12%"
// tidak membuka besar modal, dan tanpanya dasbor kehilangan isinya.
//
// Data pasar (volume, likuiditas, MCap) dan angka wallet target lewat `kUsd`, dan
// tidak ikut: itu angka publik orang lain, bukan milik kita.
//
// Dua lapis keadaan:
//  - bawaan: Pengaturan → Tampilan (config `display.hide_values`), datang lewat
//    /api/overview. Tiap tab baru mulai dari sini.
//  - ikon mata: membuka/menutup untuk TAB INI saja (sessionStorage). Sekali
//    mengintip tidak boleh membuat tab berikutnya ikut terbuka — kalau bawaannya
//    tersensor, yang dibuka besok pagi di kafe harus tetap tersensor.
// Bawaan terakhir juga disimpan di localStorage supaya halaman tidak sempat
// memperlihatkan angka sebelum poll pertama tiba.
import { useEffect, useState } from 'react';

const DEF_KEY = 'lpcopy-privacy-default';
const TAB_KEY = 'lpcopy-privacy';
export const MASK = '•••••';

const read = (store, k) => { try { return store.getItem(k); } catch { return null; } };
const write = (store, k, v) => { try { store.setItem(k, v); } catch { /* abaikan */ } };

let fallback = read(localStorage, DEF_KEY) === '1';
let override = read(sessionStorage, TAB_KEY);   // '1' | '0' | null
let hidden = override != null ? override === '1' : fallback;
const listeners = new Set();

function apply() {
  const next = override != null ? override === '1' : fallback;
  if (next === hidden) return;
  hidden = next;
  listeners.forEach((f) => f(hidden));
}

export const isHidden = () => hidden;
// Dari poll /api/overview: bawaan yang dipasang di Pengaturan.
export function setDefaultHidden(v) {
  fallback = !!v;
  write(localStorage, DEF_KEY, fallback ? '1' : '0');
  apply();
}
export function toggleHidden() {
  override = hidden ? '0' : '1';
  write(sessionStorage, TAB_KEY, override);
  apply();
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

// Pengaturan bawaan baru saja diubah dari tab ini: pilihan ikon mata sebelumnya
// dilepas, supaya yang terlihat langsung sama dengan yang baru dipilih.
export function followDefault(v) {
  override = null;
  try { sessionStorage.removeItem(TAB_KEY); } catch { /* abaikan */ }
  setDefaultHidden(v);
}
