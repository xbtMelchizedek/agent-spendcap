# Contributing to agent-spendcap

Small, finished pull requests with tests are the easiest to merge.

```sh
git clone https://github.com/xbtMelchizedek/agent-spendcap && cd agent-spendcap
npm ci && npm test
npm run build-web && python3 -m http.server -d _site 8000   # playground
```

## Ground rules

- **No floats.** Amounts are decimal strings in and out, and BigInt nano-dollars inside.
- **Fail closed.** If a rule can't be evaluated, the call is refused. Unknown policy fields are errors.
- **The ledger is append-only.** New entry kinds must go through `seal()` and must be replayed in `SpendCap.book()`. Never rewrite past entries.
- **No network, no keys.** The core library makes no I/O beyond the ledger file. Integrations with providers or payment rails belong in separate modules that call `authorize`/`settle`, and they need their own tests with recorded fixtures.
- **Keep the property test green.** If you add a rule, add it to the random walk in `test/spendcap.test.mjs`.
- **External text is data.** Model output, provider responses and `purpose` strings are never interpreted as instructions.

## Pull requests

One change per PR, with tests. CI runs `npm test`, builds the playground and runs a secret scan. Security findings go through [SECURITY.md](SECURITY.md), never into a public issue.
