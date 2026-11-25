// Wrap an OpenAI-compatible HTTP API (Chat Completions or Responses) in a SpendCap: authorize a hold before the
// request, settle from the response's own usage after it. Works with any fetch-style function. No keys handled
// here: the caller's headers pass through untouched.
import { toNano, fromNano, PolicyError } from './decimal.mjs';

export class SpendCapDenied extends Error {
  constructor(reasons) {
    super(`spend cap refused: ${reasons.join('; ')}`);
    this.name = 'SpendCapDenied';
    this.reasons = reasons;
  }
}

const enc = new TextEncoder();

/** Most a request can cost: every input byte as a token (a BPE token is at least one byte) plus max output tokens. */
export function holdFor(body, prices) {
  const maxOut = body.max_completion_tokens ?? body.max_tokens ?? body.max_output_tokens;
  if (!Number.isSafeInteger(maxOut) || maxOut <= 0) {
    throw new PolicyError('max_tokens', 'set max_tokens, max_completion_tokens or max_output_tokens so the hold has an upper bound, or pass estimate()');
  }
  // n (and legacy best_of) bill output for every choice generated, so the output bound is choices x maxOut.
  const n = body.n ?? 1, bestOf = body.best_of ?? 1;
  if (![n, bestOf].every((x) => Number.isSafeInteger(x) && x >= 1)) throw new PolicyError('n', 'n and best_of must be positive integers');
  const choices = Math.max(n, bestOf);
  const input = body.messages ?? body.input ?? body.prompt;
  if (input === undefined) throw new PolicyError('messages', 'request has no messages, input or prompt');
  // An image, audio or file part is a short URL or id in the body but bills far more than its bytes: no byte bound.
  const media = mediaPart(input);
  if (media) throw new PolicyError('media', `request has a ${media} part, which the byte bound can't price; pass estimate()`);
  const inBytes = enc.encode(typeof input === 'string' ? input : JSON.stringify(input)).length + enc.encode(JSON.stringify(body.tools ?? body.instructions ?? '')).length;
  return costOf(prices, inBytes, maxOut * choices);
}

const MEDIA_TYPES = new Set(['image_url', 'input_image', 'image', 'input_audio', 'audio', 'input_file', 'file', 'video_url', 'input_video']);

/** First content-part type in the request that is billed by media size, not bytes, or null. */
function mediaPart(v, depth = 0) {
  if (depth > 8 || v === null || typeof v !== 'object') return null;
  if (Array.isArray(v)) { for (const x of v) { const t = mediaPart(x, depth + 1); if (t) return t; } return null; }
  if (typeof v.type === 'string' && MEDIA_TYPES.has(v.type)) return v.type;
  for (const k of ['content', 'parts']) { const t = mediaPart(v[k], depth + 1); if (t) return t; }
  return null;
}

/** USD cost of token counts at per-1M prices, rounded up to $0.000000001. */
export function costOf(prices, inTokens, outTokens) {
  const i = toNano(prices.inPer1M, 'prices.inPer1M');
  const o = toNano(prices.outPer1M, 'prices.outPer1M');
  const n = BigInt(inTokens) * i + BigInt(outTokens) * o;
  return (n + 999_999n) / 1_000_000n; // nano-USD, ceil
}

/** A JSON number of USD (e.g. OpenRouter usage.cost) to nano-USD, rounded up. Null if not a finite number >= 0. */
export function reportedNano(cost) {
  if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) return null;
  const s = cost.toFixed(12);
  const [i, f] = s.split('.');
  const n = BigInt(i) * 1_000_000_000n + BigInt(f.slice(0, 9));
  return BigInt(f.slice(9)) > 0n ? n + 1n : n;
}

const usageOf = (obj) => obj?.usage ?? obj?.response?.usage ?? null;

/** Charge from a usage object: provider-reported USD cost if trusted, else tokens × prices. Null if neither. */
export function chargeFrom(usage, prices, { reportedCost = false } = {}) {
  if (!usage) return null;
  if (reportedCost) {
    const r = reportedNano(usage.cost);
    if (r !== null) return { nano: r, basis: 'reported-cost' };
  }
  const inT = usage.prompt_tokens ?? usage.input_tokens;
  const outT = usage.completion_tokens ?? usage.output_tokens;
  if (prices && Number.isSafeInteger(inT) && Number.isSafeInteger(outT) && inT >= 0 && outT >= 0) {
    return { nano: costOf(prices, inT, outT), basis: 'tokens' };
  }
  return null;
}

