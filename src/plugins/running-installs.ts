/**
 * The commands of installs nobody waits on (a launch's restore of plugins
 * that moved out of Gloom), which quitting the app stops rather than leave a
 * download running after it. Kept apart from the installer, so the app's way
 * out reaches them without loading it. A process exit stops them as well,
 * but the app cannot count on that event, so it calls this on its way out.
 */
const running = new Set<() => void>();
let stopsOnExit = false;
/** Set on the way out: a command started after that, as the next install begins, stops at once. */
let stopped = false;

export function trackInstallCommand(stop: () => void): () => void {
  if (stopped) {
    stop();
    return () => {};
  }
  if (!stopsOnExit) {
    stopsOnExit = true;
    process.once("exit", stopInstallCommands);
  }
  running.add(stop);
  return () => { running.delete(stop); };
}

/** Stops every one still running, and any started from now on. */
export function stopInstallCommands(): void {
  stopped = true;
  for (const stop of [...running]) stop();
  running.clear();
}
