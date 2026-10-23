# EQS plain ticker checks

The actual `fn EQS --check` command and EQS pane were exercised against old and new local HTTP routes populated with the same observed listing rows in isolated screening snapshots. These checks made no production writes. The new server change has not been deployed, so these are local integration results.

The app sends bare NVDA and AAPL without an exchange. The server resolves them using screen currency and the existing primary/home listing rules. Other criteria do not determine listing identity. Explicit exchanges remain authoritative.

| Input | Screen | Before | After |
|---|---|---|---|
| NVDA | USD, market cap >= 1 trillion | Ambiguous BMV/NASDAQ | NASDAQ; both criteria pass |
| AAPL | USD, market cap >= 1 trillion | Ambiguous BMV/NASDAQ | NASDAQ; both criteria pass |
| NVDA | USD, market cap >= 100 quintillion | Ambiguous BMV/NASDAQ | NASDAQ; cap fails |
| NVDA:BMV | USD, market cap >= 1 trillion | BMV; currency fails | BMV; currency fails |
| 2454 | Any currency, no criteria | Ambiguous JPX/TWSE | Ambiguous JPX/TWSE |
| 2454:JPX | Any currency, no criteria | All About, Inc. on JPX | All About, Inc. on JPX |

The covered 2454 listings are different companies: All About, Inc. on JPX and MediaTek Inc. on TWSE. Currency is unrestricted for that ambiguity check. Market-cap values retain their partial status because the stored observation date is unavailable; the collection date is shown separately.

Validation: all 12 before/after CLI cases compare selected listing, verdict and every criterion with the actual route responses. All 12 terminal cases verify the displayed decision or ambiguity choices. Files ending in `-fn.json` are captured CLI output (errors are emitted on stderr); `-pane.txt` and `-pane.png` capture the terminal pane at 120 columns.

Only documentation changes in this app follow-up. Existing EQS layout, UI-token and full-view benchmark evidence remains in the PR; no additional layout change was made.
