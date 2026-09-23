import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Box, Text } from "../../ui";
import { TextAttributes } from "../../ui";
import { tf } from "../../i18n";
import { useThemeColors } from "../../theme/theme-context";
import { safeExternalUrl } from "../../utils/external-url";
import { linkContextMenuItems, useContextMenu, useRendererHost, useUiCapabilities } from "../../ui";
import type { ContextMenuItem } from "../../types/context-menu";
import { usePaneMenuItems } from "../layout/pane/footer/registration";

export function openUrl(rawUrl: string) {
  const url = safeExternalUrl(rawUrl);
  if (!url) return;

  const browserWindow = (globalThis as { window?: { open?: (url: string, target?: string, features?: string) => void } }).window;
  if (typeof browserWindow?.open === "function") {
    browserWindow.open(url, "_blank", "noopener,noreferrer");
    return;
  }

  if (typeof Bun !== "undefined" && typeof Bun.spawn === "function") {
    const platform = typeof process !== "undefined" ? process.platform : "linux";
    const command = platform === "darwin"
      ? ["open", url]
      : platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
    const child = Bun.spawn(command, { stdio: ["ignore", "ignore", "ignore"] });
    child.unref();
  }
}

interface PaneLinkEntry {
  key: string;
  label: string;
  open: () => void;
}

const PaneLinkMenuContext = createContext<((entry: PaneLinkEntry) => () => void) | null>(null);

/**
 * Lists the links, $TICKER badges and @mentions drawn inside it in the pane
 * menu, once each and in reading order, so the keyboard can open what a
 * pointer clicks. Wrap the body of one item (a detail page, a filing, a
 * post), not a list whose every row carries links.
 */
export function PaneLinkMenu({ children }: { children: ReactNode }) {
  const registrationId = `pane-links:${useId()}`;
  const [entries, setEntries] = useState<readonly PaneLinkEntry[]>([]);
  const register = useCallback((entry: PaneLinkEntry) => {
    setEntries((current) => [...current, entry]);
    return () => setEntries((current) => current.filter((candidate) => candidate !== entry));
  }, []);
  usePaneMenuItems(registrationId, () => {
    const seen = new Set<string>();
    const items: ContextMenuItem[] = [];
    for (const entry of entries) {
      if (seen.has(entry.key)) continue;
      seen.add(entry.key);
      items.push({ id: `pane-link:${entry.key}`, label: entry.label, onSelect: entry.open });
    }
    return items;
  }, [entries]);
  return <PaneLinkMenuContext value={register}>{children}</PaneLinkMenuContext>;
}

/**
 * Puts an inline link or badge in the nearest `PaneLinkMenu`. `key` names what
 * it opens, so the same link twice is listed once; `null` leaves it out.
 */
export function usePaneLinkMenuEntry(key: string | null, label: string, open: () => void): void {
  const register = useContext(PaneLinkMenuContext);
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    if (!register || !key) return;
    return register({ key, label, open: () => openRef.current() });
  }, [key, label, register]);
}

/** A bare URL reads shorter without its scheme. */
function menuLinkLabel(url: string, label: string | undefined): string {
  const text = label?.trim() || url;
  return text === url ? url.replace(/^https?:\/\/(www\.)?/i, "") : text;
}

function handleOpen(
  url: string,
  onOpen: (url: string) => void,
  event?: { preventDefault?: () => void; stopPropagation?: () => void },
) {
  event?.preventDefault?.();
  event?.stopPropagation?.();
  onOpen(url);
}

export function ExternalLinkText(
  { url, label, color, onOpen = openUrl }: {
    url: string;
    label?: string;
    color?: string;
    onOpen?: (url: string) => void;
  },
) {
  const colors = useThemeColors();
  const rendererHost = useRendererHost();
  const { showContextMenu } = useContextMenu();
  const { nativeContextMenu } = useUiCapabilities();
  const resolvedOpen = onOpen === openUrl
    ? (nextUrl: string) => {
      void rendererHost.openExternal(nextUrl);
    }
    : onOpen;
  const openLinkContextMenu = (event: { preventDefault?: () => void; stopPropagation?: () => void }) => showContextMenu(
    { kind: "link", url, label },
    linkContextMenuItems({
      url,
      open: resolvedOpen,
      copy: (text) => { void rendererHost.copyText(text); },
    }),
    event,
  );
  usePaneLinkMenuEntry(`link:${url}`, tf("Open {label}", { label: menuLinkLabel(url, label) }), () => resolvedOpen(url));
  return (
    <Text
      fg={color ?? colors.textBright}
      attributes={TextAttributes.UNDERLINE}
      cursor="pointer"
      role="link"
      tabIndex={0}
      wrapText
      onKeyDown={(event: any) => {
        if (event.key === "Enter" || event.name === "return") handleOpen(url, resolvedOpen, event);
      }}
      data-gloom-context-menu-surface="true"
      onMouseDown={(event: any) => {
        if (event.button === 2) {
          if (nativeContextMenu !== true) {
            void openLinkContextMenu(event);
          }
          return;
        }
        handleOpen(url, resolvedOpen, event);
      }}
      onContextMenu={(event: any) => {
        void openLinkContextMenu(event);
      }}
    >
      {label ?? url}
    </Text>
  );
}

export function ExternalLink(
  { url, label, color, onOpen }: {
    url: string;
    label?: string;
    color?: string;
    onOpen?: (url: string) => void;
  },
) {
  return (
    <Box height={1}>
      <ExternalLinkText url={url} label={label} color={color} onOpen={onOpen} />
    </Box>
  );
}
