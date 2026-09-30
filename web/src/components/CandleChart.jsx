// Candlestick chart with TradingView Lightweight Charts: zoom/pan, crosshair, log
// scale, and the LP position layer (range band, entry/exit lines, entry/current price)
// drawn as a *primitive* on the same canvas.
//
// The price axis does NOT use the built-in autoscale: a single wild wick (memecoins often
// have one) would stretch the axis 10× and flatten all the other candles. The bounds are
// computed from wick percentiles + candle bodies; extreme wicks are cut at the edge.
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  createChart, CandlestickSeries, HistogramSeries, LineStyle, PriceScaleMode, CrosshairMode, createSeriesMarkers,
} from 'lightweight-charts';
import { price as fmtPrice, usd, pct, tone, locale as fmtLocale } from '../fmt';
import { translate as t } from '../i18n';

// Theme colours (oklch in CSS) -> hex. Lightweight Charts processes alpha itself and
// only understands the sRGB format, so the colour is painted onto a single canvas pixel and read
// back — a way that works for any format the browser knows.
const hexCache = new Map();
function cssColor(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888888';
  if (hexCache.has(raw)) return hexCache.get(raw);
  const ctx = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = raw; ctx.fillRect(0, 0, 1, 1);
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  const hex = '#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('');
  hexCache.set(raw, hex);
  return hex;
}
export const withAlpha = (hex, a) => hex + Math.round(a * 255).toString(16).padStart(2, '0');

// Range band colours when several positions are drawn on one chart (Monitor, pool
// detail). Chosen in order of position id so the colours do not keep changing.
export const BAND_COLORS = ['#3b82f6', '#a855f7', '#f97316', '#14b8a6', '#ec4899', '#eab308', '#06b6d4', '#8b5cf6'];
export function palette() {
  const dark = document.documentElement.classList.contains('dark');
  return {
    dark,
    up: cssColor('--success'), down: cssColor('--danger'), accent: cssColor('--accent'), warning: cssColor('--warning'),
    muted: cssColor('--muted'), border: cssColor('--border'), fg: cssColor('--foreground'),
    text: dark ? '#9a9aa3' : '#6b6b76',
    // axis crosshair label: high contrast against the canvas, not a thin grey
    label: dark ? '#3a3a42' : '#4a4a55',
  };
}

// LP position layer above the candles. Re-read every time the chart is drawn, so
// it is enough to replace `this.o` and ask for a redraw.
class LpOverlay {
  constructor(o) { this.o = o; }
  attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.requestUpdate = requestUpdate; }
  detached() { this.chart = null; this.series = null; }
  set(o) { this.o = o; this.requestUpdate?.(); }
  paneViews() { return [this.view ||= { zOrder: () => 'bottom', renderer: () => ({ draw: (tg) => this.draw(tg) }) }]; }
  draw(target) {
    const { chart, series, o } = this;
    if (!chart || !series || !o) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize: { width, height } }) => {
      const y = (p) => (p == null ? null : series.priceToCoordinate(p));
      const x = (ts) => (ts == null ? null : chart.timeScale().timeToCoordinate(ts));
      const font = '10px ui-sans-serif, system-ui, sans-serif';
      ctx.font = font;
      // Range band: to the edge if it extends outside the chart. A single band (range)
      // or many (ranges: one per position in the same pool, each band with its own
      // colour; the selected one is drawn more solid with a full line, the others
      // thin so they stay readable without covering each other). The selected band is drawn
      // last so it sits on top.
      const bands = o.ranges ? [...o.ranges].sort((a, b) => (a.selected ? 1 : 0) - (b.selected ? 1 : 0)) : o.range ? [{ ...o.range, color: o.c.accent, label: t('rentang'), selected: true }] : [];
      for (const b of bands) {
        let y1 = y(b.hi), y2 = y(b.lo);
        if (y1 == null || y2 == null) continue;
        y1 = Math.max(-1, Math.min(height + 1, y1)); y2 = Math.max(-1, Math.min(height + 1, y2));
        const color = b.color || o.c.accent;
        const strong = b.selected || bands.length === 1;
        ctx.fillStyle = withAlpha(color, strong ? (o.dark ? 0.16 : 0.12) : (o.dark ? 0.07 : 0.05));
        ctx.fillRect(0, y1, width, y2 - y1);
        ctx.strokeStyle = withAlpha(color, strong ? 0.7 : 0.35); ctx.lineWidth = 1; ctx.setLineDash(strong ? [] : [3, 3]);
        ctx.beginPath(); ctx.moveTo(0, y1); ctx.lineTo(width, y1); ctx.moveTo(0, y2); ctx.lineTo(width, y2); ctx.stroke();
        ctx.setLineDash([]);
        if (b.label) {
          ctx.fillStyle = strong ? color : withAlpha(color, 0.75); ctx.textBaseline = 'top'; ctx.textAlign = 'left';
          ctx.fillText(b.label, 4, Math.max(22, y1 + 3));
        }
      }
      // vertical lines: at entry (accent) & at exit (yellow). The label is on the
      // arrow marker on the candle; here only for an entry that falls before the
      // first candle (no candle to attach a marker to).
      const vline = (ts, label, color) => {
        const xx = x(ts);
        if (xx == null) return;
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.setLineDash([5, 3]);
        ctx.beginPath(); ctx.moveTo(xx, 0); ctx.lineTo(xx, height); ctx.stroke(); ctx.setLineDash([]);
        if (label) { ctx.fillStyle = color; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; ctx.fillText(label, xx + 4, 22); }
      };
      if (o.entryT != null) vline(o.entryT, o.entryBefore ? t('masuk (sebelum grafik)') : null, o.c.accent);
      if (o.exitT != null) vline(o.exitT, null, o.c.warning);
    });
  }
}