/**
 * fetch-compatible function that holds, calls and settles.
 * @param {import('./spendcap.mjs').SpendCap} cap
 * @param {object} o
 * @param {string} o.venue              who gets paid, e.g. "openrouter:pearl-research/fp8"
 * @param {{inPer1M: string, outPer1M: string}} [o.prices]  USD per 1M tokens; needed unless estimate() and reportedCost cover it
 * @param {string} [o.privacy]          what this venue offers: any | no-retention | tee | local
 * @param {boolean} [o.reportedCost]    trust usage.cost as USD (OpenRouter reports it in credits, 1 credit = $1)
 * @param {(body) => string} [o.estimate]  your own hold in USD instead of the byte-bound estimate
 * @param {boolean} [o.releaseOnHttpError=true]  release the hold on a non-2xx response
 * @param {(info) => void} [o.onSettle] called once per request with {id, ok, chargedUsd, basis, ...}
 * @param {typeof fetch} [o.fetchImpl]
 */
export function spendcapFetch(cap, o) {
  const { venue, prices, privacy = 'any', reportedCost = false, estimate, releaseOnHttpError = true, onSettle = () => {}, fetchImpl = globalThis.fetch } = o ?? {};
  if (!prices && !estimate) throw new PolicyError('prices', 'pass prices {inPer1M, outPer1M} or estimate()');
  return async function guardedFetch(url, init = {}) {
    let body;
    try { body = JSON.parse(init.body); } catch { throw new PolicyError('body', 'request body must be a JSON string'); }
    if (typeof body?.model !== 'string') throw new PolicyError('model', 'request body has no model');
    const usd = estimate ? String(estimate(body)) : fromNano(holdFor(body, prices));
    const purpose = typeof init.purpose === 'string' ? init.purpose.slice(0, 200) : null;
    const hold = cap.authorize({ venue, model: body.model, usd, privacy, purpose });
    if (!hold.ok) throw new SpendCapDenied(hold.reasons);
    const done = (info) => { const full = { id: hold.id, heldUsd: hold.reservedUsd, ...info }; onSettle(full); return full; };

    let res;
    try {
      res = await fetchImpl(url, init);
    } catch (e) {
      // The request may or may not have reached the provider: the hold stays open and keeps counting.
      e.spendcapHoldId = hold.id;
      done({ ok: false, state: 'open', note: 'network error before a response; hold left open (outcome unknown)' });
      throw e;
    }
    if (!res.ok) {
      let info;
      if (releaseOnHttpError) { cap.release(hold.id); info = done({ ok: true, state: 'released', status: res.status }); }
      else info = done({ ok: false, state: 'open', status: res.status });
      return Object.assign(res, { spendcap: { holdId: hold.id, settled: Promise.resolve(info) } });
    }
    const settle = (usage, receipt) => {
      const c = chargeFrom(usage, prices, { reportedCost });
      const nano = c?.nano ?? toNano(hold.reservedUsd);
      try {
        const r = cap.settle(hold.id, fromNano(nano), { receipt: typeof receipt === 'string' && receipt.length >= 8 ? receipt : null });
        return done({ ...r, state: 'settled', basis: c?.basis ?? 'no-usage-charged-full-hold' });
      } catch (e) {
        // e.g. the policy requires a receipt and the response had no id: the hold stays open and keeps counting.
        return done({ ok: false, state: 'open', error: e.message });
      }
    };
    const tag = (r, settled) => Object.assign(r, { spendcap: { holdId: hold.id, settled } });
    const isStream = body.stream === true || (res.headers.get('content-type') ?? '').includes('text/event-stream');
    if (!isStream) {
      const json = await res.clone().json().catch(() => null);
      return tag(res, Promise.resolve(settle(usageOf(json), json?.id ?? json?.response?.id)));
    }
    // Stream: pass one branch through, read usage from the other's events, settle when it ends.
    const [mine, theirs] = res.body.tee();
    const settled = (async () => {
      let usage = null, id = null, buf = '';
      const dec = new TextDecoder();
      const take = (line) => {
        if (!line.startsWith('data:')) return;
        const d = line.slice(5).trim();
        if (!d || d === '[DONE]') return;
        try { const j = JSON.parse(d); usage = usageOf(j) ?? usage; id = j.id ?? j.response?.id ?? id; } catch { /* not JSON: ignore */ }
      };
      try {
        for await (const chunk of mine) {
          buf += dec.decode(chunk, { stream: true });
          const lines = buf.split(/\r?\n/);
          buf = lines.pop();
          lines.forEach(take);
        }
        take(buf);
      } catch { /* stream broke: settle with what we saw, or the full hold */ }
      return settle(usage, id);
    })();
    return tag(new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers }), settled);
  };
}
