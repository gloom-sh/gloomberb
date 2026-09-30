import { createContext, useContext } from "react";

/** Selects a research tab and says whether this pane shows it for the ticker. */
export type OpenResearchTab = (tabId: string) => boolean;

const ResearchTabNavigationContext = createContext<OpenResearchTab | null>(null);

/** `null` while the pane is locked to one tab. */
export const ResearchTabNavigationProvider = ResearchTabNavigationContext.Provider;

/** Null outside the research pane, or while it has no tab strip to move. */
export function useOpenResearchTab(): OpenResearchTab | null {
  return useContext(ResearchTabNavigationContext);
}
