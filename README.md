# GLO-1164 alert storage failure evidence

Baseline: `0568f95db049dccad254c672c2c8d284bbe6a586`. Application head: `6578fe82660f7d7d1ecdfab8cec97b6f13f28d3c`.

The actual Add Alert command is submitted through the shared form in the desktop renderer and through a real OpenTUI/tmux session. Malformed JSON and a mixed valid/null list reproduce overwritten saved data before the change; the fixed command retains exact raw data, reports the failure in the shared form, and sends no success notification. Healthy controls behave identically.

Desktop: white/paper, 720/1280, malformed/partial/healthy. Each submitted-form comparison has a corresponding pane comparison after closing the form and dismissing any notification. All12 unobstructed neighboring Themes error-pane regions are pixel-identical; all4 healthy full pane screenshots are identical. Form comparisons intentionally include the dialog backdrop or original false-success toast. The underlying neighboring pane remains in the same saved-data error state.

Terminal: white/paper,120x34, actual Add Alert submitted with Ctrl+S. Form and pane-after-Escape comparisons are retained. No external network requests or runtime exceptions. Four owned tmux sessions and their profiles were removed.

This branch contains focused evidence only. The all-pane UI benchmark is tracked independently on the PR; these captures do not substitute for it. Full raw captures, outcomes, tests and replay provenance are retained in the local GLO-1148 evidence directory.
