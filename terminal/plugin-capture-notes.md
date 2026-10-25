# External plugin terminal captures

**24 of 24 retained frame pairs are byte-identical:** 20 from the original run and four from the corrected spinner run. Each before/after pair comes from one run; the per-frame hashes record which one.

The original run completed all 24 pairs. Four pairs differed in exactly one existing spinner cell; every other character matched. The corrected run fixes the shared spinner at its first frame before rendering both revisions, preserving the other harness inputs and real waits. It compares the raw captured strings directly.

The corrected run completed 23 matched pairs, all byte-identical. Its baseline `fxmacrodata-research` view at 160 columns exceeded the 10-second test timeout and produced no frame; the head completed all 24. That corrected variant remains a coverage gap. The original matching pair was already byte-identical and is retained from the original run.

| Retained source | Pairs | Exact character equality |
|---|---:|---:|
| Original run | 20 | 20 |
| Fixed-spinner run | 4 | 4 |

The four corrected pairs are `adjacent` at 80 columns, `crypto-fear-greed` at 80, `polls` at 160, and `prediction-markets` at 160.

Captures cover 12 root panes from the 16 external packages at 80 × 24 and 160 × 24 cells, offline and signed out. Five packages register no root pane; the inventory lists these. Styling spans, signed-in content, secondary views, chart bitmap pixels, and loaded data for panes that remained loading are outside this coverage.

- [Comparison and limitations](plugin-comparison.json)
- [Retained per-frame hashes and run provenance](plugin-frame-hashes.json)
- [Original raw-frame hash manifest](plugin-original-frame-hashes.json)
- [Corrected raw-frame hash manifest, including the missing variant](plugin-corrected-frame-hashes.json)

The comparison summary includes SHA256 hashes of both original comparison files. Raw pane text remains local.
