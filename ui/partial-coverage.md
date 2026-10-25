# Partial capture coverage

Each retained variant uses a matched before/after pair. Targeted recaptures are identified below; earlier pictures do not fill missing variants.

## ADR

The corrected head traversal timed out after 720 seconds. Only the 88 captured paired variants are compared; 12 light-theme 1280px variants remain missing. Both sides use the same pane input and replay.

All 50 paired measured DOM records are exactly equal. 88 of 88 paired image variants are unchanged at the stock threshold; 0 candidate image differences remain. Missing variants do not count as unchanged.

Missing variants:

- ADR--tab-8-k, light, 1280 px.
- ADR--tab-apps, light, 1280 px.
- ADR--tab-ask-ai, light, 1280 px.
- ADR--tab-dividends, light, 1280 px.
- ADR--tab-hiring-momentum, light, 1280 px.
- ADR--tab-hiring, light, 1280 px.
- ADR--tab-insider, light, 1280 px.
- ADR--tab-m-a, light, 1280 px.
- ADR--tab-news, light, 1280 px.
- ADR--tab-sec, light, 1280 px.
- ADR--tab-thesis, light, 1280 px.
- ADR--tab-tweets, light, 1280 px.

## GPU

The offline capture left a loading footer on several GPU detail/history/equities states. Only the 11 paired completed variants are included; 9 variants remain missing or unpaired. Diagnostic replay reads all completed successfully; no replacement data was invented.

All 6 paired measured DOM records are exactly equal. 11 of 11 paired image variants are unchanged at the stock threshold; 0 candidate image differences remain. Missing variants do not count as unchanged.

Missing variants:

- GPU--detail, dark, 640 px.
- GPU--tab-equities, dark, 640 px.
- GPU--tab-history, dark, 1280 px.
- GPU--tab-equities, dark, 1280 px.
- GPU--tab-history, light, 640 px.
- GPU--tab-equities, light, 640 px.
- GPU--detail, light, 1280 px.
- GPU--tab-history, light, 1280 px.
- GPU--tab-equities, light, 1280 px.

## T

The baseline traversal timed out after 720 seconds. Retained coverage is 78 paired variants from the same pane input and offline replay; 21 light-theme 1280 px baseline variants remain missing. One dark-theme 1280 px root pair showed different financial values and is explicitly excluded.

All 49 retained paired DOM records are exactly equal. Of 78 retained paired image variants, 57 are byte-identical; the remaining 21 have zero pane-body pixel movement at the stock comparison threshold. The omitted root pair is a capture-state mismatch, not an unchanged view. Missing and excluded variants do not count as unchanged.

Missing variants:

- T--tab-8-k, light, 1280 px.
- T--tab-analyst, light, 1280 px.
- T--tab-apps, light, 1280 px.
- T--tab-ask-ai, light, 1280 px.
- T--tab-calls, light, 1280 px.
- T--tab-catalysts, light, 1280 px.
- T--tab-diagnostic, light, 1280 px.
- T--tab-dividends, light, 1280 px.
- T--tab-events, light, 1280 px.
- T--tab-exec, light, 1280 px.
- T--tab-hiring-momentum, light, 1280 px.
- T--tab-hiring, light, 1280 px.
- T--tab-insider, light, 1280 px.
- T--tab-m-a, light, 1280 px.
- T--tab-news, light, 1280 px.
- T--tab-options, light, 1280 px.
- T--tab-risks, light, 1280 px.
- T--tab-sec, light, 1280 px.
- T--tab-short-interest, light, 1280 px.
- T--tab-thesis, light, 1280 px.
- T--tab-tweets, light, 1280 px.

Excluded variants:

- T--root, dark, 1280 px: Different displayed financial values in the two captures; this pair is excluded from the comparison and is not counted as unchanged.

## LAY

The detail view remained loading for 30 seconds in all four width/theme variants on both revisions. Only the four completed root variants are included; the four detail variants remain missing on both sides.

All four completed full-frame image pairs are byte-identical, with identical shared pane input and both measured DOM records exactly equal. Missing details do not count as unchanged.

Missing variants:

- LAY--detail, dark, 640 px.
- LAY--detail, dark, 1280 px.
- LAY--detail, light, 640 px.
- LAY--detail, light, 1280 px.

## OVDV

Eleven paired variants are retained; twelve head variants remain missing after loading resumed, and the light 1280px root is excluded as a glyph-rasterization verification limit. The dark 640px root and Term use targeted captures with the same constant replay Date, a complete options snapshot, identical rendered data and scene, and a fully drawn stable surface on both revisions. The other nine pairs retain their original captures; no missing variant was filled.

