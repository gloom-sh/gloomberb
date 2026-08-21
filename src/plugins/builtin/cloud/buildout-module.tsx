import { BuildoutPane } from "../buildout/pane";
import type { PluginModule } from "../plugin-module";

export const buildoutModule: PluginModule = {
  panes: [{
    id: "buildout",
    name: "TheBuildout",
    icon: "T",
    component: BuildoutPane,
    defaultPosition: "right",
    defaultMode: "floating",
    defaultFloatingSize: { width: 110, height: 34 },
  }],
  paneTemplates: [{
    id: "buildout-pane",
    paneId: "buildout",
    label: "TheBuildout",
    description: "Open TheBuildout infrastructure intelligence.",
    keywords: ["tbo", "buildout", "thebuildout", "infrastructure", "sites", "intel"],
    shortcut: { prefix: "TBO" },
    createInstance: () => ({ placement: "floating" }),
  }],
};
