# GLO-1164 final shared error-body evidence

Application head: `0ad0e8587da2eee20f8c0810df8a6add62b9ba46`. Frozen main: `0568f95db049dccad254c672c2c8d284bbe6a586`.

The Alerts pane now shows one red “price alerts unavailable.” title and its read-error detail once, using the shared error body beside Thematic baskets in the same error state. The footer retains the active error; partially readable rows remain visible. A normal follow-up restores the table's required healthy empty-state fallback, which is superseded by the provided status/emptyContent in both renderers. All five local typecheck targets and 80 focused tests passed on this source.

Fresh desktop captures: `final-body/screenshots/head/`. The 72 before/after sheets comprise 24 pairs each against retained actual main0568 (`main/`), prior6578 (`correction/`) and40b (`fallback/`). All 36 unobstructed neighboring-pane regions match exactly, as do all healthy captures. Every pane image matches40b. Three form pairs differ solely by a 14-pixel blinking Symbol caret; one prior6578 form comparison also has that caret difference. Raw images are preserved, and enlarged caret crops are in `final-body/review/`.

Four fresh final-head terminal scenarios at120×34 produce eight form/pane images, all byte-identical to40b. Eight sheets in `final-body/screenshots/terminal/` pair those new images with eight retained actual0568 images. The baseline falsely succeeds and overwrites corrupt saved alerts; the final head refuses the save and preserves the exact raw bytes. Baseline success toasts obscure the neighboring pane footer, so only the four unobstructed content regions above y=720 are claimed pixel-identical.

All 24 final desktop images, eight terminal sheets and caret crops were manually reviewed. Captures recorded no external/native requests or runtime warnings. All owned tmux sessions, profiles, browser/server handles, temporary source entries and build scratch were removed. These registered renderer-component fixtures do not exercise the complete native desktop shell or RPC transport.

See `final-body/review-summary.md`, `independent-screenshot-review.json`, `source-provenance.json`, `terminal-audit.json`, `required-title-provenance.json` and `final-regression-provenance.json` for details. The fresh final-head CLI replay and six CI workflows are tracked separately on PR#2072; these focused images do not replace the broad UI benchmark. Earlier images and the failed40b typecheck retain their actual source labels as superseded evidence.
