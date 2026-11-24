# agent-spendcap

Give an AI agent a budget it can't argue its way out of.

Before each paid inference call, the agent asks for permission. If every rule in your policy passes, the money is **held**. After the call, the agent **settles** what the call really cost or **releases** the hold. Every decision is one entry in a hash-chained ledger, refusals included.

- Exact decimals as strings, down to $0.000000001. No floats anywhere.
- No network access, no wallet and no keys. One dependency: [`@noble/hashes`](https://github.com/paulmillr/noble-hashes).
- Usable as a library, a CLI or an MCP server.

**Live playground:** https://xbtmelchizedek.github.io/agent-spendcap/ lets you write a policy, unleash a runaway agent on it and tamper with the ledger.

## Quickstart

```sh
curl -sO https://raw.githubusercontent.com/xbtMelchizedek/agent-spendcap/main/examples/policy.json
npx -y github:xbtMelchizedek/agent-spendcap authorize --policy policy.json \
  --venue openrouter:pearl-research/fp8 --model qwen/qwen3.8-27b --usd 0.004 --privacy no-retention
# {"ok":true,"id":"…","reservedUsd":"0.004","remaining":[{"window":"hour","usd":"0.496"},{"window":"day","usd":"1.996"}]}
```

Node 22 or later. The ledger lives at `~/.agent-spendcap/ledger.jsonl` with mode 600. You can change that with `--ledger` or `SPENDCAP_LEDGER`.

## The policy

```json
{
  "version": 1,
  "perCallMax": "0.05",
  "windows": [
    { "name": "hour", "seconds": 3600, "max": "0.50" },
    { "name": "day", "seconds": 86400, "max": "2" }
  ],
  "venues": { "allow": ["openrouter:*", "venice", "chutes-bittensor", "pearl-labs", "local"], "deny": ["openrouter:unknown-*"] },
  "minPrivacy": "no-retention",
  "maxCallsPerMinute": 30,
  "reservationTtlSeconds": 600,
  "requireReceipt": false
}
```

| Field | Meaning |
|---|---|
| `perCallMax` | No single call may hold more than this. |
| `windows` | 1 to 8 rolling windows, from 60 seconds to 366 days. Each `max` must be at least `perCallMax`, or that window could never allow a call. |
| `venues`, `models` | `allow` and `deny` lists. `*` is allowed only at the end of an entry. If something matches both lists, deny wins. Leave out `allow` to allow everything. |
| `minPrivacy` | `any` < `no-retention` < `tee` < `local`. The caller declares what the venue offers, and anything below the floor is refused. |
| `maxCallsPerMinute` | Stops a loop that's stuck. |
| `reservationTtlSeconds` | After this long, an unresolved hold is marked expired. **It still counts** (see below). |
| `requireReceipt` | When true, every settle must carry a receipt reference (8 to 200 chars), such as an OpenRouter generation id or a Flop settlement. |

Unknown fields are an error, so `perCallMaz` is refused instead of being silently ignored. Amounts must be strings like `"0.05"`; JSON numbers are refused.

## Rules worth knowing

- **Holds count until they're resolved, even after they expire.** If you never found out what a call cost, assume it cost the full hold. An agent that crashes mid-call can't spend the same budget twice.
- **Reality wins on overruns.** If a provider charges more than the hold, `settle` records the real amount, returns `overrun: true` and `ok: false`, and the overrun counts against every window. Tighten your estimates or your caps.
- **Refusals are logged.** `status` reports how many calls were refused, and the ledger records why.
- **Bad input throws instead of logging.** A malformed amount or venue id is a programming error, not a decision.
- **One writer per ledger file.** A second process gets `in use by pid N`. A lock left behind by a dead process is taken over.
- **An edited ledger refuses to load.** Each entry hashes the one before it, so a change, a reordering or a deletion stops the next run at that entry.

## Library

```js
import { SpendCap, parsePolicy } from 'agent-spendcap';
import { fileLedger } from 'agent-spendcap/file';

const cap = new SpendCap({ policy: parsePolicy(policyJson), ledger: fileLedger('./spend.jsonl') });
const hold = cap.authorize({ venue: 'venice', model: 'qwen/qwen3.8-27b', usd: '0.004', privacy: 'tee', purpose: 'summarize ticket 812' });
if (!hold.ok) throw new Error(hold.reasons.join('; '));
try {
  const res = await callTheModel();
  cap.settle(hold.id, res.costUsd, { receipt: res.generationId });
} catch (e) {
  cap.release(hold.id); // only if you know nothing was charged
  throw e;
}
```

In the browser or in tests, use `memoryLedger()` instead of `fileLedger(...)`.

## CLI

```
agent-spendcap check     --policy p.json
agent-spendcap authorize --policy p.json --venue <id> --model <id> --usd <amount> [--privacy …] [--purpose …]
agent-spendcap settle    --policy p.json --id <hold> --usd <charged> [--receipt <ref>]
agent-spendcap release   --policy p.json --id <hold>
agent-spendcap status    --policy p.json
agent-spendcap verify
```

Exit codes: 0 means ok, 1 means refused (or a broken ledger), 2 means bad input. Output is JSON on stdout.

## MCP server

```json
{ "mcpServers": { "spendcap": { "command": "npx", "args": ["-y", "github:xbtMelchizedek/agent-spendcap", "mcp", "--policy", "/abs/path/policy.json"] } } }
```

It provides four tools: `spendcap_authorize`, `spendcap_settle`, `spendcap_release` and `spendcap_status`. A refusal comes back as `isError: true` with the reasons.

Inside one process, the agent can't skip the check, but it can still call a model directly. Real enforcement means giving the provider keys only to the process that holds the cap. Pair this with [justweight](https://github.com/xbtMelchizedek/justweight), whose `infer` quotes a call before you authorize it.

## Limits

- The cap is only as honest as the `usd` and `privacy` values the caller reports. It's a policy engine, not a payment rail. Point it at your actual spend (an x402 client, a provider wrapper, a Flop channel) and settle from the provider's own receipts.
- Windows are measured in wall-clock time from the process. Moving the clock backwards frees budget.
- The ledger keeps everything. For very long histories, rotate files; see issue #1.

## Develop

```sh
npm ci && npm test        # 12 tests, including a 3,000-step random property test
npm run build-web         # _site/ playground; serve it with any static server
```

See [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately per [SECURITY.md](SECURITY.md).

MIT. Vendored in the playground: Arc UI foundation tokens (MIT, see `web/arc/LICENSE`) and `@noble/hashes` (MIT).