// Price axis bounds: wick percentiles (cutting momentary spikes), the whole candle
// body, entry/current price, and the range band if it is not too wide.
function domainOf(cs, o) {
  if (!cs.length) return null;
  const q = (arr, f) => { const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * (s.length - 1)))]; };
  let lo = Math.min(q(cs.map((c) => c.l), 0.03), ...cs.map((c) => Math.min(c.o, c.c)));
  let hi = Math.max(q(cs.map((c) => c.h), 0.97), ...cs.map((c) => Math.max(c.o, c.c)));
  for (const p of [o.entryP, o.exitP, o.nowP, o.bep]) if (p > 0) { lo = Math.min(lo, p); hi = Math.max(hi, p); }
  if (o.range && (o.pickRange || o.range.hi / o.range.lo < 3.5)) { lo = Math.min(lo, o.range.lo); hi = Math.max(hi, o.range.hi); }
  // Many bands: the selected one always enters the axis; the others only if not too wide.
  for (const b of o.ranges || []) if (b.selected || b.hi / b.lo < 3.5) { lo = Math.min(lo, b.lo); hi = Math.max(hi, b.hi); }
  // When choosing a range, its bounds must not stick to the edge: the axis labels are
  // covered by the OHLC legend and the scale buttons in the top corner.
  if (o.pickRange) { const f = Math.max(1.03, (hi / lo) ** 0.12); lo /= f; hi *= f; }
  return { lo, hi };
}

/**
 * candles : [{ t(ms), o, h, l, c, v }] ascending
 * tf      : '5m' | '1h' | … (for label formatting)
 * quote   : quote asset symbol (legend)
 * range   : { lo, hi } price range of the position, or null
 * ranges  : [{ id, lo, hi, color, label, selected }] — many bands at once (one
 *           per position in the same pool); onRangeClick(id) is called when a band is clicked
 * entry   : { t(ms), p }  exit : { t(ms), p }  now : current price — all optional
 * pickRange : the range being chosen (manual LP) — both its bounds always enter
 *             the axis, however wide, and get a price label on the axis
 * height  : height in px
 */
