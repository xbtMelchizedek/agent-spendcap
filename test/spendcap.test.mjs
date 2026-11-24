import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, statSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SpendCap, parsePolicy, memoryLedger, verifyChain, toNano, fromNano, PolicyError } from '../src/index.mjs';
import { fileLedger } from '../src/fileLedger.mjs';
import { main, makeHandler } from '../src/cli.mjs';

const example = JSON.parse(readFileSync(new URL('../examples/policy.json', import.meta.url), 'utf8'));
const clock = (t0 = 1_800_000_000_000) => { const c = () => c.t; c.t = t0; c.tick = (ms) => (c.t += ms); return c; };
let n = 0;
const make = (p = example, now = clock()) => new SpendCap({ policy: parsePolicy(p), ledger: memoryLedger(), now, newId: () => `h${++n}` });
const call = (o = {}) => ({ venue: 'openrouter:pearl-research/fp8', model: 'qwen/qwen3.8-27b', usd: '0.01', privacy: 'no-retention', ...o });

test('decimal: exact, strings only, never floats', () => {
  assert.equal(toNano('0.1') + toNano('0.2'), toNano('0.3'));
  assert.equal(fromNano(toNano('0.000000001')), '0.000000001');
  assert.equal(fromNano(toNano('12')), '12');
  for (const bad of [0.1, '1e-3', '-1', '0.0000000001', '', ' 1', '1.', '.5', null]) assert.throws(() => toNano(bad), PolicyError, String(bad));
});

test('policy: every field checked, unknown fields and unusable caps refused', () => {
  assert.equal(parsePolicy(example).windows.length, 2);
  const bad = [
    [{ ...example, perCallMaz: '1' }, /perCallMaz: unknown field/],
    [{ ...example, version: 2 }, /version/],
    [{ ...example, perCallMax: 0.05 }, /perCallMax/],
    [{ ...example, windows: [] }, /windows/],
    [{ ...example, windows: [{ name: 'day', seconds: 86400, max: '0.01' }] }, /below perCallMax/],
    [{ ...example, windows: [{ name: 'a', seconds: 30, max: '1' }] }, /seconds/],
    [{ ...example, windows: [{ name: 'a', seconds: 60, max: '1' }, { name: 'a', seconds: 120, max: '1' }] }, /unique/],
    [{ ...example, venues: { allow: ['open*router'] } }, /only allowed at the end/],
    [{ ...example, venues: { allwo: [] } }, /venues.allwo/],
    [{ ...example, minPrivacy: 'secret' }, /minPrivacy/],
    [{ ...example, maxCallsPerMinute: 0 }, /maxCallsPerMinute/],
  ];
  for (const [p, re] of bad) assert.throws(() => parsePolicy(p), re);
});

test('authorize: each rule refuses with a reason, and refusals are on the ledger', () => {
  const c = make();
  assert.match(c.authorize(call({ usd: '0.06' })).reasons[0], /per-call cap/);
  assert.match(c.authorize(call({ venue: 'shady-api' })).reasons[0], /not on the allow list/);
  assert.match(c.authorize(call({ venue: 'openrouter:unknown-x' })).reasons[0], /denied/);
  assert.match(c.authorize(call({ privacy: 'any' })).reasons[0], /below the policy minimum/);
  assert.throws(() => c.authorize(call({ usd: '0' })), /more than 0/);
  assert.throws(() => c.authorize(call({ venue: 'a b' })), /venue/);
  assert.equal(c.status().denied, 4);
  assert.equal(c.ledger.entries().length, 4, 'bad input is thrown, not recorded');
  const ok = c.authorize(call());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.remaining.map((r) => r.usd), ['0.49', '1.99']);
});

test('windows: holds count until settled or released, even after they expire; windows roll', () => {
  const now = clock();
  const c = make(example, now);
  const holds = [];
  for (let i = 0; i < 10; i++) holds.push(c.authorize(call({ usd: '0.05' })).id);
  const r = c.authorize(call({ usd: '0.01' }));
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /hour cap: \$0.5 used/);
  now.tick(11 * 60_000); // holds expire after 10 min but still count: outcome unknown means assume charged
  assert.equal(c.authorize(call()).ok, false);
  assert.equal(c.status().open.filter((h) => h.expired).length, 10);
  c.release(holds[0]);
  c.settle(holds[1], '0.02');
  assert.equal(c.authorize(call({ usd: '0.05' })).ok, true); // 0.5 - 0.05 - 0.03 freed = room for 0.05
  now.tick(59 * 60_000); // now t0+70min: the hour window (t0+10min, t0+70min] holds only the last 0.05
  assert.equal(c.status().windows[0].usedUsd, '0.05', 'hour window rolled past the first batch');
  assert.equal(c.status().windows[1].usedUsd, '0.47'); // 8 open × 0.05 + 0.02 settled + 0.05 new
});

test('settle and release: once each; overruns recorded and flagged; receipts when required', () => {
  const c = make({ ...example, requireReceipt: true });
  const id = c.authorize(call({ usd: '0.02' })).id;
  assert.throws(() => c.settle(id, '0.01'), /requires a receipt/);
  const s = c.settle(id, '0.03', { receipt: 'or-gen-123456' });
  assert.equal(s.overrun, true);
  assert.equal(s.ok, false);
  assert.throws(() => c.settle(id, '0.01', { receipt: 'or-gen-123456' }), /already settled/);
  assert.throws(() => c.release(id), /already settled/);
  assert.throws(() => c.release('nope'), /no hold/);
  assert.equal(c.status().overruns, 1);
  assert.equal(c.status().windows[1].usedUsd, '0.03', 'reality wins: the overrun counts');
});

