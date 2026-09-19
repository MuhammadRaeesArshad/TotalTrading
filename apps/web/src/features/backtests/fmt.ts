/** A signed R value, e.g. "+1.92R" or "−1.04R". Uses a true minus sign. */
export function fmtR(v: number | null | undefined, dp = 2): string {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(dp)}R`;
}

/** A fraction as a percent: 0.412 → "41.2%". */
export function fmtPct(fraction: number | null | undefined, dp = 1): string {
  if (fraction == null || !Number.isFinite(fraction)) return '—';
  return `${(fraction * 100).toFixed(dp)}%`;
}

/** Signed money with a true minus sign and no cents: "+$3,322" / "−$78". */
export function fmtMoney(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}$${abs}`;
}

export const money0 = (v: number) =>
  `$${Math.round(v).toLocaleString('en-US')}`;

/** Class for money only — green and red never mean anything else. */
export const moneyClass = (v: number | null | undefined) =>
  v == null || v === 0 ? '' : v > 0 ? 'gain' : 'loss';

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const MONTHS = MON;

/** "5 Mar 24 08:00" in UTC — trading times are compared across sessions, so never local. */
export function fmtWhen(iso: string, withTime = true): string {
  const d = new Date(iso);
  const date = `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
  if (!withTime) return date;
  return `${date} ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** Decimal places for a symbol's prices: JPY crosses quote to 3, everything else 5. */
export const priceDp = (symbol: string) => (symbol.toUpperCase().includes('JPY') ? 3 : 5);

/** Readable labels for the detector's detail keys. Unknown keys show as-is. */
export const DETAIL_LABELS: Record<string, string> = {
  zone_high: 'Zone high',
  zone_low: 'Zone low',
  bos_price: 'Broken level',
  trend_dir: 'Trend',
  zone_age_bars: 'Zone age (bars)',
  fvg_present: 'Fair value gap',
  detector_version: 'Detector version',
};
