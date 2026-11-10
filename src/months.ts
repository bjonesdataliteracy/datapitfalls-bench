// Months are written 'YYYY-MM' and counted as an index (year * 12 + month - 1)
// so they can be compared and shifted with plain arithmetic.

const NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function monthIndex(ym: string): number {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
  if (!m) throw new Error(`Not a month in YYYY-MM form: "${ym}"`);
  return Number(m[1]) * 12 + Number(m[2]) - 1;
}

export function monthFromIndex(t: number): string {
  const y = Math.floor(t / 12);
  return `${String(y).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`;
}

export function addMonths(ym: string, n: number): string {
  return monthFromIndex(monthIndex(ym) + n);
}

/** 'July 2026' */
export function monthLabel(ym: string): string {
  const t = monthIndex(ym);
  return `${NAMES[t % 12]} ${Math.floor(t / 12)}`;
}

/** Every month from `from` to `to`, inclusive. */
export function monthRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let t = monthIndex(from); t <= monthIndex(to); t++) out.push(monthFromIndex(t));
  return out;
}
