/**
 * What the launch's plugin seed could not install, said once the app is up.
 * The seed runs before the app renders (in the terminal's process, or the
 * desktop's Bun process, which hands it to its main window), so it leaves the
 * notice here and the app takes it.
 */
let pending: string | null = null;

export function setPluginSeedNotice(notice: string | null): void {
  pending = notice;
}

/** The notice, once: a second call returns null. */
export function takePluginSeedNotice(): string | null {
  const notice = pending;
  pending = null;
  return notice;
}
