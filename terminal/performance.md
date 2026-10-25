# Terminal performance

Both required terminal benchmarks passed with Bun 1.3.11.

Navigation compared the change with main commit `5ce0c7c5a08e`, using five alternating runs per side. The median p50 keypress time passed the regression gate; cells redrawn per keypress remained 92. Latency varied across local runs.

The memory benchmark completed all 120 tickers. Its late heap-growth slope was 0.05 MiB/ticker against the 0.30 MiB/ticker limit.
