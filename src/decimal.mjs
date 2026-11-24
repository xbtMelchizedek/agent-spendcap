// Exact USD amounts as BigInt nano-dollars (1e-9). Strings in, strings out; floats are refused so a cap can
// never be off by a rounding error.
export const SCALE = 9;
const ONE = 10n ** BigInt(SCALE);
const RE = /^\d{1,15}(\.\d{1,9})?$/;

export class PolicyError extends Error {
  constructor(field, msg) {
    super(`${field}: ${msg}`);
    this.name = 'PolicyError';
    this.field = field;
  }
}

/** "0.0105" -> 10500000n. Accepts only plain non-negative decimal strings with at most 9 places. */
export function toNano(v, field = 'amount') {
  if (typeof v !== 'string' || !RE.test(v)) throw new PolicyError(field, `must be a decimal string like "0.25" (max 9 places), got ${JSON.stringify(v)}`);
  const [w, f = ''] = v.split('.');
  return BigInt(w) * ONE + BigInt(f.padEnd(SCALE, '0'));
}

/** 10500000n -> "0.0105" */
export function fromNano(n) {
  const neg = n < 0n;
  const a = neg ? -n : n;
  const w = a / ONE;
  const f = (a % ONE).toString().padStart(SCALE, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${w}${f ? '.' + f : ''}`;
}
