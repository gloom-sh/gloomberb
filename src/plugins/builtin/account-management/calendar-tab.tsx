import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Button,
  confirmDialog,
  EmptyState,
  Notice,
  Spinner,
  StatGrid,
  loadingText,
  usePaneFooter,
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

function errorText(error: unknown, fallback: string): string {
  // A server without the endpoint yet answers 404 for the route itself.
  if (error instanceof ApiRequestError && error.status === 404) return t("Calendar links are not available yet.");
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * The Calendar tab of the account pane: one private link to subscribe to in
 * Google, Apple or Outlook Calendar. `c` copies it (creating it the first
 * time), `n` replaces it after a confirm. The link is never created on load.
 */
export function CalendarAccountTab({ width, sessionMarker }: { width: number; sessionMarker: string }) {
  const language = useAppLanguage();
  const renderer = useRendererHost();
  const dialog = useDialog();
  const [feed, setFeed] = useState<CalendarFeed | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  const [shownUrl, setShownUrl] = useState<string | null>(null);
  const busyRef = useRef(false);

  const load = useCallback(async (isCurrent: () => boolean = () => true) => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await apiClient.getCalendarFeed();
      if (isCurrent()) setFeed(next);
    } catch (error) {
      if (isCurrent()) setLoadError(errorText(error, t("Failed to load the calendar link.")));
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

  const run = useCallback(async (task: () => Promise<void>, failure: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      await task();
    } catch (error) {
      setMessage({ tone: "error", text: errorText(error, failure) });
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
  }, t("Failed to create the calendar link.")), [copy, feed, run]);

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
    }, t("Failed to regenerate the calendar link."));
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
      ...(message && !busy ? [{
        id: "status",
        parts: [{
          text: message.text,
          tone: message.tone === "error" ? "negative" as const : message.tone === "success" ? "positive" as const : "muted" as const,
        }],
      }] : []),
    ],
    hints,
  }), [busy, hints, language, message]);

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
      <EmptyState
        status="error"
        title={loadError}
        actions={<Button label={t("Retry")} onPress={() => { void load(); }} />}
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
      {shownUrl ? <Notice tone="muted">{shownUrl}</Notice> : null}
    </Box>
  );
}