test('rate limit: per rolling minute', () => {
  const now = clock();
  const c = make({ ...example, maxCallsPerMinute: 3 }, now);
  for (let i = 0; i < 3; i++) assert.equal(c.authorize(call({ usd: '0.001' })).ok, true);
  assert.match(c.authorize(call({ usd: '0.001' })).reasons[0], /rate/);
  now.tick(60_001);
  assert.equal(c.authorize(call({ usd: '0.001' })).ok, true);
});

test('property: across 3,000 random actions, no window ever exceeds its cap unless a settle overran', () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const now = clock();
  const c = make(example, now);
  const open = [];
  let overran = false;
  for (let i = 0; i < 3000; i++) {
    const x = rnd();
    if (x < 0.5) {
      const r = c.authorize(call({ usd: fromNano(BigInt(1 + Math.floor(rnd() * 60_000_000))) }));
      if (r.ok) open.push(r.id);
    } else if (x < 0.75 && open.length) {
      const id = open.splice(Math.floor(rnd() * open.length), 1)[0];
      const h = c.book().get(id);
      const charged = rnd() < 0.02 ? h.reserved + 1n : (h.reserved * BigInt(Math.floor(rnd() * 101))) / 100n;
      overran ||= c.settle(id, fromNano(charged)).overrun;
    } else if (x < 0.85 && open.length) {
      c.release(open.splice(Math.floor(rnd() * open.length), 1)[0]);
    } else {
      now.tick(Math.floor(rnd() * 20 * 60_000));
    }
    if (!overran) for (const u of c.usage()) assert.ok(u.used <= u.max, `step ${i}: ${u.window} ${u.used} > ${u.max}`);
  }
  assert.equal(verifyChain(c.ledger.entries()), -1);
});

test('ledger: hash chain catches any edit, reorder or deletion', () => {
  const c = make();
  for (let i = 0; i < 5; i++) c.authorize(call({ usd: '0.001' }));
  const e = structuredClone(c.ledger.entries());
  assert.equal(verifyChain(e), -1);
  const edited = structuredClone(e); edited[2].nano = '1';
  assert.equal(verifyChain(edited), 2);
  assert.equal(verifyChain([e[0], e[2], e[1], e[3]]), 1);
  assert.equal(verifyChain(e.slice(1)), 0);
  assert.throws(() => memoryLedger(edited), /entry 2/);
});

test('file ledger: mode 600, one writer at a time, damaged files refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-'));
  const path = join(dir, 'sub', 'ledger.jsonl');
  const l = fileLedger(path);
  const c = new SpendCap({ policy: parsePolicy(example), ledger: l, newId: () => `f${++n}` });
  c.authorize(call());
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.throws(() => fileLedger(path), /in use by pid/);
  l.close();
  assert.equal(existsSync(`${path}.lock`), false);
  const again = fileLedger(path);
  assert.equal(again.entries().length, 1);
  again.close();
  const lines = readFileSync(path, 'utf8').split('\n');
  writeFileSync(path, lines[0].replace('"0.01"', '"0.02"').replace('10000000', '20000000') + '\n', { mode: 0o600 });
  assert.throws(() => fileLedger(path), /altered/);
  writeFileSync(path, 'not json\n', { mode: 0o600 });
  assert.throws(() => fileLedger(path), /not JSON/);
});

test('cli: authorize, settle, status, verify through an npx-style symlink; exit codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sc-cli-'));
  const ledger = join(dir, 'l.jsonl');
  const pol = fileURLToPath(new URL('../examples/policy.json', import.meta.url));
  const link = join(dir, 'agent-spendcap');
  symlinkSync(fileURLToPath(new URL('../src/cli.mjs', import.meta.url)), link);
  const run = (...a) => spawnSync(process.execPath, [link, ...a, '--ledger', ledger], { encoding: 'utf8' });
  const a = run('authorize', '--policy', pol, '--venue', 'venice', '--model', 'qwen/qwen3.8-27b', '--usd', '0.004', '--privacy', 'tee');
  assert.equal(a.status, 0, a.stdout + a.stderr);
  const id = JSON.parse(a.stdout).id;
  assert.equal(run('authorize', '--policy', pol, '--venue', 'venice', '--model', 'm', '--usd', '9', '--privacy', 'tee').status, 1);
  assert.equal(run('authorize', '--policy', pol, '--venue', 'venice', '--model', 'm', '--usd', 'lots').status, 2);
  assert.equal(run('settle', '--policy', pol, '--id', id, '--usd', '0.0031').status, 0);
  const st = JSON.parse(run('status', '--policy', pol).stdout);
  assert.equal(st.windows[0].usedUsd, '0.0031');
  assert.equal(st.denied, 1);
  assert.equal(JSON.parse(run('verify').stdout).entries, 3);
  const out = [];
  assert.equal(await main(['frobnicate', '--policy', pol, '--ledger', join(dir, 'x.jsonl')], { out: (s) => out.push(s) }), 2);
});

test('mcp: tools list and a full hold cycle', () => {
  const h = makeHandler(make());
  assert.equal(h({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).result.tools.length, 4);
  const res = (r) => JSON.parse(r.result.content[0].text);
  const a = res(h({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'spendcap_authorize', arguments: call() } }));
  assert.equal(a.ok, true);
  const denied = h({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'spendcap_authorize', arguments: call({ usd: '5' }) } });
  assert.equal(denied.result.isError, true);
  assert.equal(res(h({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'spendcap_release', arguments: { id: a.id } } })).ok, true);
  const bad = h({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'spendcap_settle', arguments: { id: a.id, usd: '0.01' } } });
  assert.match(res(bad).error, /already released/);
  assert.equal(h({ jsonrpc: '2.0', id: 6, method: 'nope' }).error.code, -32601);
});
