/**
 * Placing a plugin's pane when its CLI command launches the UI
 * (`gloomberb/layout`).
 *
 * The layout rules live in the host — where a floating pane goes, what counts
 * as already open, which saved workspace the change belongs to — and a plugin
 * that reimplements them drifts from the app the first time those rules change.
 *
 * Compatibility commitment: see the note in `./utils.ts`.
 */
export { openPaneForLaunch, seedPaneLaunchSession } from "../plugins/launch-layout";
export type { PaneLaunchPlacement } from "../plugins/launch-layout";
