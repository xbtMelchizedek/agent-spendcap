# Changelog

## 0.2.1 (2026-11-25)

- `holdFor`: the output bound is now `max(n, best_of) x max_tokens` (each choice bills output); non-integer or zero `n`/`best_of` is refused. Requests with image, audio, file or video parts are refused unless you pass `estimate()`, since a short URL can bill far more than its bytes. Reported on Technocore /r/builders #41944.

## 0.2.0 (2026-11-24)

- New `agent-spendcap/openai`: `spendcapFetch(cap, {venue, prices, privacy, ...})` returns a fetch-compatible function for any OpenAI-compatible API (Chat Completions or Responses, streaming or not). It closes #3.
  - **Before the request:** it holds an upper bound, counting every input byte as a token plus `max_tokens` × the output price, or your own `estimate()`. A refused call throws `SpendCapDenied` and never reaches the network.
  - **After the request:** it settles from the response's own `usage`, either tokens × prices or, with `reportedCost: true`, OpenRouter's `usage.cost` (credits = USD). The receipt is the response id. For streams, usage is read from the final event while the caller receives every byte untouched.
  - **When things go wrong:** with no usage, it charges the full hold. A non-2xx response releases the hold. A network error leaves the hold open, because the outcome is unknown. A required receipt that's missing also leaves the hold open, and the response is still returned.
  - Each response carries `res.spendcap = {holdId, settled}`.
- 19 tests (7 new). Response fixtures are synthetic and follow OpenRouter's documented shapes. No live calls.

## 0.1.0 (2026-11-24)

First release.

- `SpendCap` uses a two-phase hold: `authorize`, then `settle` or `release`. It checks a per-call cap, 1 to 8 rolling windows, venue and model allow/deny lists (deny wins, trailing `*`), a privacy floor (`any` < `no-retention` < `tee` < `local`), a per-minute rate limit and optional required receipts.
- Unresolved holds count against every window, even after they expire. Overruns are recorded at the real amount and flagged.
- Strict policy parsing: unknown fields, float amounts and caps that could never allow a call are all refused.
- Hash-chained ledger (sha256, canonical JSON). `memoryLedger` and `fileLedger` are provided. The file ledger uses JSONL with mode 600, allows one writer per file (a stale lock is taken over) and refuses to load a file that has been edited, reordered or truncated.
- CLI: `check`, `authorize`, `settle`, `release`, `status`, `verify`. Exit codes 0/1/2, JSON output.
- MCP stdio server: `spendcap_authorize`, `spendcap_settle`, `spendcap_release`, `spendcap_status`.
- Browser playground on GitHub Pages.
- 12 tests, including a 3,000-step random property test showing that no window ever goes over its cap unless a settle overran.
