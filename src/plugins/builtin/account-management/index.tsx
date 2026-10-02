import type { PluginModule } from "../plugin-module";
import { AccountManagementPane } from "./pane";

export const accountManagementModule: PluginModule = {
  panes: [{
    id: "account-management",
    name: "ACM",
    icon: "A",
    component: AccountManagementPane,
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
