# Final Marketplace evidence

Source head `815c846bce07d1c961e194826533953291d8ef2f` against frozen main `0568f95db049dccad254c672c2c8d284bbe6a586`.

The existing 16 focused sheets are preserved at the repository root. They show the actual Marketplace and its neighboring Themes pane in healthy, failed, incomplete and recovered states, white/paper at 640/1280. All neighboring crops and healthy full screenshots match.

[Official benchmark report](benchmark/summary.md): **1 of 531 views changed**, with all four shards complete. Its original report, comparison sheets and classifications are preserved under `benchmark/`.

The reported GIP change is a 5,815-pixel dotted reference-line difference at 1280 px (0.6344928% of the body); 640 px is unchanged. Independent comparison with prior same-code retry evidence and identical chart/render/harness trees corroborates existing capture instability, but the exact asynchronous cause is unproven. [Diagnosis](diagnostics/ci-ui-gip-investigation.md), [before](diagnostics/gip-before-1280.jpg), [after](diagnostics/gip-after-1280.jpg), [difference](diagnostics/gip-body-diff.png). GIP remains officially changed.

The report excludes `OVDV--root` and `OVDV--detail` as unsteady. The 1280 px roots show different partial loading states; the later detail-labeled pictures remain on the same settled surface. The unchanged harness labels any text change after Enter as detail, although the pane has no Enter action. Both 640 px roots were already settled, so no detail image was recorded there. This symmetric missing 640 px record is retained; it does not establish separate detail-route coverage. Settled differences localize to canvas labels, whose precise timing cause is unproven. [Diagnosis and image references](diagnostics/ci-ui-ovdv-investigation.md).

Coverage is 531 measured IDs and 1061 matched image pairs in Chromium, white, 640/1280 px, with one-level tab traversal and 42 px excluded at the top/bottom of the body comparison. There are 55 skipped alternatives per side. `LAY--detail` was declared but not captured on either side: Enter closes the owned layout gallery, and the harness declares a changed-text detail without a remaining pane. Twelve captured IDs symmetrically resolve to other panes; in particular `PL--root` captures ticker research, so the focused Marketplace fixtures provide the direct regression coverage. Official totals and labels are unchanged. All these limits were reviewed against retained artifacts; no rerender was used to remove them.

All six selected CI workflows passed; Verify ran 9,400 tests across 1,405 files (9,399 pass, 1 skip, 0 fail). The standalone token sweep measured 530 views at 640/1280 px with no warnings or unmeasured declarations and unchanged exceptions. The fresh 150-case offline CLI replay saved 1,049 files per side, all byte-identical. Independent reviews bind the exact source, archives, images, logs and metadata.
