import { useCallback, useEffect, useMemo, useRef } from "react";
import { t } from "../i18n";
import { useShortcut, useViewport } from "../react/input";
import { Box, ScrollBox, type ScrollBoxRenderable } from "../ui";
import { useDialog, useDialogKeyboard, useDialogState, type AlertContext } from "../ui/dialog";
import { wrapTextLines } from "../utils/text-wrap";
import { usePaneFooter } from "./layout/pane/footer";
import { usePaneFooterScopeActive } from "./layout/pane/footer/registration";
import { Button } from "./ui/button";
import { DialogFrame } from "./ui/frame";
import { Prose } from "./ui/prose";
import { logFailure } from "../utils/log-failure";

export interface UsePaneNoticeFooterOptions {
  registrationId: string;
  notices: readonly string[];
  focused: boolean;
  title?: string;
  enabled?: boolean;
}

function NoticeDialog({ notices, title, dismiss, dialogId }: AlertContext & {
  notices: readonly string[];
  title: string;
}) {
  const viewport = useViewport();
  const width = Math.max(8, Math.min(74, viewport.width - 8));
  const contentHeight = notices.reduce((total, notice) => total + wrapTextLines(notice, Math.max(8, width - 1)).length, 0)
    + Math.max(0, notices.length - 1);
  const height = Math.max(1, Math.min(contentHeight, 18, viewport.height - 10));
  const scrollRef = useRef<ScrollBoxRenderable | null>(null);
  useDialogKeyboard((event) => {
    if (event.ctrl || event.alt || event.meta || event.super) return;
    const key = event.name ?? event.key;
    if (key === "enter" || key === "return" || key === "escape") {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    const scroll = scrollRef.current;
    if (!scroll) return;
    const delta = key === "down" ? 1 : key === "up" ? -1
      : key === "pagedown" ? height : key === "pageup" ? -height : null;
    if (delta === null && key !== "home" && key !== "end") return;
    event.preventDefault();
    event.stopPropagation();
    scroll.scrollTo(key === "home" ? 0 : key === "end" ? scroll.scrollHeight : Math.max(0, scroll.scrollTop + (delta ?? 0)));
  }, { scope: dialogId });

  return (
    <DialogFrame title={title}>
      <Box width={width} flexDirection="column">
        <ScrollBox ref={scrollRef} scrollY height={height} width="100%" aria-label={title}>
          {notices.map((notice, index) => (
            <Box key={notice} flexDirection="column" marginBottom={index < notices.length - 1 ? 1 : 0}>
              <Prose text={notice} width={width - 1} />
            </Box>
          ))}
        </ScrollBox>
        <Box height={1} />
        <Button label="Close" onPress={dismiss} />
      </Box>
    </DialogFrame>
  );
}

/** Active data limitations live in one footer disclosure, never a standing body banner. */
export function usePaneNoticeFooter({
  registrationId,
  notices,
  focused,
  title: rawTitle = "Data warnings",
  enabled = true,
}: UsePaneNoticeFooterOptions): void {
  const dialog = useDialog();
  const dialogOpen = useDialogState((state) => state.isOpen);
  const scopeActive = usePaneFooterScopeActive();
  const title = t(rawTitle);
  const noticeKey = JSON.stringify([...new Set(notices.map((notice) => notice.trim()).filter(Boolean))]);
  const currentNotices = useMemo<readonly string[]>(() => JSON.parse(noticeKey), [noticeKey]);
  const active = enabled && scopeActive && currentNotices.length > 0;
  const openingRef = useRef(false);
  const dismissRef = useRef<(() => void) | undefined>(undefined);

  // A ticker, window or refresh may change while the disclosure is open.
  // Close that snapshot instead of leaving obsolete warnings over the new data.
  useEffect(() => () => {
    dismissRef.current?.();
    dismissRef.current = undefined;
  }, [active, noticeKey, registrationId, title]);

  const open = useCallback(() => {
    if (!active || dialogOpen || openingRef.current) return;
    openingRef.current = true;
    void dialog.alert({
      size: "large",
      closeOnClickOutside: true,
      content: (context: AlertContext) => {
        dismissRef.current = context.dismiss;
        return <NoticeDialog {...context} title={title} notices={currentNotices} />;
      },
    }).catch(logFailure("pane-notice-footer", "Open data warnings dialog failed")).finally(() => {
      openingRef.current = false;
      dismissRef.current = undefined;
    });
  }, [active, currentNotices, dialog, dialogOpen, title]);

  useShortcut((event) => {
    if (event.ctrl || event.alt || event.meta || event.super) return;
    if (event.key !== "!" && event.name !== "!" && event.sequence !== "!") return;
    event.preventDefault();
    event.stopPropagation();
    open();
  }, { enabled: active && focused && !dialogOpen, scope: registrationId });

  usePaneFooter(registrationId, () => active ? {
    order: -10,
    info: [{
      id: "data-warnings",
      icon: "warning",
      label: title,
      title: `${title} (!)`,
      shortcut: "!",
      parts: [{ text: "⚠", tone: "warning" }],
      onPress: open,
    }],
  } : null, [active, open, title]);
}
