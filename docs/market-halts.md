# Market halts

HALT refreshes every minute. All shows recent active halts and reported
resumptions; Active shows recent halts whose trading has not resumed, including
quotation-only periods. Long-term holds unresolved halts that started at least
30 elapsed days ago. Resumed includes a long-term halt as soon as trading
resumes, and that row returns to All.

The 30-day cutoff separates prolonged suspensions without hiding overnight or
weekend carryovers. On October 4, 2026 the live feed contained seven unresolved
halts aged 1–11 days and eleven aged 114–2,780 days. The cutoff sits within that
gap; it is a display rule, not a trading-status classification.

Age is elapsed time since the halt, in completed minutes, hours or days. It
stops at the trading resumption time. Halt and resumption dates and clocks are
Eastern Time. A quotation resumption does not mean trading has resumed.

For a screenshot of a specific view, pass `--initialTab active` or
`--initialTab long-term` to `gloomberb shot HALT`.
