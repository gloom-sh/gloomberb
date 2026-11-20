import { useCallback, useEffect, useMemo, useRef } from "react";
import { matchesNavigationKey, useKeybindings } from "../app/keybindings";
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
import { markPaneNoticesSeen, usePaneNoticesSeen } from "./pane-notice-seen";
import { withoutCryptoVenueCode } from "../utils/crypto-pair";
import { readableStatus } from "../utils/reason-codes";

export interface UsePaneNoticeFooterOptions {
  registrationId: string;
  notices: readonly string[];
  focused: boolean;
  title?: string;
  enabled?: boolean;
  /**
   * The notes a picture of the pane prints as its note line, every notice
   * otherwise: for a pane whose footer already says some of them in other
   * words (what its numbers leave out, as segments a capture keeps), the
   * rest. Empty prints none; the dialog always lists every notice.
   */
  captureNotes?: readonly string[];
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
  const bindings = useKeybindings();
  useDialogKeyboard((event) => {
    const key = event.name ?? event.key;
    const plain = !event.ctrl && !event.alt && !event.meta && !event.super;
    if (plain && (key === "enter" || key === "return" || key === "escape")) {
      event.preventDefault();
      event.stopPropagation();
      dismiss();
      return;
    }
    const scroll = scrollRef.current;
    if (!scroll) return;
    const down = matchesNavigationKey(bindings, "down", event, { defaultMatches: plain && key === "down" });
    const up = matchesNavigationKey(bindings, "up", event, { defaultMatches: plain && key === "up" });
    const delta = down ? 1 : up ? -1 : plain && key === "pagedown" ? height : plain && key === "pageup" ? -height : null;
    if (delta === null && !(plain && (key === "home" || key === "end"))) return;
    event.preventDefault();
    event.stopPropagation();
    scroll.scrollTo(delta !== null ? Math.max(0, scroll.scrollTop + delta) : key === "home" ? 0 : scroll.scrollHeight);
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

/**
 * Active data limitations live in one footer disclosure, never a standing body banner.
 * The ⚠ is warning yellow until the user has opened these warnings, then muted;
 * a new or changed warning is yellow again. See `./pane-notice-seen.ts`.
 */
export function usePaneNoticeFooter({
  registrationId,
  notices,
  focused,
  title: rawTitle = "Data warnings",
  enabled = true,
  captureNotes,
}: UsePaneNoticeFooterOptions): void {
  const dialog = useDialog();
  const dialogOpen = useDialogState((state) => state.isOpen);
  const scopeActive = usePaneFooterScopeActive();
  const title = t(rawTitle);
  // Said as a reader takes it: a coin's pair without the internal code of the venue it is charted on, and a
  // source's reason code (UPSTREAM_ERROR) as what happened.
  const noticeKey = JSON.stringify([...new Set(notices.map((notice) => readableStatus(withoutCryptoVenueCode(notice.trim()))).filter(Boolean))]);
  const currentNotices = useMemo<readonly string[]>(() => JSON.parse(noticeKey), [noticeKey]);
  const capturedKey = captureNotes ? JSON.stringify(captureNotes.map((note) => readableStatus(note.trim())).filter(Boolean)) : null;
  const capturedNotes = useMemo<readonly string[] | null>(() => (capturedKey ? JSON.parse(capturedKey) : null), [capturedKey]);
  const active = enabled && scopeActive && currentNotices.length > 0;
  const seen = usePaneNoticesSeen(currentNotices);
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
    markPaneNoticesSeen(currentNotices);
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
      notes: capturedNotes ?? currentNotices,
      label: title,
      title: `${title} (!)`,
      shortcut: "!",
      parts: [{ text: "⚠", tone: seen ? "muted" : "warning" }],
      onPress: open,
    }],
  } : null, [active, open, seen, title, currentNotices, capturedNotes]);
}
