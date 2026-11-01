import type { PluginModule } from "../plugin-module";

export const roadmapModule: PluginModule = {
  panes: [
    {
      id: "roadmap",
      name: "Roadmap",
      icon: "R",
      get component(): typeof import("./pane").RoadmapPane { const { RoadmapPane } = require("./pane"); return RoadmapPane; },
      reportFreshness: { status: "not-a-feed", basis: "curated list", local: true },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
    },
  ],

  paneTemplates: [
    {
      id: "roadmap-pane",
      paneId: "roadmap",
      label: "Roadmap",
      description: "What is being built, what is planned and what shipped. Pro members vote on what comes next.",
      keywords: ["roadmap", "planned", "building", "shipped", "upcoming", "features", "vote", "votes", "request"],
      shortcut: { prefix: "ROADMAP", aliases: ["RMAP"] },
    },
  ],
};
