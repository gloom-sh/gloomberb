# UI blast radius: 0 of 599 views changed

One unsteady view is excluded after repeat captures. All eight shards completed on the same offline replay, with Chromium at 640 and 1280 px.

- Base: `11689928330b46831b657730e46538a26a5ab1bb`.
- Head: `425a893ae2920b8b64e97b80072124d428e72dc5`. Captured before commit; the tested implementation matches this commit.
- 599 measured views of 182 functions and shell views; 1,197 measurements on each side. Catalog, bundled plugin, registry plugin and shell views are included.
- No failed or unmeasured views, no pictures present on only one side, and no pixel comparison errors. The catalog records 78 intentionally skipped tabs on both sides.
- UI tokens passed: every measured value follows the tokens or one of eight existing allowances. No allowance was added.

The first pixel report found one apparent change: `OVDV--root`, 3.7% at 640 px and effectively unchanged at 1280 px. Its base capture was still loading 13 of 18 option expiries, while the head capture had finished. Repeating the unchanged base changed 3.746% of its 640 px picture and 0.05365% at 1280 px; repeating the unchanged head changed 0.05380% at 1280 px. This exceeds the benchmark's 0.05% instability threshold on both sides, so the 3D surface is excluded as unsteady. [Original blast-radius sheet](ovdv-loading-difference.jpg) · [Repeat measurements](ovdv-repeat-comparison.json).

The normal sweep uses its default symbols, so Treasury notation is demonstrated separately in the [targeted before/after captures](../README.md). No shared UI styling changed. The final Overview gutter adjustment was remeasured across its 54 screenshots: no additional pixel changes.

Commands: `bun run ui:benchmark shoot --base origin/main --offline --shard i/8` for each shard, `bun run ui:benchmark report --expect-shards 8`, repeat `audit:ui` for the unsteady OVDV view, and `bun run check:ui-tokens --results <completed head run>`.

This host's ImageMagick 7 prints its AE pixel count with a normalized count in parentheses. A task-local wrapper retained the absolute count and exit status for the repository's parser. Sheet annotations used the system Menlo font because the configured font aliases were absent. Neither adjustment changed the app or the captured pixels.

[Per-family comparison](families.md) and its [sheets](families/) preserve the original measured differences, including the unsteady OVDV surface.
