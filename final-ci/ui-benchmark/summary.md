<!-- ui-benchmark -->
### UI blast radius: 1 of 530 views changed

Base `0568f95db`, head `c1810dd09`: every function, bundled and registry plugin pane and shell view, Chromium, white theme, 640 and 1280px, pane bodies compared (the window's top and bottom 42px left out). Data: the week's kept snapshot, offline on both sides.

| View | 640px | 1280px |
|---|---:|---:|
| GP--root | 0.24% | 0.12% |

Left out of the count, unsteady (two pictures of the same code differ): OVDV--root, PERP--tab-history.

Sheets (before, after and the difference of every view that moved, and per family): the `ui-benchmark` artifact of [this run](https://github.com/gloom-sh/gloomberb/actions/runs/39618670567).
