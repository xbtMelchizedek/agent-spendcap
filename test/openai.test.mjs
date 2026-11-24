import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SpendCap, parsePolicy, memoryLedger } from '../src/index.mjs';
import { spendcapFetch, SpendCapDenied, holdFor, costOf, reportedNano, chargeFrom } from '../src/openai.mjs';
import { fromNano } from '../src/decimal.mjs';

const fx = (f) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url), 'utf8');
const policy = JSON.parse(fx('../../examples/policy.json'));
const PRICES = { inPer1M: '0.2', outPer1M: '0.8' };
const mk = (p = policy) => new SpendCap({ policy: parsePolicy(p), ledger: memoryLedger() });
const req = (extra = {}) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'qwen/qwen3.8-27b', max_tokens: 500, messages: [{ role: 'user', content: 'hi' }], ...extra }) });
const reply = (body, { status = 200, type = 'application/json' } = {}) => async () => new Response(body, { status, headers: { 'content-type': type } });

test('estimates: byte upper bound, exact costs, reported cost rounded up', () => {
  const body = JSON.parse(req().body);
  const bytes = new TextEncoder().encode(JSON.stringify(body.messages)).length + 2; // + JSON '""' for no tools
  assert.equal(holdFor(body, PRICES), costOf(PRICES, bytes, 500));
  assert.equal(fromNano(costOf(PRICES, 1200, 300)), '0.00048');
  assert.equal(fromNano(costOf({ inPer1M: '0.000001', outPer1M: '0' }, 1, 0)), '0.000000001', 'rounds up, never to zero');
  assert.equal(reportedNano(0.0004213), 421300n);
  assert.equal(reportedNano(0.0000000001), 1n);
  assert.equal(reportedNano(-1), null);
  assert.equal(reportedNano('0.1'), null);
  assert.throws(() => holdFor({ model: 'm', messages: [] }, PRICES), /max_tokens/);
  assert.equal(chargeFrom({ prompt_tokens: 1200, completion_tokens: 300, cost: 0.0004213 }, PRICES).basis, 'tokens', 'reported cost ignored unless trusted');
  assert.equal(chargeFrom({ prompt_tokens: 1200, completion_tokens: 300, cost: 0.0004213 }, PRICES, { reportedCost: true }).nano, 421300n);
});

test('chat completion: hold, call, settle from tokens, receipt is the generation id', async () => {
  const cap = mk();
  const seen = [];
  const f = spendcapFetch(cap, { venue: 'openrouter:pearl-research/fp8', prices: PRICES, privacy: 'no-retention', fetchImpl: reply(fx('chat_completion.json')), onSettle: (i) => seen.push(i) });
  const res = await f('https://example.invalid/v1/chat/completions', req());
  assert.equal((await res.json()).choices[0].message.content, 'ok', 'caller still reads the body');
  const s = await res.spendcap.settled;
  assert.deepEqual([s.state, s.basis, s.chargedUsd], ['settled', 'tokens', '0.00048']);
  assert.equal(seen.length, 1);
  const e = cap.ledger.entries().at(-1);
  assert.equal(e.receipt, 'gen-synthetic-0001');
  assert.equal(cap.status().windows[0].usedUsd, '0.00048');
});

test('reported cost (OpenRouter credits = USD) when trusted', async () => {
  const cap = mk();
  const f = spendcapFetch(cap, { venue: 'openrouter:pearl-research/fp8', prices: PRICES, privacy: 'no-retention', reportedCost: true, fetchImpl: reply(fx('chat_completion.json')) });
  const s = await (await f('https://example.invalid/v1/chat/completions', req())).spendcap.settled;
  assert.deepEqual([s.basis, s.chargedUsd], ['reported-cost', '0.0004213']);
});

test('refused calls never reach the network', async () => {
  const cap = mk();
  let called = 0;
  const f = spendcapFetch(cap, { venue: 'shady-api', prices: PRICES, privacy: 'no-retention', fetchImpl: async () => { called++; return new Response('{}'); } });
  await assert.rejects(f('https://example.invalid', req()), (e) => e instanceof SpendCapDenied && /allow list/.test(e.reasons[0]));
  const g = spendcapFetch(cap, { venue: 'venice', prices: { inPer1M: '100', outPer1M: '100' }, privacy: 'tee', fetchImpl: async () => { called++; return new Response('{}'); } });
  await assert.rejects(g('https://example.invalid', req()), /per-call cap/);
  await assert.rejects(g('https://example.invalid', req({ max_tokens: undefined })), /max_tokens/);
  assert.equal(called, 0);
  assert.equal(cap.status().denied, 2);
});

test('streams: chat chunks and Responses events settle when the stream ends; the caller gets every byte', async () => {
  for (const [file, charged, receipt] of [['chat_stream.sse', costOf(PRICES, 800, 200), 'gen-synthetic-0002'], ['responses_stream.sse', costOf(PRICES, 19, 277), 'resp-synthetic-0003']]) {
    const cap = mk();
    const f = spendcapFetch(cap, { venue: 'venice', prices: PRICES, privacy: 'tee', fetchImpl: reply(fx(file), { type: 'text/event-stream' }) });
    const res = await f('https://example.invalid', req({ stream: true }));
    assert.equal(await res.text(), fx(file));
    const s = await res.spendcap.settled;
    assert.equal(s.chargedUsd, fromNano(charged), file);
    assert.equal(cap.ledger.entries().at(-1).receipt, receipt);
  }
});

test('no usage: charged the full hold; HTTP error: released; network error: hold left open', async () => {
  const cap = mk();
  const nousage = spendcapFetch(cap, { venue: 'venice', prices: PRICES, privacy: 'tee', fetchImpl: reply('{"id":"gen-synthetic-0004","choices":[]}') });
  const s1 = await (await nousage('https://example.invalid', req())).spendcap.settled;
  assert.equal(s1.basis, 'no-usage-charged-full-hold');
  assert.equal(s1.chargedUsd, s1.heldUsd);
  const err = spendcapFetch(cap, { venue: 'venice', prices: PRICES, privacy: 'tee', fetchImpl: reply('{"error":{"code":429}}', { status: 429 }) });
  const r2 = await err('https://example.invalid', req());
  assert.equal(r2.status, 429);
  assert.equal((await r2.spendcap.settled).state, 'released');
  const boom = spendcapFetch(cap, { venue: 'venice', prices: PRICES, privacy: 'tee', fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  await assert.rejects(boom('https://example.invalid', req()), (e) => typeof e.spendcapHoldId === 'string');
  assert.equal(cap.status().open.length, 1, 'unknown outcome keeps counting');
});

test('receipt required but missing: hold stays open instead of throwing away the response', async () => {
  const cap = mk({ ...policy, requireReceipt: true });
  const f = spendcapFetch(cap, { venue: 'venice', prices: PRICES, privacy: 'tee', fetchImpl: reply('{"usage":{"prompt_tokens":1,"completion_tokens":1}}') });
  const res = await f('https://example.invalid', req());
  const s = await res.spendcap.settled;
  assert.equal(s.state, 'open');
  assert.match(s.error, /receipt/);
  assert.equal(res.status, 200);
});
