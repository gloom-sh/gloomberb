/**
 * Test helpers for external plugin repositories (`gloomberb/test-support`).
 *
 * Plugins live in their own repos and run their own `bun test`, so the fakes and
 * render harness they need have to ship with the host rather than being copied
 * per plugin and drifting.
 *
 * The harness is OpenTUI-backed. That is the host's business, not the plugin's:
 * a plugin importing a renderer package directly stops working on the other
 * renderers, which is exactly what going through this module avoids.
 */

export { MemoryPluginPersistence } from "../test-support/plugin-persistence";

// A doubled plugin runtime, so a pane test can exercise the state a pane keeps
// across renders without standing up the whole app.
export {
  createConfigBackedTestPluginRuntime,
  createStatefulTestPluginRuntime,
  createTestPluginRuntime,
} from "../test-support/plugin-runtime";
export { PluginRenderProvider } from "../plugins/runtime";

export {
  createOpenTuiTestRoot,
  emitKeypress,
  settleFrame,
  TestDialogProvider,
  testRender,
} from "../renderers/opentui/test-utils";
export type { TestKeyEvent } from "../renderers/opentui/test-utils";

export { AppContext, PaneInstanceProvider } from "../state/app/context";
export { appReducer } from "../state/app/context";
export { createInitialState } from "../core/state/app/state";

// The pane chrome the app draws around a plugin pane. A test that asserts on
// footer status has to render it the same way, or it is asserting on a footer
// the user never sees.
export { PaneFooterBar, PaneFooterProvider } from "../components/layout/pane/footer";

// Broker plugins test against the real account cache and persistence rather
// than a hand-rolled double that drifts from how the app actually stores rows.
export { AppPersistence } from "../data/app-persistence";
export * from "../brokers/account-cache";
