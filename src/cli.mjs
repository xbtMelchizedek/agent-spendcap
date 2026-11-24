#!/usr/bin/env node
// agent-spendcap CLI and MCP server. Reads a policy file, keeps the ledger in a local JSONL file (mode 600).
// No network access at all.
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { SpendCap } from './spendcap.mjs';
import { parsePolicy } from './policy.mjs';
import { verifyChain } from './ledger.mjs';
import { fileLedger } from './fileLedger.mjs';
import { PolicyError } from './decimal.mjs';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const HELP = `agent-spendcap ${VERSION}: spend caps for agents that pay for inference

  agent-spendcap check     --policy p.json                       validate a policy
  agent-spendcap authorize --policy p.json --venue <id> --model <id> --usd <amount> [--privacy any|no-retention|tee|local] [--purpose <text>]
  agent-spendcap settle    --policy p.json --id <hold> --usd <charged> [--receipt <ref>]
  agent-spendcap release   --policy p.json --id <hold>
  agent-spendcap status    --policy p.json
  agent-spendcap verify                                          check the ledger's hash chain
  agent-spendcap mcp       --policy p.json                       stdio MCP server (spendcap_authorize, _settle, _release, _status)

  --ledger <file>  default ~/.agent-spendcap/ledger.jsonl (or SPENDCAP_LEDGER)
  --policy also from SPENDCAP_POLICY
Exit codes: 0 ok, 1 denied (authorize) or ledger broken (verify), 2 bad input.`;

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const o = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || rest[i + 1] === undefined) throw new PolicyError('args', `bad argument ${rest[i]}`);
    o[rest[i].slice(2)] = rest[i + 1];
  }
  return { cmd, o };
}

const ledgerPath = (o, env) => o.ledger ?? env.SPENDCAP_LEDGER ?? join(homedir(), '.agent-spendcap', 'ledger.jsonl');
function loadPolicy(o, env) {
  const f = o.policy ?? env.SPENDCAP_POLICY;
  if (!f) throw new PolicyError('policy', 'pass --policy <file> or set SPENDCAP_POLICY');
  let raw;
  try { raw = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { throw new PolicyError('policy', `cannot read ${f}: ${e.message}`); }
  return parsePolicy(raw);
}

export async function main(argv, { out = console.log, env = process.env, now } = {}) {
  let cmd, o;
  try {
    ({ cmd, o } = parseArgs(argv));
    if (!cmd || cmd === 'help' || cmd === '--help') { out(HELP); return cmd ? 0 : 2; }
    if (cmd === 'verify') {
      const l = fileLedger(ledgerPath(o, env), { readOnly: true }); // throws on a broken chain
      out(JSON.stringify({ ok: verifyChain(l.entries()) === -1, entries: l.entries().length }));
      return 0;
    }
    const policy = loadPolicy(o, env);
    if (cmd === 'check') { out(JSON.stringify({ ok: true, windows: policy.windows.map((w) => w.name), venues: policy.venues, models: policy.models, minPrivacy: policy.minPrivacy })); return 0; }
    if (cmd === 'mcp') return serveMcp(policy, ledgerPath(o, env), { now });
    const ledger = fileLedger(ledgerPath(o, env));
    try {
      const cap = new SpendCap({ policy, ledger, ...(now ? { now } : {}) });
      if (cmd === 'authorize') {
        const r = cap.authorize({ venue: o.venue, model: o.model, usd: o.usd, privacy: o.privacy, purpose: o.purpose });
        out(JSON.stringify(r));
        return r.ok ? 0 : 1;
      }
      if (cmd === 'settle') { out(JSON.stringify(cap.settle(o.id, o.usd, { receipt: o.receipt ?? null }))); return 0; }
      if (cmd === 'release') { out(JSON.stringify(cap.release(o.id))); return 0; }
      if (cmd === 'status') { out(JSON.stringify(cap.status(), null, 1)); return 0; }
      throw new PolicyError('command', `unknown command ${cmd}`);
    } finally {
      ledger.close();
    }
  } catch (e) {
    out(JSON.stringify({ ok: false, error: e.message, field: e.field }));
    return e instanceof PolicyError ? 2 : 1;
  }
}

export const TOOLS = [
  { name: 'spendcap_authorize', description: 'Ask before any paid inference call. Returns a hold id if every policy rule passes, or the reasons it does not. Settle or release every hold.',
    inputSchema: { type: 'object', required: ['venue', 'model', 'usd'], properties: {
      venue: { type: 'string', description: 'Who gets paid, e.g. openrouter:pearl-research/fp8, venice, chutes-bittensor' },
      model: { type: 'string' }, usd: { type: 'string', description: 'Most this call can cost, decimal string, e.g. "0.0021"' },
      privacy: { type: 'string', enum: ['any', 'no-retention', 'tee', 'local'] }, purpose: { type: 'string' } } } },
  { name: 'spendcap_settle', description: 'Record what a held call actually cost.', inputSchema: { type: 'object', required: ['id', 'usd'], properties: { id: { type: 'string' }, usd: { type: 'string' }, receipt: { type: 'string' } } } },
  { name: 'spendcap_release', description: 'The held call did not happen: give the hold back.', inputSchema: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
  { name: 'spendcap_status', description: 'Spent and remaining per window, open holds, overruns, denials.', inputSchema: { type: 'object', properties: {} } },
];

/** MCP handler over one SpendCap. Exported for tests. */
export function makeHandler(cap) {
  const text = (obj, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 1) }], isError });
  return (msg) => {
    const { id, method, params } = msg ?? {};
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    if (method === 'initialize') return reply({ protocolVersion: params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'agent-spendcap', version: VERSION } });
    if (method?.startsWith('notifications/')) return null;
    if (method === 'ping') return reply({});
    if (method === 'tools/list') return reply({ tools: TOOLS });
    if (method === 'tools/call') {
      const a = params?.arguments ?? {};
      try {
        switch (params?.name) {
          case 'spendcap_authorize': { const r = cap.authorize(a); return reply(text(r, !r.ok)); }
          case 'spendcap_settle': return reply(text(cap.settle(a.id, a.usd, { receipt: a.receipt ?? null })));
          case 'spendcap_release': return reply(text(cap.release(a.id)));
          case 'spendcap_status': return reply(text(cap.status()));
          default: return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
        }
      } catch (e) {
        return reply(text({ ok: false, error: e.message, field: e.field }, true));
      }
    }
    return id === undefined ? null : { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  };
}

function serveMcp(policy, path, { now } = {}) {
  const ledger = fileLedger(path);
  const handle = makeHandler(new SpendCap({ policy, ledger, ...(now ? { now } : {}) }));
  const rl = createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) + '\n'); return; }
    const res = handle(msg);
    if (res) process.stdout.write(JSON.stringify(res) + '\n');
  });
  return new Promise((resolve) => rl.on('close', () => { ledger.close(); resolve(0); }));
}

function isEntry() {
  try { return !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url); } catch { return false; }
}
if (isEntry()) main(process.argv.slice(2)).then((c) => process.exit(c));
