import type { PluginModule } from "../plugin-module";

export const accountManagementModule: PluginModule = {
  panes: [{
    id: "account-management",
    name: "ACM",
    icon: "A",
    personalData: "account",
    get component(): typeof import("./pane").AccountManagementPane { const { AccountManagementPane } = require("./pane"); return AccountManagementPane; },
    reportFreshness: { status: "not-a-feed", basis: "account data", local: true },
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 72, height: 36 },
    portableShare: {
      private: { title: true, params: true, settings: true, state: true },
    },
  }],
  paneTemplates: [{
    id: "account-management-pane",
    paneId: "account-management",
    label: "Account Management",
    description: "Edit your Gloom Cloud profile, password, public portfolio sharing, and calendar feed",
    keywords: ["account", "profile", "cloud", "acm", "password", "settings", "calendar", "ical", "ics"],
    shortcut: { prefix: "ACM" },
    createInstance: () => ({ placement: "floating" }),
  }],
};
