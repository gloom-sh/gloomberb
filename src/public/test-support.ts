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

export { TestDialogProvider, testRender } from "../renderers/opentui/test-utils";

export { AppContext, PaneInstanceProvider } from "../state/app/context";
export { createInitialState } from "../core/state/app/state";

// Broker plugins test against the real account cache and persistence rather
// than a hand-rolled double that drifts from how the app actually stores rows.
export { AppPersistence } from "../data/app-persistence";
export * from "../brokers/account-cache";
