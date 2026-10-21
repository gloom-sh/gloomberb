# GLO-1165 removal warning correction

Submitted head: `c1810dd09dea69bdb2f00de498f62067528a6ec2`. PR https://github.com/gloom-sh/gloomberb/pull/2073.

- `main/`: 12 before/after sheets, frozen main0568f95db049dccad254c672c2c8d284bbe6a586 → final c181. Original retained baseline captures are reused for unchanged healthy/native/view scenarios. Eight failure pairs change; four healthy pairs and every neighboring Themes crop are pixel-identical.
- `correction/`: 16 fresh before/after sheets, previous accepted41043a6c496735a809fc01bf5117a521eddc80bf → c181. Twelve failure pairs change exclusively within the existing footer; four healthy pairs and all16 neighboring Themes crops are pixel-identical. Includes thrown file-removal failure.
- `head/`: final raw PNGs and DOM text/Range/clipping metadata. All12 failure warnings fit at640/1280 in white/paper. At640 both full warnings fit beside More in232px: stop216.046875px; removal230.4375px.
- `root-visual-review.json`: independent root visual inspection of two representative640px frames.
- `terminal/`: actual OpenTUI pane and confirmation in four owned tmux sessions; both warnings in white/paper and recovered stop retry. Sessions and profiles removed.

Fresh focused lifecycle tests:13pass/0fail. Exact three final tests transplanted onto frozen main:8pass/5fail, with known secondary unhandled-removal teardown error. Raw evidence retained. No real external requests.

These focused sheets cover failure states that the broader offline benchmark does not trigger. Full benchmark and CI audit are linked in the PR after completion.
