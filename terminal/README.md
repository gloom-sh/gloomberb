# Terminal validation

Baseline: `5ce0c7c5a08ec2eabc738a6789d5e8d9e9c80db4`.

## Header

The actual Header component was captured in OpenTUI at 60, 80, 120 and 160 columns. Each width covers idle, downloading, ready, failed, a passing notice, and a ready update with a Restart callback. Both white (dark) and paper (light) themes were captured. The PNG sheets render the captured cell text, foreground/background colours, and bold attributes.

Only 10 of 48 styled frames change: downloading and ready at 60/80 columns, and failed at 60 columns, once per theme. Idle, notices, Restart, and every 120/160-column frame are byte-identical including colour spans.

The baseline already preserves Help and the market summary, shows a compact failed-update signal at 80 columns, and clips transient notices. The remaining change removes incomplete status parts.

## Other panes

The temporary offline sweep renders every built-in root pane through PaneContent and TestPaneFrame at 80×24 and 160×24, with a fixed clock, controlled network transports, and a seeded Notes file. Before/after character frames are compared as exact strings. All 244 frames from 122 panes are byte-identical, with no render-error cards. Summary and per-frame SHA-256 hashes are in panes-comparison.json and pane-frame-hashes.json. Pane chunks run separately; the perpetual-market root runs alone so earlier requests cannot expire during its capture.

This is root-state coverage with no signed-in account or live data. It does not cover every data-rich state, every tab, or kitty bitmap pixels. External-plugin roots are covered separately in the linked notes below. The all-pane DOM benchmark provides separate broad visual coverage.

## Live terminal smoke

The actual app was launched in a dedicated tmux session and a throwaway profile, then checked at 120, 80, 60 and 160 columns. Ctrl+P opened the command bar and ? opened Help. The captured log contains no React hook, update-depth, or listener-leak warnings. The tmux session, app process, and throwaway profile were removed.

The short live smoke checks startup and navigation, not long-horizon leak absence.

[External plugin root captures and per-pair provenance](plugin-capture-notes.md).