export default function CandleChart({ candles, tf, quote, range = null, ranges = null, onRangeClick = null, entry = null, exit = null, now = null, bep = null, pickRange = false, height = 384 }) {
  const box = useRef(null);
  const ref = useRef(null);            // { chart, series, vol, overlay, markers }
  // Bands & the click handler are read from a ref by the click subscription installed once.
  const bandsRef = useRef({ ranges, onRangeClick });
  bandsRef.current = { ranges, onRangeClick };
  const [hover, setHover] = useState(null);
  const [scale, setScale] = useState(null);   // null = automatic
  const [pal, setPal] = useState(palette);

  // Theme change (.dark class on <html>) -> colours are re-read.
  useEffect(() => {
    const mo = new MutationObserver(() => setPal(palette()));
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => mo.disconnect();
  }, []);

  // GeckoTerminal occasionally sends two candles with the same time; Lightweight
  // Charts requires strictly ascending time, so duplicates are dropped (the last one wins).
  const data = useMemo(() => {
    const out = [];
    for (const c of candles || []) {
      if (!(c.o > 0 && c.h > 0 && c.l > 0 && c.c > 0)) continue;
      const row = { time: Math.floor(c.t / 1000), open: c.o, high: c.h, low: c.l, close: c.c, value: c.v || 0 };
      const last = out[out.length - 1];
      if (last && row.time <= last.time) { if (row.time === last.time) out[out.length - 1] = row; continue; }
      out.push(row);
    }
    return out;
  }, [candles]);
  const secs = data.length > 1 ? data[1].time - data[0].time : 60;
  // The time marker is attached to the candle that contains it.
  const snap = (ms) => {
    if (!ms || !data.length) return null;
    const s = ms / 1000;
    let best = data[0].time;
    for (const c of data) { if (c.time <= s) best = c.time; else break; }
    return best;
  };
  const entryT = snap(entry?.t), exitT = snap(exit?.t);
  const entryBefore = !!(entry?.t && data.length && data[0].time * 1000 > entry.t);
  const dom = useMemo(() => domainOf(data.map((d) => ({ o: d.open, h: d.high, l: d.low, c: d.close })), { entryP: entry?.p, exitP: exit?.p, nowP: now, bep, range, ranges, pickRange }), [data, entry?.p, exit?.p, now, bep, range, ranges, pickRange]);
  // Log if the displayed price range is more than 4× — percent moves become comparable.
  const log = scale ? scale === 'log' : !!(dom && dom.hi / dom.lo > 4);

  // Create the chart once.
  useEffect(() => {
    const el = box.current;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: pal.text, fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif', fontSize: 11, attributionLogo: false },
      // helper lines: full & dim hairline — dots read as a threshold, not a grid
      grid: { vertLines: { visible: false }, horzLines: { color: withAlpha(pal.border, 0.6), style: LineStyle.Solid } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.08 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false, rightOffset: 3, minBarSpacing: 2, shiftVisibleRangeOnNewBar: false,
        tickMarkFormatter: (ts, type) => {
          const d = new Date(ts * 1000);
          return type <= 2 ? d.toLocaleDateString(fmtLocale(), { day: 'numeric', month: 'short' })
            : d.toLocaleTimeString(fmtLocale(), { hour: '2-digit', minute: '2-digit' });
        } },
      localization: { locale: fmtLocale(), priceFormatter: (p) => fmtPrice(p),
        timeFormatter: (ts) => new Date(ts * 1000).toLocaleString(fmtLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) },
      crosshair: { mode: CrosshairMode.Normal,
        vertLine: { color: withAlpha(pal.muted, 0.7), style: LineStyle.Dashed, width: 1, labelBackgroundColor: pal.label },
        horzLine: { color: withAlpha(pal.muted, 0.7), style: LineStyle.Dashed, width: 1, labelBackgroundColor: pal.label } },
      handleScale: { axisPressedMouseMove: true }, handleScroll: true,
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: pal.up, downColor: pal.down, wickUpColor: pal.up, wickDownColor: pal.down, borderVisible: false,
      priceFormat: { type: 'custom', formatter: (p) => fmtPrice(p), minMove: 1e-12 },
      lastValueVisible: true, priceLineVisible: false,
      autoscaleInfoProvider: () => (ref.current?.dom ? { priceRange: { minValue: ref.current.dom.lo, maxValue: ref.current.dom.hi } } : null),
    });
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    const overlay = new LpOverlay(null);
    series.attachPrimitive(overlay);
    const markers = createSeriesMarkers(series, []);
    const onMove = (e) => {
      const d = e.seriesData?.get(series);
      setHover(d && e.time != null ? { ...d, v: e.seriesData.get(vol)?.value ?? 0 } : null);
    };
    chart.subscribeCrosshairMove(onMove);
    // Click a range band -> select its position. The narrowest band wins if
    // they overlap; the cursor becomes a pointer when hovering over a clickable band.
    const bandAt = (point) => {
      const { ranges: rs, onRangeClick: cb } = bandsRef.current;
      if (!rs?.length || !cb || !point) return null;
      const price = series.coordinateToPrice(point.y);
      if (!(price > 0)) return null;
      const hits = rs.filter((b) => price >= b.lo && price <= b.hi).sort((a, b) => (a.hi / a.lo) - (b.hi / b.lo));
      return hits[0] || null;
    };
    const onClick = (e) => { const b = bandAt(e.point); if (b) bandsRef.current.onRangeClick(b.id); };
    const onHover = (e) => { el.style.cursor = bandAt(e.point) ? 'pointer' : ''; };
    chart.subscribeClick(onClick);
    chart.subscribeCrosshairMove(onHover);
    ref.current = { chart, series, vol, overlay, markers, lines: [], dom: null };
    return () => { chart.unsubscribeCrosshairMove(onMove); chart.unsubscribeCrosshairMove(onHover); chart.unsubscribeClick(onClick); chart.remove(); ref.current = null; };
  }, []);

  // Colours follow the theme.
  useEffect(() => {
    const r = ref.current; if (!r) return;
    r.chart.applyOptions({ layout: { textColor: pal.text }, grid: { horzLines: { color: withAlpha(pal.border, 0.6) } },
      crosshair: { vertLine: { color: withAlpha(pal.muted, 0.7), labelBackgroundColor: pal.label }, horzLine: { color: withAlpha(pal.muted, 0.7), labelBackgroundColor: pal.label } } });
    r.series.applyOptions({ upColor: pal.up, downColor: pal.down, wickUpColor: pal.up, wickDownColor: pal.down });
  }, [pal]);

  // Apply the scale mode only when it changes: reapplying it on each poll
  // resets manual price-axis scaling in Lightweight Charts.
  useEffect(() => {
    ref.current?.chart.priceScale('right').applyOptions({ mode: log ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal });
  }, [log]);

  // Data and overlays can refresh without fitting the user's viewport again.
  // Fit once for each candle interval, after that interval has data.
  const fittedTf = useRef(null);

  // Data, scale, and the position layer.
  useEffect(() => {
    const r = ref.current; if (!r) return;
    r.dom = dom;
    r.series.setData(data);
    r.vol.setData(data.map((d) => ({ time: d.time, value: d.value, color: withAlpha(d.close >= d.open ? pal.up : pal.down, 0.28) })));
    for (const l of r.lines) r.series.removePriceLine(l);
    r.lines = [];
    const line = (p, color, title, style = LineStyle.Dashed) => { if (p > 0) r.lines.push(r.series.createPriceLine({ price: p, color, lineWidth: 1, lineStyle: style, axisLabelVisible: true, title })); };
    line(entry?.p, pal.muted, t('masuk'));
    line(exit?.p, pal.warning, t('keluar'));
    line(bep, pal.warning, 'BEP');
    if (pickRange && range) {
      line(range.hi, pal.accent, t('batas atas'));
      line(range.lo, pal.accent, t('batas bawah'));
    }
    // The current pool price is only lined if it differs from the last candle's close —
    // if the same, the series' last-value label already shows it; two twin labels
    // on the axis (red 0.0106 and white 0.0106) are just noise.
    const lastClose = data[data.length - 1]?.close;
    if (now > 0 && !exit && !(lastClose > 0 && Math.abs(now / lastClose - 1) < 0.003)) line(now, withAlpha(pal.fg, 0.55), t('kini'), LineStyle.Dotted);
    r.overlay.set({ range, ranges, entryT, exitT, entryBefore, c: pal, dark: pal.dark });
    r.markers.setMarkers([
      ...(entryT != null && !entryBefore ? [{ time: entryT, position: 'belowBar', color: pal.accent, shape: 'arrowUp', text: t('masuk') }] : []),
      ...(exitT != null ? [{ time: exitT, position: 'aboveBar', color: pal.warning, shape: 'arrowDown', text: t('keluar') }] : []),
    ]);
    if (data.length && fittedTf.current !== tf) {
      r.chart.timeScale().fitContent();
      r.chart.timeScale().applyOptions({ rightOffset: 3 });
      fittedTf.current = tf;
    }
  }, [data, tf, dom, entry?.p, exit?.p, entryT, exitT, entryBefore, now, bep, range, ranges, pickRange, pal]);

  const last = data[data.length - 1];
  const h = hover || (last && { ...last, v: last.value });
  const chg = h && h.open > 0 ? (h.close / h.open - 1) * 100 : null;

  return (
    <div className="relative">
      {/* legenda OHLC lilin yang disorot (atau lilin terakhir) */}
      {h && (
        <div className="num pointer-events-none absolute top-1 left-1 z-10 flex flex-wrap gap-x-2.5 rounded bg-surface/80 px-1.5 py-0.5 text-[0.6875rem] text-muted backdrop-blur-sm">
          <span>{new Date(h.time * 1000).toLocaleString(fmtLocale(), secs >= 86400 ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
          <span>O <span className="text-foreground">{fmtPrice(h.open)}</span></span>
          <span>H <span className="text-foreground">{fmtPrice(h.high)}</span></span>
          <span>L <span className="text-foreground">{fmtPrice(h.low)}</span></span>
          <span>C <span className={tone(chg) || 'text-foreground'}>{fmtPrice(h.close)}</span>{chg != null && <span className={`ml-1 ${tone(chg)}`}>{pct(chg, 1)}</span>}</span>
          <span>{t('Vol')} <span className="text-foreground">{usd(h.v, 0)}</span></span>
          {quote && <span>{t('dalam {q}', { q: quote })}</span>}
        </div>
      )}
      {/* skala: otomatis (log kalau rentangnya lebar) / paksa log / linear */}
      <div className="absolute top-1 right-1 z-10 flex rounded border border-border bg-surface/80 p-0.5 text-[0.6875rem] backdrop-blur-sm" role="group" aria-label={t('Skala harga')}>
        {[['log', 'Log'], ['lin', 'Lin']].map(([id, label]) => {
          const on = (id === 'log') === log;
          return <button key={id} type="button" aria-pressed={on} onClick={() => setScale(id)}
            className={`rounded px-1.5 font-medium transition-colors ${on ? 'bg-default text-foreground' : 'text-muted hover:text-foreground'}`}>{label}</button>;
        })}
      </div>
      <div ref={box} style={{ height }} className="w-full" />
    </div>
  );
}
