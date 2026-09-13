import type { ReactNode } from "react";
import { Box } from "../../../ui";
import { tokens } from "../../../theme/colors";

export function getPaneWindowAttributes({
  enabled = true,
  role,
  paneId,
  floating,
  focused,
  windowModeSelected,
  showBorderColor = false,
}: {
  enabled?: boolean;
  role: string;
  paneId?: string;
  floating?: boolean;
  focused: boolean;
  windowModeSelected?: boolean;
  showBorderColor?: boolean;
}): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    "data-gloom-role": role,
  };
  if (paneId) attributes["data-gloom-pane-id"] = paneId;
  if (!enabled) return attributes;

  attributes["data-focused"] = focused ? "true" : "false";
  // The stylesheet keys its projections on these rather than on the style id,
  // so a new style that reuses a focus or header recipe gets the CSS for free.
  attributes["data-focus-mode"] = tokens.pane.chrome.focusMode;
  attributes["data-header-mode"] = tokens.pane.chrome.headerMode;
  attributes["data-surface"] = tokens.pane.chrome.surface;
  if (floating != null) attributes["data-floating"] = floating ? "true" : "false";
  if (windowModeSelected != null) {
    attributes["data-window-mode-selected"] = windowModeSelected ? "true" : "false";
  }
  if (showBorderColor) {
    const { border } = tokens.pane;
    attributes.style = {
      "--pane-border-color": windowModeSelected
        ? border.selected
        : focused ? border.focused : border.idle,
    };
  }
  return attributes;
}

export function PaneBodyFrame({
  layoutProps,
  backgroundColor,
  sideRules,
  children,
}: {
  layoutProps: Record<string, unknown>;
  backgroundColor: string;
  /**
   * Terminal only. A framed style closes the box with a rule down each side,
   * drawn in the outer columns the body already keeps clear of content, so
   * the content width is the same whether the sides are drawn or not.
   */
  sideRules?: { color: string; borderStyle: "single" | "double" | "rounded" | "heavy" } | null;
  children: ReactNode;
}) {
  const { paddingX: _paddingX, ...framedLayoutProps } = layoutProps;
  const frameProps = sideRules
    ? {
      ...framedLayoutProps,
      border: ["left", "right"] as Array<"left" | "right">,
      borderStyle: sideRules.borderStyle,
      borderColor: sideRules.color,
    }
    : layoutProps;
  return (
    <Box {...frameProps} overflow="hidden" backgroundColor={backgroundColor} data-gloom-role="pane-body">
      {children}
    </Box>
  );
}
