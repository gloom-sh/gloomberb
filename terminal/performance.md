# Terminal performance

The native comparison passed (exit 0). Its median p50 rose from 16.50 ms to 17.02 ms (+3.2%, +0.52 ms), below the gate requiring both more than 20% and at least 0.5 ms. Cells redrawn remained 92 per keypress.

Five alternating runs per side used Bun 1.3.11, one dedicated tmux server, and nice 19 while holding the shared UI benchmark lock. Base: `5ce0c7c5a08ec2eabc738a6789d5e8d9e9c80db4`. Head: `5082af5ad9a787647561a868b97b15866c6b22e2`.

| Middle value of five runs | Base | Head |
| --- | ---: | ---: |
| Typical keypress (p50) | 16.50 ms | 17.02 ms |
| Slow keypress (p95) | 135.56 ms | 127.82 ms |
| Slowest keypress | 162.30 ms | 268.31 ms |
| Peak memory | 623.3 MiB | 613.7 MiB |
| Cells redrawn per keypress | 92 | 92 |

| Run | Base p50 | Head p50 | Base p95 | Head p95 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 17.15 ms | 107.69 ms | 65.25 ms | 237.84 ms |
| 2 | 29.79 ms | 12.68 ms | 164.88 ms | 48.40 ms |
| 3 | 13.12 ms | 11.03 ms | 162.76 ms | 29.16 ms |
| 4 | 16.50 ms | 17.02 ms | 135.56 ms | 127.82 ms |
| 5 | 15.20 ms | 18.25 ms | 53.13 ms | 139.63 ms |

The host has 12 logical CPUs. One-minute host load was 45.61 before and 33.11 after this 249.45-second comparison. Scheduling contention and the large spread limit the result to this native gate outcome; these samples do not establish a general speedup or absence of a performance regression. No measured runs were discarded or selectively repeated.


The memory benchmark completed all 120 tickers. Its late heap-growth slope was 0.05 MiB/ticker against the 0.30 MiB/ticker limit.
