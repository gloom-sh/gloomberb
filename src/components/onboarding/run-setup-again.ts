import { useCallback } from "react";
import { useAppDispatch, useAppStateRef } from "../../state/app/context";
import { saveConfigImmediately } from "../../state/config-save-scheduler";
import type { OnboardingProgress } from "../../types/config";

/**
 * Settings' Run Setup Again: setup from its first step, on what the user has.
 * The holdings are the portfolio's own, and the desks setup made start
 * ticked; finishing rebuilds setup's layouts in place and leaves the user's
 * alone. `open` shows the wizard once the progress is saved; without it
 * (a host that cannot run setup) there is nothing to run.
 */
export function useRunSetupAgain(open: (() => void) | undefined): (() => Promise<void>) | undefined {
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const run = useCallback(async () => {
    if (!open) return;
    const progress: OnboardingProgress = { version: 1, stage: "portfolio", rerun: true };
    await saveConfigImmediately({ ...stateRef.current.config, onboardingComplete: false, onboardingProgress: progress });
    dispatch({ type: "SET_ONBOARDING_STATE", complete: false, progress });
    open();
  }, [dispatch, open, stateRef]);
  return open ? run : undefined;
}
