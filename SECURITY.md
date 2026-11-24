# Security

Report vulnerabilities privately through GitHub's **Report a vulnerability** button on this repository (Security tab, then Advisories). Please don't open a public issue.

In scope:
- Any way to get an authorized hold that breaks a policy rule.
- Spending the same budget twice.
- A ledger edit that still verifies.
- Two writers on one ledger file.
- A ledger file readable by other users.
- Policy parsing that silently accepts something it should refuse.

Out of scope: a caller that reports a false `usd` or `privacy`. The README documents that limit.

This library holds no funds and no keys, and it makes no network calls.
