/**
 * Money helpers. The platform stores integer MINOR units (paise). Marketplaces send decimal strings or numbers in
 * major units ("1234.50"). Conversion is done on the decimal STRING, never through floating-point multiplication.
 */
export function toMinor(amount: string | number | null | undefined): number {
  if (amount === null || amount === undefined || amount === '') return 0;
  const s = typeof amount === 'number' ? amount.toFixed(2) : String(amount).trim();
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(s);
  if (!m) throw new Error(`Invalid monetary amount: ${s}`);
  const [, neg, whole, frac = ''] = m;
  const padded = `${frac}00`;
  let minor = Number(whole) * 100 + Number(padded.slice(0, 2));
  if (frac.length > 2 && Number(frac[2]) >= 5) minor += 1; // round half up on the third decimal
  return neg ? -minor : minor;
}

/** 123450 -> "1234.50" */
export function fromMinor(minor: number): string {
  const neg = minor < 0;
  const abs = Math.abs(Math.round(minor));
  const s = `${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
  return neg ? `-${s}` : s;
}
