import { createListenerSet } from "../../utils/listeners";

/**
 * Whether a full-window setup card is up: the first-run setup, "Which
 * companies do you follow?" after a sign-up, or any other card drawn with
 * OnboardingModal. They are not dialogs of the dialog stack, so a surface that
 * must not open over one of them (the question after a sign-up) reads this.
 */
let openCards = 0;
const listeners = createListenerSet();

/** Counts a card as up until the returned release is called (once). */
export function holdSetupCard(): () => void {
  openCards += 1;
  listeners.notify();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    openCards -= 1;
    listeners.notify();
  };
}

export function setupCardOpen(): boolean {
  return openCards > 0;
}

export const subscribeSetupCards = listeners.subscribe;
