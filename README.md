# GLO-1164 refreshed alert error-body evidence

Application head: `40b68e5d0b03132dd7156a90460dc07ec6a07e2c`. Frozen main: `0568f95db049dccad254c672c2c8d284bbe6a586`.

The review correction uses the shared error body: one red “price alerts unavailable.” title and the read-error detail once in the body. The footer retains the active error. Partially readable rows remain visible.

Fresh desktop captures are in `error-body/screenshots/head/`. Comparison sheets against retained actual main captures are in `error-body/screenshots/main/`; the correction-only sheets against actual6578 captures (runtime-equivalent to the previous8b head) are in `error-body/screenshots/correction/`. The unchanged fixture and retained baseline sources are documented in `source-provenance.json`.

There are24 desktop pairs per comparison: malformed/partial/healthy storage, form/pane, white/paper,720/1280. All12 unobstructed neighboring Thematic baskets error-pane crops match; all4 healthy pane controls match. The correction changes only the8 malformed-state images. One partial form pair has an additional14-pixel blinking input caret difference (1×14 at421,234), documented and preserved without normalization. Partial pane controls are identical.

Eight fresh real tmux sessions cover malformed/partial, white/paper, main/final head at120×34. Eight terminal comparison sheets cover submitted forms and panes afterEscape. Main overwrites unreadable storage; the final head preserves the exact raw bytes and reports refusal. Neighboring Thematic baskets stays in the same error state. Its unobstructed content above y=720 matches; the baseline false-success toast covers the footer, so full terminal-neighbor pixel identity is not claimed. Runtime/network and cleanup checks are retained in the terminal audit. All owned sessions and scratch profiles are removed.

The final head passes80 focused tests/342assertions. Its exact unchanged regression files have19pass/11intendedfail on frozen main. The fresh original150-case replay preserves750artifactpairs and298persisted-filepairs, except the declared `alerts-invalid-prices.stdout` read-error wording. An independent audit rehashed all1049savedfiles per side.

These are focused review sheets, not the all-pane benchmark. Exact-head CI and its broad artifact audit are linked separately on PR#2072. Earlier root-level images keep their actual source labels and are retained as historical evidence.
