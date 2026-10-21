# GIP reference-line drift — independent retained-evidence audit

The existing evidence corroborates chart/capture instability, with the precise asynchronous cause still unproven. The official GLO-1166 GIP delta remains **5,815 pixels / 0.6344928%** of the 1280px screenshot body, and its retained `unsteady.json` remains empty.

Across GLO-1163 and GLO-1166, both before bodies are pixel-identical and both after bodies are pixel-identical (ImageMagick 2% fuzz, 42px top/bottom excluded). Each before-to-after comparison has the same 5,815-pixel difference. GLO-1163's retained classification marks GIP unsteady after same-code retries; GLO-1166's retries did not. The exact log lines and hashed raw artifacts are bound in `ci-ui-gip-investigation.json`. Retry images themselves were deleted by the existing harness, so their precise deltas cannot be recovered.

The complete chart, time-series, market-data, sources, DOM/browser renderer and pane-chrome harness trees are identical across frozen baseline, marketplace head and Trending head. GLO-1166 changes only Marketplace's pane/test and usage documentation. GIP's complete DOM measurements match; only the instance ID differs, encoding a 4 **millisecond** creation-time delta, not four seconds.

A plausible mechanism is the transition from a bar-derived prior close in the chart seed to a quote-derived prior close in the settled resolver. The dotted gray line can move while candles and DOM text remain unchanged, and the harness waits for DOM mutations to stop rather than canvas pixels to stabilize. This is a source-supported candidate, not a recovered trace: CI retained neither the raw replay responses nor the request/resolution timeline. Matching cache keys alone do not prove identical snapshot contents.

No source, raw evidence, result classification or workflow was changed; no rendering or tests were rerun.
