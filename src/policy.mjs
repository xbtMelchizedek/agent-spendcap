// A spend policy is plain JSON. Every field is checked; unknown fields are an error so a typo can't silently
// remove a limit.
import { toNano, PolicyError } from './decimal.mjs';

export const PRIVACY = ['any', 'no-retention', 'tee', 'local']; // weakest to strongest
const TOP = ['version', 'perCallMax', 'windows', 'venues', 'models', 'minPrivacy', 'maxCallsPerMinute', 'reservationTtlSeconds', 'requireReceipt'];

function list(field, v) {
  if (v === undefined) return null;
  if (!Array.isArray(v) || v.length > 200 || !v.every((x) => typeof x === 'string' && /^[A-Za-z0-9._\/:@*-]{1,120}$/.test(x))) {
    throw new PolicyError(field, 'must be an array of up to 200 ids (letters, digits, . _ / : @ - and a trailing *)');
  }
  for (const x of v) if (x.includes('*') && (x.indexOf('*') !== x.length - 1)) throw new PolicyError(field, `"${x}": * is only allowed at the end`);
  return v;
}

/** Validate and normalize a policy object. Throws PolicyError naming the field. */
export function parsePolicy(p) {
  if (!p || typeof p !== 'object' || Array.isArray(p)) throw new PolicyError('policy', 'must be an object');
  for (const k of Object.keys(p)) if (!TOP.includes(k)) throw new PolicyError(k, 'unknown field');
  if (p.version !== 1) throw new PolicyError('version', 'must be 1');
  const perCallMax = toNano(p.perCallMax, 'perCallMax');
  if (!Array.isArray(p.windows) || p.windows.length === 0 || p.windows.length > 8) throw new PolicyError('windows', 'must list 1 to 8 rolling windows');
  const windows = p.windows.map((w, i) => {
    const f = `windows[${i}]`;
    if (!w || typeof w !== 'object') throw new PolicyError(f, 'must be an object');
    for (const k of Object.keys(w)) if (!['name', 'seconds', 'max'].includes(k)) throw new PolicyError(`${f}.${k}`, 'unknown field');
    if (typeof w.name !== 'string' || !/^[a-z0-9-]{1,20}$/.test(w.name)) throw new PolicyError(`${f}.name`, 'must be 1-20 of a-z 0-9 -');
    if (!Number.isSafeInteger(w.seconds) || w.seconds < 60 || w.seconds > 366 * 86400) throw new PolicyError(`${f}.seconds`, 'must be an integer from 60 to 31622400');
    return { name: w.name, ms: w.seconds * 1000, max: toNano(w.max, `${f}.max`) };
  });
  if (new Set(windows.map((w) => w.name)).size !== windows.length) throw new PolicyError('windows', 'names must be unique');
  for (const w of windows) if (w.max < perCallMax) throw new PolicyError(`windows.${w.name}.max`, 'is below perCallMax, so no call could ever pass');
  const vz = p.venues ?? {};
  if (typeof vz !== 'object' || Array.isArray(vz)) throw new PolicyError('venues', 'must be { allow?, deny? }');
  for (const k of Object.keys(vz)) if (!['allow', 'deny'].includes(k)) throw new PolicyError(`venues.${k}`, 'unknown field');
  const mz = p.models ?? {};
  if (typeof mz !== 'object' || Array.isArray(mz)) throw new PolicyError('models', 'must be { allow?, deny? }');
  for (const k of Object.keys(mz)) if (!['allow', 'deny'].includes(k)) throw new PolicyError(`models.${k}`, 'unknown field');
  const minPrivacy = p.minPrivacy ?? 'any';
  if (!PRIVACY.includes(minPrivacy)) throw new PolicyError('minPrivacy', `must be one of ${PRIVACY.join(', ')}`);
  const rate = p.maxCallsPerMinute ?? null;
  if (rate !== null && (!Number.isSafeInteger(rate) || rate < 1 || rate > 10_000)) throw new PolicyError('maxCallsPerMinute', 'must be an integer from 1 to 10000');
  const ttl = p.reservationTtlSeconds ?? 600;
  if (!Number.isSafeInteger(ttl) || ttl < 1 || ttl > 86400) throw new PolicyError('reservationTtlSeconds', 'must be an integer from 1 to 86400');
  if (p.requireReceipt !== undefined && typeof p.requireReceipt !== 'boolean') throw new PolicyError('requireReceipt', 'must be true or false');
  return Object.freeze({
    perCallMax,
    windows,
    venues: { allow: list('venues.allow', vz.allow), deny: list('venues.deny', vz.deny) ?? [] },
    models: { allow: list('models.allow', mz.allow), deny: list('models.deny', mz.deny) ?? [] },
    minPrivacy,
    maxCallsPerMinute: rate,
    reservationTtlMs: ttl * 1000,
    requireReceipt: p.requireReceipt ?? false,
  });
}

/** "openrouter:*" matches "openrouter:pearl-research/fp8"; anything else must match exactly (case-insensitive). */
export function matches(pattern, id) {
  const p = pattern.toLowerCase();
  const s = String(id).toLowerCase();
  return p.endsWith('*') ? s.startsWith(p.slice(0, -1)) : s === p;
}

/** null when allowed, else the reason. Deny wins over allow. */
export function listReason(kind, lists, id) {
  if (lists.deny.some((p) => matches(p, id))) return `${kind} ${id} is denied by policy`;
  if (lists.allow && !lists.allow.some((p) => matches(p, id))) return `${kind} ${id} is not on the allow list`;
  return null;
}
