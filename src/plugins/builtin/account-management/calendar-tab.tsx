import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  confirmDialog,
  EmptyState,
  Notice,
  PaneStatusBody,
  Spinner,
  StatGrid,
  loadingText,
  unavailableText,
  usePaneFooter,
  usePaneNoticeFooter,
  type PaneHint,
  type StatItem,
} from "../../../components";
import { apiClient, type CalendarFeed } from "../../../api-client";
import { ApiRequestError } from "../../../api-client/errors";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";
import { Box, useRendererHost } from "../../../ui";
import { useDialog } from "../../../ui/dialog";
import { formatTimeAgo } from "../../../utils/datetime-format";

type Message = { tone: "info" | "success" | "error"; text: string };

function errorText(error: unknown): string {
  // A server without the endpoint yet answers 404 for the route itself.
  if (error instanceof ApiRequestError && error.status === 404) return t("Calendar links are not available yet.");
  return unavailableText("Calendar link");
}

/**
 * The Calendar tab of the account pane: one private link to subscribe to in
 * Google, Apple or Outlook Calendar. `c` copies it (creating it the first
 * time), `n` replaces it after a confirm. The link is never created on load.
 */
export function CalendarAccountTab({ width, sessionMarker, focused }: { width: number; sessionMarker: string; focused: boolean }) {
  const language = useAppLanguage();
  const renderer = useRendererHost();
  const dialog = useDialog();
  const [feed, setFeed] = useState<CalendarFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [shownUrl, setShownUrl] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const feedRef = useRef(feed);
  feedRef.current = feed;

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await apiClient.getCalendarFeed();
      if (isCurrent()) {
        setFeed(next);
        setNotice(null);
      }
    } catch (error) {
      if (!isCurrent()) return;
      const text = errorText(error);
      if (feedRef.current) {
        setLoadError(null);
        setNotice(text);
      } else setLoadError(text);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, []);

  useEffect(() => {
    let current = true;
    // Another account's link must never linger on screen.
    setFeed(null);
    setShownUrl(null);
    setMessage(null);
    void load(() => current);
    return () => {
      current = false;
    };
  }, [load, sessionMarker]);

  // Clipboard writes can fail (a browser after a network wait) or do nothing
  // (a terminal without OSC 52), and the footer cuts a long link short, so a
  // copied link also shows in the body until the tab closes.
  const copy = useCallback(async (url: string, copied: string) => {
    setShownUrl(url);
    try {
      await renderer.copyText(url);
      setMessage({ tone: "success", text: copied });
    } catch {
      setMessage({ tone: "info", text: t("Copy failed. Select the link below.") });
    }
  }, [renderer]);

  const run = useCallback(async (task: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await task();
    } catch (error) {
      const text = errorText(error);
      setMessage(null);
      if (feedRef.current) setNotice(text);
      else setLoadError(text);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }, []);

  const copyLink = useCallback(() => run(async () => {
    // An existing link is copied straight away, without a request first.
    const current = feed ?? await apiClient.ensureCalendarFeed();
    setFeed(current);
    setLoadError(null);
    await copy(current.url, t("Link copied."));
  }), [copy, feed, run]);

  const regenerateLink = useCallback(async () => {
    if (!feed || busyRef.current) return;
    const confirmed = await confirmDialog(dialog, {
      title: t("Regenerate Link"),
      body: [
        t("Calendars using the current link stop updating."),
        t("Add the new link to keep them current."),
      ],
      confirmLabel: t("Regenerate"),
      confirmVariant: "danger",
    });
    if (!confirmed) return;
    await run(async () => {
      const next = await apiClient.rotateCalendarFeed();
      setFeed(next);
      await copy(next.url, t("New link copied. The old one no longer works."));
    });
  }, [copy, dialog, feed, run]);

  const hints = useMemo<PaneHint[]>(() => {
    if (!feed && (loading || loadError)) return [];
    return [
      { id: "copy", key: "c", label: "opy link", title: t("Copy Calendar Link"), onPress: () => { void copyLink(); }, disabled: busy },
      ...(feed
        ? [{ id: "regenerate", key: "n", label: "ew link", title: t("Regenerate Link"), onPress: () => { void regenerateLink(); }, disabled: busy }]
        : []),
    ];
  }, [busy, copyLink, feed, language, loadError, loading, regenerateLink]);

  usePaneFooter("account-management:calendar", () => ({
    info: [
      ...(busy ? [{ id: "busy", parts: [{ text: t("working"), tone: "muted" as const }] }] : []),
      ...(message && message.tone !== "error" && !busy ? [{
        id: "status",
        parts: [{
          text: message.text,
          tone: message.tone === "success" ? "positive" as const : "muted" as const,
        }],
      }] : []),
    ],
    hints,
  }), [busy, hints, language, message]);
  usePaneNoticeFooter({
    registrationId: "account-management:calendar-notices",
    focused,
    notices: notice ? [notice] : [],
  });

  const stats = useMemo<StatItem[]>(() => feed ? [
    { id: "link", label: "Link", value: t("Active"), tone: "positive", detail: t("updates on its own") },
    {
      id: "read",
      label: "Last read",
      value: feed.lastFetchedAt ? formatTimeAgo(feed.lastFetchedAt) : t("Not yet"),
      detail: feed.lastFetchedAt ? undefined : t("add it in a calendar app"),
      tone: feed.lastFetchedAt ? undefined : "muted",
    },
  ] : [], [feed, language]);

  if (loading && !feed) return <Spinner label={loadingText(t("calendar link"))} />;

  if (loadError && !feed) {
    return (
      <PaneStatusBody
        error={loadError}
        errorTitle={loadError}
        retry={{ onRetry: () => load(), pending: loading }}
      />
    );
  }

  if (!feed) {
    return (
      <EmptyState
        title={t("No calendar link yet.")}
        hint={t("Updates on its own.")}
        actions={(
          <Button
            label={busy ? t("Creating...") : t("Copy Calendar Link")}
            variant="primary"
            onPress={() => { void copyLink(); }}
            disabled={busy}
          />
        )}
      />
    );
  }

  return (
    <Box flexDirection="column" width={width} gap={1}>
      <StatGrid items={stats} width={width} />
      {shownUrl ? <Box data-gloom-selectable="true"><Notice tone="muted">{shownUrl}</Notice></Box> : null}
    </Box>
  );
}
