/**
 * Exact decimal arithmetic for amounts, so balances like 825.3051766211363 never
 * pick up floating-point error. Amounts are BigInt counts of 1e-8 units.
 */
const DP = 8;
const SCALE = 10n ** BigInt(DP);

/** Parse a non-negative decimal string into units, dropping digits past 8 decimals. */
export function toUnits(value) {
  const s = String(value ?? '').trim() || '0';
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error(`Invalid amount: ${value}`);
  const [int, frac = ''] = s.split('.');
  return BigInt(int) * SCALE + BigInt(frac.padEnd(DP, '0').slice(0, DP));
}

const step = (dp) => 10n ** BigInt(DP - Math.max(0, Math.min(DP, dp)));

/** Round down to `dp` decimal places. */
export const floorTo = (units, dp) => (units / step(dp)) * step(dp);

/** Round up to `dp` decimal places. */
export const ceilTo = (units, dp) => ((units + step(dp) - 1n) / step(dp)) * step(dp);

/** Format units as a plain decimal string without trailing zeros. */
export function fromUnits(units) {
  const frac = (units % SCALE).toString().padStart(DP, '0').replace(/0+$/, '');
  return frac ? `${units / SCALE}.${frac}` : `${units / SCALE}`;
}
