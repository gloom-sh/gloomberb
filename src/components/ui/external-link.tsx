import { Box, Text } from "../../ui";
import { TextAttributes } from "../../ui";
import { useThemeColors } from "../../theme/theme-context";
import { safeExternalUrl } from "../../utils/external-url";
import { linkContextMenuItems, useContextMenu, useRendererHost, useUiCapabilities } from "../../ui";

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