Nine of the eleven retained pairs pass the standard pane-body pixel threshold. The dark 640px root and light 1280px Term are outside the unchanged claim: repeats of the baseline proved variation within the same revision for each exact variant. The excluded light 1280px root has matched data and layout, but pixel equality was not verified. The original mismatched captures remain local as diagnostic evidence; their clock advanced with elapsed time and their readiness check could precede a later loading phase.

Missing variants:

- OVDV--root, light, 640 px.
- OVDV--tab-forwards, light, 640 px.
- OVDV--tab-skew, light, 640 px.
- OVDV--tab-smile, light, 640 px.
- OVDV--tab-table, light, 640 px.
- OVDV--tab-term, light, 640 px.
- OVDV--root, dark, 1280 px.
- OVDV--tab-forwards, dark, 1280 px.
- OVDV--tab-skew, dark, 1280 px.
- OVDV--tab-smile, dark, 1280 px.
- OVDV--tab-table, dark, 1280 px.
- OVDV--tab-term, dark, 1280 px.

Excluded variants:

- OVDV--root, light, 1280 px: The light 1280 px surface root remains outside the pixel-equality claim. Of 5,128 changed pixels, 5,124 are inside measured label rectangles expanded 4 px and rounded to 8 px JPEG blocks; 4 remain outside, below the standard pane-body threshold. Scene data, camera, the 27 calculated label placements and recorded layout/style groups match. A baseline repeat was byte-identical, so variability within the same revision is not proved for this variant. Actual baseline label bounds match the calculated placement within 0.001 px, and actual shown surface arrays match the intended scene. The head did not record per-label browser bounds; glyph rasterization equality and the cause of the remaining pixel differences remain unverified. No absolute pixel confinement or JPEG chroma cause is claimed.

## CRYP

Two baseline dark 1280px tab captures are absent from the completed traversal; only the ten paired variants are retained.

10 of 10 retained pairs are unchanged at the stock pixel threshold. Missing and excluded variants do not count as unchanged.

Missing variants:

- CRYP--tab-defi, dark, 1280 px.
- CRYP--tab-stablecoins, dark, 1280 px.

## new-watchlist-pane

The light 1280px root captured different data readiness: the final row has three absent financial cells before and populated values after. That pair is excluded from unchanged coverage; the other eleven paired variants are retained.

11 of 11 retained pairs are unchanged at the stock pixel threshold. Missing and excluded variants do not count as unchanged.


Excluded variants:

- new-watchlist-pane--root, light, 1280 px: Different captured data readiness; not counted as unchanged.

## N

Primary paired run only; missing and visibly unsettled variants excluded. 4 captured variants show different acquisition or loading states and are excluded.

The 4 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.


Excluded variants:

- N--root, dark, 640 px: Ticker badge loading states differ.
- N--root, dark, 1280 px: Ticker badge loading states differ.
- N--root, light, 640 px: Ticker badge loading states differ.
- N--root, light, 1280 px: Ticker badge loading states differ.

## RETURN

Primary paired run only; missing and visibly unsettled variants excluded. 1 captured variant shows different acquisition or loading states and are excluded.

The 3 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.


Excluded variants:

- RETURN--root, light, 1280 px: Loaded history in baseline; unavailable-history error in head.

## JODI

Primary paired run only; missing and visibly unsettled variants excluded. 1 captured variant shows different acquisition or loading states and are excluded. 5 variants lack a paired capture and are excluded.

The 18 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.

Missing variants:

- JODI--tab-crops, dark, 1280 px.
- JODI--tab-curve, dark, 1280 px.
- JODI--tab-inventories, dark, 1280 px.
- JODI--tab-markets, dark, 1280 px.
- JODI--tab-positioning, dark, 1280 px.

Excluded variants:

- JODI--tab-markets, light, 1280 px: Historical-return acquisition differs; unavailable rows 44 versus 51.

## QR

Primary paired run only; missing and visibly unsettled variants excluded. 4 captured variants show different acquisition or loading states and are excluded. 1 variant lacks a paired capture and are excluded.

The 7 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.

Missing variants:

- QR--tab-trades, dark, 640 px.

Excluded variants:

- QR--root, dark, 1280 px: Transient footer warning appears only in head.
- QR--tab-trades, dark, 1280 px: Transient footer warning appears only in head.
- QR--tab-trades, light, 640 px: Transient footer warning present on only one revision; body matches.
- QR--root, light, 1280 px: Transient footer warning present on only one revision; body matches.

## SOVR

Primary paired run only; missing and visibly unsettled variants excluded. 3 variants lack a paired capture and are excluded.

The 17 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.

Missing variants:

