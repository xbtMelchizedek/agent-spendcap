# Changelog

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
