import type { GloomPlugin, PaneTemplateContext, PaneTemplateCreateOptions, PaneTemplateInstanceConfig } from "../../../types/plugin";
import { commandRequestParams } from "../shared/command-tab";
import { ipoCalendarCache } from "./client";
import { ipoCalendarHeadless } from "./headless";
import { IPO_CALENDAR_PANE_ID } from "./model";

/**
 * `IPO japan` opens the calendar on that search, and so does a later `IPO europe`: one pane, the open one
 * (the focused one when several are), with the search stamped on so asking for the same one again applies it
 * too. Bare `IPO` names nothing and leaves the pane as it is.
 */
function ipoCalendarInstance(
  context: PaneTemplateContext,
  options?: PaneTemplateCreateOptions,
): PaneTemplateInstanceConfig {
  const open = context.layout.instances.filter((instance) => instance.paneId === IPO_CALENDAR_PANE_ID);
  const pane = open.find((instance) => instance.instanceId === context.focusedPaneId) ?? open[0];
  const search = options?.arg?.trim();
  return {
    instanceId: pane?.instanceId ?? IPO_CALENDAR_PANE_ID,
    placement: "floating",
    ...(search ? { params: commandRequestParams({ search }) } : {}),
  };
}

export const ipoCalendarPlugin: GloomPlugin = {
  id: "ipo-calendar",
  name: "IPO Calendar",
  version: "1.0.0",
  description: "Upcoming and recent IPOs worldwide",
  toggleable: true,

  setup(ctx) {
    ipoCalendarCache.attach(ctx.persistence);
  },

  dispose() {
    ipoCalendarCache.reset();
  },

  panes: [
    {
      id: IPO_CALENDAR_PANE_ID,
      name: "IPO Calendar",
      icon: "I",
      get component(): typeof import("./pane").IpoCalendarPane { const { IpoCalendarPane } = require("./pane"); return IpoCalendarPane; },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 110, height: 28 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    {
      id: "ipo-calendar-pane",
      paneId: IPO_CALENDAR_PANE_ID,
      label: "IPO Calendar",
      description: "Upcoming and recent IPOs in the US, Asia-Pacific and Europe: offer price, deal size and first-day return.",
      keywords: ["ipo", "ipos", "initial", "public", "offering", "new", "listing", "listings", "debut", "flotation", "float"],
      shortcut: { prefix: "IPO", argKind: "text", argOptional: true, argPlaceholder: "company, ticker or market" },
      headless: ipoCalendarHeadless,
      createInstance: ipoCalendarInstance,
    },
  ],
};
