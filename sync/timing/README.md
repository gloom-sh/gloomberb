# Locked sync timing check

Compared base `4c11d3c99f0849cda8e9a7f296272fc7d73d2a22` with final sync head `aa607800d9385046761be15bbe778ef0b9381541`, using Bun 1.3.11 and WebKit. The two runs were serial under the shared sweep lock at nice 19, after the UI sweep completed. Each scenario has five measured samples after warmup. Both commands exited 0 and reported `sync poll budget: ok`.

The invented workspace contains 300 positions, 1,200 tickers and 500 days of bars; its snapshot is about 222 KB. The codec scenario sends 4 MB in each direction through the desktop preload codec.

| Scenario | Base median longest block | Head median longest block | Budget |
| --- | ---: | ---: | ---: |
| Idle sync | 45 ms | 24 ms | 70 ms |
| Repriced sync | 37 ms | 20 ms | 70 ms |
| Layout edit | 41 ms | 30 ms | 90 ms |
| Preload codec | 27 ms | 14 ms | 50 ms |

Both sides uploaded zero of five idle polls and all five layout edits. [Base samples](before.json) and [head samples](after.json) retain the individual measurements, including the base layout maximum of 118 ms; budgets use the median longest block. The shared host still had a one-minute load average of 25.44 at the start, so these passing budget checks are not evidence of a speed improvement.

Command on each checkout:

```sh
bun scripts/pane-chrome/sync-poll.ts --check --label before
# Use --label after on the fixed checkout.
```

The temporary baseline checkout and timing scratch profile were removed after the checks.
