# GLO-1165 plugin removal evidence

Baseline: 0568f95db049dccad254c672c2c8d284bbe6a586.
Head: 41043a6c496735a809fc01bf5117a521eddc80bf.

Each comparison sheet places baseline above head, with the actual Themes pane as a neighbour in the same state. Synthetic installed plugin and failed stop implementations drive the actual Plugins pane and shared controls. No production or credentialed requests. The lifecycle tests separately cover the real native registry and view host.

Twelve pairs: healthy removal, native-stop failure, view-stop failure in white/paper at 640/1280px. Eight failure pairs change as intended; all four healthy pairs are pixel-identical. All twelve neighbouring pane crops are pixel-identical. Full results in comparison.json.

Terminal captures show the actual OpenTUI Plugins pane, footer and confirmation dialog beside Themes in tmux. Each theme has initial (1), refused removal (2), recovered transient stop and successful removal (3). Both owned tmux sessions were removed. No React/runtime warning signatures or network requests; the short smoke does not establish long-term leak absence.
