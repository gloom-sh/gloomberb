Stack: Bun + OpenTUI

Tests:
- Be selective: add or keep a test only when it protects behavior that is easy to break and hard to catch in review.
- Good test targets: parser/math/state complexity, async/cache/persistence behavior, integration boundaries, and regressions with a concrete failure mode that could plausibly return.
- Weak test targets: static metadata, default props, simple pass-through wiring, copied UI text, or behavior that is obvious from reading the implementation.
- Bug-fix tests are not automatically worth keeping. Keep them only when the bug came from non-obvious behavior or a boundary likely to regress.
- Do not keep low-value tests just because they already exist or improve coverage counts.
- When touching a test file, trim nearby low-value tests if the cleanup is clear and low-risk.

Use tmux to test terminal TUI changes (see the `tui-testing` skill). Always kill the tmux session when done.
Pane footers/status bars should only show status that can change, such as loading, error, live/delayed, stale, or auth state. Do not use them for fixed pane labels, row counts, or generic keyboard hints.
Information density matters: never repeat the same information in a pane title/header and again in the body. If a stack/detail title already names the item, start the body with metadata or content.
For Electrobun/desktop-web-only work, do not load the OpenTUI or tui-testing skills unless the change also touches terminal OpenTUI behavior or explicitly needs tmux coverage.
For desktop/Electrobun/web UI, do not draw GUI primitives with terminal cell characters. Use real DOM/CSS/canvas/SVG primitives for lines, markers, shapes, overlays, and interaction affordances; reserve cell-character drawing for the OpenTUI terminal renderer only.
Add mouse/cursor interactivity for everything interactive.
Never fix chart issues by disabling / turning off the kitty renderer; preserve kitty support and fix the root cause.
When adding or changing a pane/plugin, read PLUGINS.md. Basic UI must use the shared kit: actions, selectable/expandable rows, fields, tabs, lists/tables, headings/sections, labeled values, badges, dividers, and loading/error/empty states. Extend the kit for a missing repeated pattern and migrate its callers; do not create another pane-local implementation. Box/ScrollBox remain layout primitives; raw Text and custom surfaces are appropriate for domain content, charts, and specialized editors. External plugins use the same components through gloomberb/components.