- SOVR--tab-bonds, light, 1280 px.
- SOVR--tab-issuer-debt, light, 1280 px.
- SOVR--tab-treasury, light, 1280 px.

## GIP

Original primary paired run only; corrected GIP produced no shared accepted geometry. 2 captured variants show different acquisition or loading states and are excluded.

The 2 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.


Excluded variants:

- GIP--root, dark, 1280 px: Unavailable history in baseline; loaded chart in head.
- GIP--root, light, 640 px: Loaded chart in baseline; unavailable history in head.

## TV

Hosted stream capability unavailable on both revisions. Live playback not verified. All six completed paired frames are byte-identical. Six absent baseline variants remain missing. 6 variants lack a paired capture and are excluded.

The 6 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.

Missing variants:

- TV--tab-2-cnbc, light, 1280 px.
- TV--tab-3-channel, light, 1280 px.
- TV--tab-2-cnbc, light, 640 px.
- TV--tab-3-channel, light, 640 px.
- TV--tab-2-cnbc, dark, 1280 px.
- TV--tab-3-channel, dark, 1280 px.

## GTP

Original primary paired intersection only. One captured variant has a different selected chain and is excluded; the other 27 pairs are byte-identical. 1 captured variant shows different acquisition or loading states and are excluded.

The 27 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.


Excluded variants:

- GTP--tab-addresses, light, 640 px: Different selected chain: baseline Base versus head Polygon PoS. Shared pane input has no explicit chain; the existing first-visible-chain selection persisted across metric reorder. The selected chart and highlighted row differ, while the table values match.

## SI

Original completed primary paired intersection only; missing variants do not count as unchanged. 4 variants lack a paired capture and are excluded.

The 12 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.

Missing variants:

- SI--tab-daily-volume, light, 1280 px.
- SI--tab-fails-to-deliver, light, 1280 px.
- SI--tab-weekly-ats-otc, light, 1280 px.
- SI--tab-daily-volume, dark, 640 px.

## SIV

Original completed primary paired intersection only; missing variants do not count as unchanged. 3 variants lack a paired capture and are excluded.

The 17 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.

Missing variants:

- SIV--tab-fails-to-deliver, dark, 640 px.
- SIV--tab-interest, dark, 640 px.
- SIV--tab-weekly-ats-otc, dark, 640 px.

## POLL

Original completed primary paired intersection only; missing variants do not count as unchanged. 15 variants lack a paired capture and are excluded.

The 13 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.

Missing variants:

- POLL--tab-favorability, light, 640 px.
- POLL--tab-generic, light, 640 px.
- POLL--tab-governor, light, 640 px.
- POLL--tab-house, light, 640 px.
- POLL--tab-senate, light, 640 px.
- POLL--tab-favorability, dark, 1280 px.
- POLL--tab-generic, dark, 1280 px.
- POLL--tab-governor, dark, 1280 px.
- POLL--tab-house, dark, 1280 px.
- POLL--tab-senate, dark, 1280 px.
- POLL--tab-favorability, dark, 640 px.
- POLL--tab-generic, dark, 640 px.
- POLL--tab-governor, dark, 640 px.
- POLL--tab-house, dark, 640 px.
- POLL--tab-senate, dark, 640 px.

## YAS

Original completed primary paired intersection only; missing variants do not count as unchanged. 10 variants lack a paired capture and are excluded.

The 14 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.

Missing variants:

- YAS--tab-cash-flows, light, 1280 px.
- YAS--tab-credit, light, 1280 px.
- YAS--tab-issuer-debt, light, 1280 px.
- YAS--tab-sensitivity, light, 1280 px.
- YAS--tab-treasury, light, 1280 px.
- YAS--tab-cash-flows, dark, 640 px.
- YAS--tab-credit, dark, 640 px.
- YAS--tab-issuer-debt, dark, 640 px.
- YAS--tab-sensitivity, dark, 640 px.
- YAS--tab-treasury, dark, 640 px.

## TAS

Original completed primary paired intersection only; missing variants do not count as unchanged. 2 captured variants show different acquisition or loading states and are excluded. 2 variants lack a paired capture and are excluded.

The 8 selected primary pairs have identical pane input and unchanged pane-body pixels at the stock threshold. Missing or mismatched states do not count as unchanged.

Missing variants:

- TAS--tab-nbbo, light, 1280 px.
- TAS--tab-nbbo, dark, 1280 px.

Excluded variants:

- TAS--tab-nbbo, light, 640 px: Transient footer warning icon appears on only one side; pane body matches, footer state differs.
- TAS--root, dark, 1280 px: Transient footer warning icon appears on only one side; pane body matches, footer state differs.
