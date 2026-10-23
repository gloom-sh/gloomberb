# BR browser comparison

Real browser captures after typing `BR` and pressing Enter once, from the UI benchmark's empty layout at 1280 by 800. Both builds used the same local offline replay and clock.

- `main-br-enter.png`: main at the benchmark base, `2e3ad49ace3ee354bbdb155da3d0118619b19b49`. A floating Broadridge security pane opens on NYSE.
- `head-br-enter.png`: application code at `141b8be519f3000fadd007538ef83f4771812126`. The Security Description listing chooser opens, with Broadridge on NYSE highlighted. A second Enter opens that security pane.

The replay serves suggestion search with limit 30, but the standard resolver's search with limit 10 is absent and returns 503. The existing unresolved/busy handling opens the chooser.
