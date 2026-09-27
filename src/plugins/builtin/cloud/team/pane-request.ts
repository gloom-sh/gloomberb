import { createPaneRequestChannel } from "../../shared/pane-request";

export type TeamPaneSection = "members" | "invites" | "channels" | "settings";

/**
 * What the pane should show when it opens or is brought back: a team and a
 * section, or the create form. Commands and chips set it before creating the
 * pane; an open pane consumes it as it arrives, the way ACM tabs work.
 */
export interface TeamPaneView {
  teamId?: string | null;
  section?: TeamPaneSection;
  mode?: "team" | "create";
}

const viewRequests = createPaneRequestChannel<TeamPaneView>();
export const requestTeamPaneView = viewRequests.request;
export const subscribeRequestedTeamPaneView = viewRequests.subscribe;

export const TEAM_PANE_ID = "team";
export const TEAM_PANE_TEMPLATE_ID = "team-pane";

/** Opens (or refocuses) the team pane on the requested view. */
export function openTeamPane(
  createPaneFromTemplate: (templateId: string, options?: { arg?: string }) => void,
  view: TeamPaneView = {},
): void {
  requestTeamPaneView(view);
  createPaneFromTemplate(TEAM_PANE_TEMPLATE_ID);
}
