import type { PaneTemplatePublicShareDef } from "../../../types/plugin";

/** Shares a public pane whose default template needs no user-owned input. */
export function createPublicPaneShare(defaultTitle: string): PaneTemplatePublicShareDef {
  return {
    serialize: ({ pane }) => ({ title: pane.title?.trim() || defaultTitle, data: {} }),
    restore: (data) => Object.keys(data).length === 0 ? {} : null,
  };
}
