import type { GloomPlugin } from "../../../types/plugin";
import { createQueryPaneTemplate } from "../shared/ticker-surface";
import { COMMENT_LETTERS_PANE_ID, COMMENT_LETTERS_PLUGIN_ID } from "./types";

export const commentLettersPlugin: GloomPlugin = {
  id: COMMENT_LETTERS_PLUGIN_ID,
  name: "SEC Comment Letters",
  version: "1.0.0",
  description:
    "SEC staff comment letters and company responses (CORRESP and UPLOAD). Search their text or list a company's letters by ticker.",
  toggleable: true,

  // EDGAR full-text search is one JSON endpoint over HTTPS, so every
  // renderer. It sends no CORS headers, which is why the host is declared:
  // the web app proxies it. A company's filing list and a letter's text come
  // from the SEC filings service the SEC pane uses.
  targets: ["cli", "tui", "desktop", "web"],
  hosts: ["efts.sec.gov"],

  panes: [
    {
      id: COMMENT_LETTERS_PANE_ID,
      reportFreshness: { source: "SEC EDGAR", status: "not-a-feed", basis: "comment letters" },
      name: "Comment Letters",
      icon: "L",
      get component(): typeof import("./pane").CommentLettersPane { const { CommentLettersPane } = require("./pane"); return CommentLettersPane; },
      defaultPosition: "right",
      defaultMode: "floating",
      defaultFloatingSize: { width: 100, height: 30 },
      tableExport: true,
    },
  ],

  paneTemplates: [
    createQueryPaneTemplate({
      id: "comment-letters-pane",
      paneId: COMMENT_LETTERS_PANE_ID,
      label: "SEC Comment Letters",
      description:
        "SEC staff comment letters and company responses (CORRESP, UPLOAD): search their text, or a ticker for one company's letters.",
      keywords: ["comment", "letters", "corresp", "upload", "sec", "edgar", "correspondence", "staff", "response"],
      shortcut: "CLTR",
      argPlaceholder: "words or ticker",
      instancePrefix: "comment-letters",
      defaultTitle: "Comment Letters",
      titlePrefix: "Comment Letters",
      includeSymbol: true,
    }),
  ],
};
