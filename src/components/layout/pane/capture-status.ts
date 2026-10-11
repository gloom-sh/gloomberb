import { createContext, useContext } from "react";

/**
 * True inside a `gloomberb shot` whose status line dates the pane's data: the
 * pane's own `as of` text (a query bar's `asOf`) is left out, so the date is
 * said once. False everywhere else.
 */
export const CaptureDatesDataContext = createContext(false);

export function useCaptureDatesData(): boolean {
  return useContext(CaptureDatesDataContext);
}
