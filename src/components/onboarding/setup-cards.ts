/**
 * Whether a full-window setup card is up: the first-run setup, "Which
 * companies do you follow?" after a sign-up, or any other card drawn with
 * OnboardingModal. They are not dialogs of the dialog stack, so a surface that
 * must not open over one of them (the question after a sign-up) reads this.
 */
let openCards = 0;
const listeners = new Set<() => void>();

function changed() {
  for (const listener of listeners) listener();
}

/** Counts a card as up until the returned release is called (once). */
export function holdSetupCard(): () => void {
  openCards += 1;
  changed();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCards -= 1;
    changed();
  };
}

export function setupCardOpen(): boolean {
  return openCards > 0;
}

export function subscribeSetupCards(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
