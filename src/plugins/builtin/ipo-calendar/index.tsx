import type { GloomPlugin } from "../../../types/plugin";
import { ipoCalendarCache } from "./client";
import { ipoCalendarHeadless } from "./headless";
import { IPO_CALENDAR_PANE_ID } from "./model";
import { IpoCalendarPane } from "./pane";

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
      component: IpoCalendarPane,
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
      createInstance: (_context, options) => {
        const search = options?.arg?.trim();
        return { placement: "floating", ...(search ? { params: { search } } : {}) };
      },
    },
  ],
};
