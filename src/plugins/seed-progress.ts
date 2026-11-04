import type { AppConfig, PluginSeedFailure } from "../types/config";
import { logFailure } from "../utils/log-failure";

/**
 * The plugins this launch is installing because they moved out of Gloom into
 * their own repositories (extracted-plugins.ts), as the app sees them.
 *
 * The installs run after the first frame, in the process that can run git and
 * bun: the terminal's own, or the desktop's Bun process, which passes each
 * change to its main window. The app brings every plugin into the session as
 * it lands, then records the outcome in its config and says what could not be
 * installed. Until then the panes they add stay in the layout, hidden like
 * any pane whose plugin is not there, and appear in place once it is.
 */

export interface PluginSeedNotice {
  body: string;
  type: "error" | "info";
}

export type PluginSeedRecord = Pick<AppConfig, "seededPlugins" | "pluginSeedFailure">;

export interface PluginSeedEntry {
  id: string;
  name: string;
  state: "installing" | "installed" | "failed";
  /** Its folder once installed, and the sibling plugins it brought along. */
  directory?: string;
  peers?: string[];
}

export interface PluginSeedProgress {
  /** Grows with every change, so a snapshot that arrives late is ignored. */
  seq: number;
  plugins: PluginSeedEntry[];
  /** Set once every install is over: what the config records, and what to tell the user. */
  outcome?: { record: PluginSeedRecord; notice: PluginSeedNotice | null };
}

/** Whether two recorded seed failures are the same: the same plugins, for the same reason. */
export function samePluginSeedFailure(a: PluginSeedFailure | undefined, b: PluginSeedFailure | undefined): boolean {
  return a?.gitMissing === b?.gitMissing && (a?.plugins ?? []).join() === (b?.plugins ?? []).join();
}

let progress: PluginSeedProgress | null = null;
const listeners = new Set<() => void>();

/**
 * Adopts a snapshot unless an equal or newer one is already here. A listener
 * that throws (the desktop's send to a window that is closing) is logged and
 * the others still hear: the install it reports has happened either way.
 */
export function publishPluginSeedProgress(next: PluginSeedProgress): void {
  if (progress && next.seq <= progress.seq) return;
  progress = next;
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      logFailure("plugin-seed", "A plugin restore progress listener failed")(error);
    }
  }
}

export function getPluginSeedProgress(): PluginSeedProgress | null {
  return progress;
}

export function subscribePluginSeed(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
