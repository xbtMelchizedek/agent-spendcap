// The spend gate. Two phases, like a card hold: authorize() reserves an amount if every rule passes, then
// settle() records what was actually charged, or release() gives the hold back. Every decision, including each
// refusal, goes on the ledger. An open hold counts as spent until it is settled or released, even after it
// expires: when the outcome of a paid call is unknown, the safe assumption is that it was charged.
import { toNano, fromNano, PolicyError } from './decimal.mjs';
import { PRIVACY, listReason } from './policy.mjs';

const ID_RE = /^[A-Za-z0-9._\/:@-]{1,120}$/;

export class SpendCap {
  constructor({ policy, ledger, now = () => Date.now(), newId }) {
    this.policy = policy;
    this.ledger = ledger;
    this.now = now;
    this.newId = newId ?? (() => globalThis.crypto.randomUUID());
  }

  /** Current holds and settlements, rebuilt from the ledger (the ledger is the only state). */
  book() {
    const holds = new Map();
    for (const e of this.ledger.entries()) {
      if (e.t === 'reserve') holds.set(e.id, { id: e.id, ts: e.ts, expiresAt: e.expiresAt, venue: e.venue, model: e.model, reserved: BigInt(e.nano), state: 'open', charged: null, overrun: false });
      else if (e.t === 'settle' || e.t === 'release') {
        const h = holds.get(e.id);
        if (!h || h.state !== 'open') throw new Error(`ledger entry ${e.seq}: ${e.t} for a hold that is not open`);
        if (e.t === 'settle') Object.assign(h, { state: 'settled', charged: BigInt(e.nano), overrun: e.overrun === true });
        else h.state = 'released';
      }
    }
    return holds;
  }

  /** What each hold counts against the caps right now. */
  static counted(h) {
    if (h.state === 'settled') return h.charged;
    if (h.state === 'open') return h.reserved;
    return 0n;
  }

  usage(at = this.now()) {
    const holds = [...this.book().values()];
    return this.policy.windows.map((w) => {
      const used = holds.filter((h) => h.ts > at - w.ms).reduce((s, h) => s + SpendCap.counted(h), 0n);
      return { window: w.name, used, max: w.max, remaining: w.max > used ? w.max - used : 0n };
    });
  }

  /**
   * Ask before a paid call. req = { venue, model, usd, privacy?, purpose? }. Returns
   * { ok: true, id, remaining } or { ok: false, reasons }. Bad input throws PolicyError and is not recorded.
   */
  authorize(req) {
    if (!req || typeof req !== 'object') throw new PolicyError('request', 'must be an object');
    const { venue, model, privacy = 'any', purpose = null } = req;
    if (typeof venue !== 'string' || !ID_RE.test(venue)) throw new PolicyError('venue', 'must be 1-120 chars of letters, digits, . _ / : @ -');
    if (typeof model !== 'string' || !ID_RE.test(model)) throw new PolicyError('model', 'must be 1-120 chars of letters, digits, . _ / : @ -');
    if (!PRIVACY.includes(privacy)) throw new PolicyError('privacy', `must be one of ${PRIVACY.join(', ')}`);
    if (purpose !== null && (typeof purpose !== 'string' || purpose.length > 200)) throw new PolicyError('purpose', 'must be a string up to 200 chars');
    const nano = toNano(req.usd, 'usd');
    if (nano === 0n) throw new PolicyError('usd', 'must be more than 0 (free calls need no hold)');
    const p = this.policy;
    const at = this.now();
    const reasons = [];
    if (nano > p.perCallMax) reasons.push(`$${fromNano(nano)} is over the per-call cap of $${fromNano(p.perCallMax)}`);
    const vr = listReason('venue', p.venues, venue);
    if (vr) reasons.push(vr);
    const mr = listReason('model', p.models, model);
    if (mr) reasons.push(mr);
    if (PRIVACY.indexOf(privacy) < PRIVACY.indexOf(p.minPrivacy)) reasons.push(`privacy ${privacy} is below the policy minimum ${p.minPrivacy}`);
    const usage = this.usage(at);
    for (const u of usage) if (u.used + nano > u.max) reasons.push(`${u.window} cap: $${fromNano(u.used)} used + $${fromNano(nano)} > $${fromNano(u.max)}`);
    if (p.maxCallsPerMinute !== null) {
      const recent = this.ledger.entries().filter((e) => e.t === 'reserve' && e.ts > at - 60_000).length;
      if (recent >= p.maxCallsPerMinute) reasons.push(`rate: ${recent} calls in the last minute (max ${p.maxCallsPerMinute})`);
    }
    const base = { ts: at, venue, model, privacy, nano: nano.toString(), purpose };
    if (reasons.length) {
      this.ledger.append({ t: 'deny', ...base, reasons });
      return { ok: false, reasons };
    }
    const id = this.newId();
    this.ledger.append({ t: 'reserve', id, ...base, expiresAt: at + p.reservationTtlMs });
    return { ok: true, id, reservedUsd: fromNano(nano), remaining: usage.map((u) => ({ window: u.window, usd: fromNano(u.remaining - nano) })) };
  }

  /** Record what the call actually cost. A charge over the hold is recorded (reality wins) and flagged. */
  settle(id, usd, { receipt = null } = {}) {
    const h = this.#open(id);
    const nano = toNano(usd, 'usd');
    if (this.policy.requireReceipt && (typeof receipt !== 'string' || receipt.length < 8 || receipt.length > 200)) {
      throw new PolicyError('receipt', 'policy requires a receipt reference (8-200 chars) on every settle');
    }
    const overrun = nano > h.reserved;
    this.ledger.append({ t: 'settle', id, ts: this.now(), nano: nano.toString(), receipt, overrun });
    return { ok: !overrun, chargedUsd: fromNano(nano), overrun, ...(overrun ? { note: `charged $${fromNano(nano)}, hold was $${fromNano(h.reserved)}` } : {}) };
  }

  /** The call did not happen (or cost nothing): give the hold back. */
  release(id) {
    this.#open(id);
    this.ledger.append({ t: 'release', id, ts: this.now() });
    return { ok: true };
  }

  status() {
    const at = this.now();
    const holds = [...this.book().values()];
    return {
      windows: this.usage(at).map((u) => ({ window: u.window, usedUsd: fromNano(u.used), maxUsd: fromNano(u.max), remainingUsd: fromNano(u.remaining) })),
      open: holds.filter((h) => h.state === 'open').map((h) => ({ id: h.id, venue: h.venue, model: h.model, usd: fromNano(h.reserved), expired: at > h.expiresAt })),
      overruns: holds.filter((h) => h.overrun).length,
      denied: this.ledger.entries().filter((e) => e.t === 'deny').length,
    };
  }

  #open(id) {
    const h = this.book().get(id);
    if (!h) throw new PolicyError('id', `no hold ${id}`);
    if (h.state !== 'open') throw new PolicyError('id', `hold ${id} is already ${h.state}`);
    return h;
  }
}
