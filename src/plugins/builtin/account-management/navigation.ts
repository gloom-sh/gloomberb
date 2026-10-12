import { createPaneRequestChannel } from "../shared/pane-request";

export type AccountManagementTab = "profile" | "emails" | "calendar" | "pro" | "teams" | "agents" | "advanced";

const tabRequests = createPaneRequestChannel<AccountManagementTab>();

/** The tab the account pane should show: an open pane switches, the next one to open starts there. */
export const requestAccountManagementTab = tabRequests.request;
export const subscribeRequestedAccountManagementTab = tabRequests.subscribe;
