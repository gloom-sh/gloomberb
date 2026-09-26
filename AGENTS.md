Stack: Bun + OpenTUI

Tests:
- Be selective: add or keep a test only when it protects behavior that is easy to break and hard to catch in review.
- Good test targets: parser/math/state complexity, async/cache/persistence behavior, integration boundaries, and regressions with a concrete failure mode that could plausibly return.
- Weak test targets: static metadata, default props, simple pass-through wiring, copied UI text, or behavior that is obvious from reading the implementation.
- Bug-fix tests are not automatically worth keeping. Keep them only when the bug came from non-obvious behavior or a boundary likely to regress.
- Do not keep low-value tests just because they already exist or improve coverage counts.
- When touching a test file, trim nearby low-value tests if the cleanup is clear and low-risk.

Use tmux to test terminal TUI changes (see the `tui-testing` skill). Always kill the tmux session when done.
Pane footers/status bars show changing status such as loading, error, live/delayed, stale, or auth state. Preserve existing pane-specific action shortcuts there instead of duplicating them in body toolbars. Do not add fixed pane labels, row counts, or generic keyboard hints. Never show the data provider (`provider:*`, Gloom Cloud, Yahoo, Alpaca, etc.) anywhere in a pane; say what the data is (real-time, 15m delayed, settlement, as of) instead. See `pane-conventions`.
Recurring methodology, model assumptions, and usage explanations belong in docs, not always-visible pane text or new info buttons. Keep units, source dates, and active data failures in context. Use existing actions instead of adding duplicate toolbars.
Information density matters: never repeat the same information in a pane title/header and again in the body. If a stack/detail title already names the item, start the body with metadata or content.
For Electrobun/desktop-web-only work, do not load the OpenTUI or tui-testing skills unless the change also touches terminal OpenTUI behavior or explicitly needs tmux coverage. The OpenTUI skill is not checked in: if `.agents/skills/opentui` is missing, restore it with `bunx skills experimental_install`.
For desktop/Electrobun/web UI, do not draw GUI primitives with terminal cell characters. Use real DOM/CSS/canvas/SVG primitives for lines, markers, shapes, overlays, and interaction affordances; reserve cell-character drawing for the OpenTUI terminal renderer only.
Add mouse/cursor interactivity for everything interactive.
Never fix chart issues by disabling / turning off the kitty renderer; preserve kitty support and fix the root cause.
Built-in code under `src/` imports the host by relative path (`../../../ui`, `../../../components`, `../../../public/react`, `../../../theme/colors`). The `gloomberb/*` specifiers are the external-plugin API: Bun on Linux resolves them as a package self-reference, so typecheck and tests pass, but the Windows desktop bundle cannot and the Windows verify workflow fails on main.
When adding or changing a pane/plugin, read PLUGINS.md and load the `pane-conventions` skill (`.agents/skills/pane-conventions/SKILL.md`) for where actions, status and warnings go, detail stacks, load-more lists, tabs, forms, density, and the new-pane checklist. Basic UI must use the shared kit: actions, selectable/expandable rows, fields, tabs, lists/tables, headings/sections, labeled values, badges, dividers, and loading/error/empty states. Extend the kit for a missing repeated pattern and migrate its callers; do not create another pane-local implementation. Box/ScrollBox remain layout primitives; raw Text and custom surfaces are appropriate for domain content, charts, and specialized editors. External plugins use the same components through gloomberb/components.
