// Sisi target atas posisi KITA — dipakai laci riwayat posisi dan halaman detail
// posisi, supaya pertanyaan yang sama dijawab di tempat yang sama di kedua layar.
//
// Kebalikan blok "Salinan kita" di laci wallet: di sana posisinya milik orang lain
// dan yang hilang adalah angka kita; di sini posisinya milik kita dan yang hilang
// adalah angka orang yang ditiru. Pertanyaan yang selalu menyusul PnL sendiri —
// "kita rugi $41, yang kita tiru sendiri untung atau buntung?" — dulu butuh dua
// halaman lain: kolom Asal di tabel Posisi, lalu laci posisi di halaman wallet.
//
// Dua sumber angka, sengaja dipisah karena umur dan isinya berbeda:
//  - `mirror` (hasil riset wallet): PnL lengkap — fee dan token sisa yang dijual
//    ikut terhitung — tapi baru ada setelah wallet itu dipindai, dan untuk posisi
//    yang masih terbuka nilainya sebesar pemindaian terakhir, bukan harga sekarang.
//  - `watch` (aksi yang benar-benar dilihat pemantau): selalu segar, tapi POKOK
//    saja — aksi 'claim' tidak membawa nilai, jadi hasilnya lantai, bukan laba pasti.
// Dolarnya tidak bisa diadu (modal kita hampir tidak pernah sebesar modal dia),
// jadi yang disandingkan persen terhadap modal masing-masing.
import { Chip } from '@heroui/react';
import { Crosshair } from 'lucide-react';
import { Fig } from './ui';
import { usd, pct, tone, age, ago, short } from '../fmt';
import { useI18n } from '../i18n';

export default function TargetSide({ p, className = 'mb-4' }) {
  const { t } = useI18n();
  if (!p.target) {
    return (
      <div className={`rounded-lg border border-border p-3 ${className}`}>
        <div className="text-sm font-medium">{t('Tidak meniru siapa pun')}</div>
        <p className="mt-1 text-xs text-muted">{t('Posisi ini tidak menyalin target mana pun: dibuka manual, atau sudah ada di wallet sebelum bot memantaunya.')}</p>
      </div>
    );
  }
  const o = p.origin || null;
  const m = o?.mirror || null;
  const w = o?.watch || null;
  const riset = !!m;
  const nft = p.mirror_of || o?.tokenId || null;
  const label = p.targetLabel || o?.targetLabel || null;
  // Satu blok = satu sumber. Modal dari riset disandingkan dengan tarikan yang
  // terpantau akan mencampur dua pembukuan yang tidak pernah persis sama; angka
  // tengahnya karena itu ikut sumber yang sedang dipakai.
  const modal = riset ? m.costUsd : (w && w.inUsd > 0.005 ? w.inUsd : null);
  const hasil = riset
    ? (m.costUsd != null && m.pnlUsd != null ? m.costUsd + m.pnlUsd : null)
    : (w && w.outUsd > 0.005 ? w.outUsd : null);
  const pnl = riset ? m.pnlUsd : (w?.pnlUsd ?? null);
  const pnlPct = riset ? m.pnlPct : (w?.pnlPct ?? null);
  const buka = riset ? m.status === 'open' : !!w?.open;
  const kita = p.costUsd > 0 && p.pnlUsd != null ? (p.pnlUsd / p.costUsd) * 100 : null;
  const angka = [modal != null, hasil != null, pnl != null].filter(Boolean).length;
  return (
    <div className={`rounded-lg border border-border p-3 ${className}`}>
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <span className="flex flex-wrap items-center gap-2 text-sm font-medium">
          <Crosshair className="size-4 shrink-0 text-muted" />
          {t('Posisi yang kita tiru')}
          {(riset || w) && <Chip size="sm" variant="soft" color={buka ? 'success' : 'default'}>{t(buka ? 'Dia masih di dalam' : 'Dia sudah keluar')}</Chip>}
          {p.takeover_ts != null && p.status !== 'closed' && (
            <span title={t('Diambil alih {w} — bot tidak mengikuti target dan tidak menutup otomatis.', { w: ago(p.takeover_ts) })}>
              <Chip size="sm" variant="soft" color="warning">{t('Kendali manual')}</Chip>
            </span>
          )}
        </span>
        <a href={'#targets/' + p.target} className="min-w-0 text-xs text-accent hover:underline" title={p.target}>
          {label || short(p.target)}{nft ? ` · #${nft}` : ''}
        </a>
      </div>
      {angka === 0 ? (!w && (
        <div className="text-xs text-muted">
          {t('Hasil posisi aslinya belum diketahui: wallet target ini belum diriset, dan pemantau belum mencatat satu aksi pun di posisi itu.')}
        </div>
      )) : (
        <div className={`grid gap-3 ${angka >= 3 ? 'grid-cols-3' : 'grid-cols-2'}`}>
          {modal != null && <Fig label={riset ? 'Modal dia' : 'Dia taruh'} value={usd(modal)} />}
          {hasil != null && <Fig label={riset ? (buka ? 'Nilai dia' : 'Dia dapat') : 'Dia tarik'} value={usd(hasil)}
            sub={!riset && w.claims > 0 ? t('+{n} klaim fee', { n: w.claims }) : null} />}
          {pnl != null && <Fig label={buka ? 'Hasil dia (sementara)' : 'Hasil dia'} value={usd(pnl)} cls={tone(pnl)}
            sub={pnlPct == null ? null : pct(pnlPct, 2)} />}
        </div>
      )}
      {pnlPct != null && kita != null && (
        <div className="mt-2 text-xs text-muted">
          {t('Target {a} atas modalnya · kita {b} atas modal kita', { a: pct(pnlPct, 2), b: pct(kita, 2) })}
        </div>
      )}
      {/* Kenapa angkanya boleh berbeda dengan yang kita lihat di halaman wallet. */}
      <p className="mt-2 text-xs text-muted">
        {riset
          ? (m.stale
            ? t('Dari riset wallet — fee dan token sisa yang dia jual sudah ikut. Posisinya masih terbuka, jadi nilainya sebesar pemindaian wallet terakhir, bukan harga sekarang.')
            : t('Dari riset wallet: pokok, fee, dan token sisa yang dia jual sudah ikut terhitung.'))
          : pnl != null
            ? t('Belum ada riset wallet, jadi ini dari aksi yang terpantau saja: pokok yang dia tarik dikurangi yang dia taruh. Fee yang dia panen terpisah tidak ikut, jadi angka ini lantai — bukan laba pastinya.')
            /* tanpa riset DAN tanpa tarikan: kalimat di atas sudah mengatakan tidak ada
               angkanya sama sekali — mengulanginya di sini cuma kebisingan. */
            : w ? t('Dia belum menarik apa pun dari posisi itu, jadi hasilnya belum bisa dihitung.') : ''}
        {!riset && (
          <>{w ? ' ' : ''}<a href={'#wallet/' + p.target} className="text-accent hover:underline">{t('Pindai wallet target')}</a>{' '}
            {t('untuk angka yang lengkap.')}</>
        )}
      </p>
      {(w || m) && (
        <div className="mt-1 text-xs text-muted">
          {w?.heldSec > 0 ? t('dia pegang {d}', { d: age(w.heldSec / 3600) }) : (m?.openedTs ? t('dia buka {w}', { w: ago(m.openedTs) }) : null)}
          {w?.events > 0 ? ` · ${t('{n} aksi terpantau', { n: w.events })}` : ''}
        </div>
      )}
    </div>
  );
}
