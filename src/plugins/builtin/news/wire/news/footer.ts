import { useCallback, useMemo } from "react";
import type { PaneFooterSegment } from "../../../../../components";
import { useShortcut } from "../../../../../react/input";
import { useRendererHost } from "../../../../../ui";
import { apiClient } from "../../../../../api-client";
import { usePaneStatusLinkFooter } from "../../../shared/pane-footer";
import { CLOUD_UPGRADE_URL } from "../../../shared/cloud-upgrade";

interface NewsFooterArticle {
  source?: string | null;
  url?: string | null;
}

interface UseNewsArticleFooterOptions {
  registrationId: string;
  focused: boolean;
  article: NewsFooterArticle | null | undefined;
  info?: PaneFooterSegment[];
  loading?: boolean;
  error?: string | null;
}

function hasRealtimeNewsAccess(): boolean {
  const user = apiClient.getCurrentUser();
  return user?.emailVerified === true && user.plan === "pro";
}

export function useNewsArticleFooter({
  registrationId,
  focused,
  article,
  info,
  loading = false,
  error,
}: UseNewsArticleFooterOptions) {
  const rendererHost = useRendererHost();
  const hasRealtimeAccess = hasRealtimeNewsAccess();
  const showAccessFooter = !article;
  const openUpgrade = useCallback(() => {
    void rendererHost.openExternal(CLOUD_UPGRADE_URL);
  }, [rendererHost]);

  useShortcut((event) => {
    const key = (event.name ?? event.key ?? "").toLowerCase();
    if (!focused || !showAccessFooter || hasRealtimeAccess || key !== "u") return;
    event.stopPropagation();
    event.preventDefault();
    openUpgrade();
  }, { scope: `${registrationId}:news-upgrade` });

  const accessInfo = useMemo<PaneFooterSegment[]>(() => (
    !showAccessFooter
      ? []
      : hasRealtimeAccess
      ? [{
        id: "news-access",
        parts: [{ text: "realtime news", tone: "positive" }],
      }]
      : [{
        id: "news-access",
        onPress: openUpgrade,
        parts: [{ text: "delayed 12h, upgrade for realtime", tone: "warning" }],
      }]
  ), [hasRealtimeAccess, openUpgrade, showAccessFooter]);
  const footerInfo = useMemo(() => [...accessInfo, ...(info ?? [])], [accessInfo, info]);

  usePaneStatusLinkFooter({
    registrationId,
    focused,
    url: article?.url,
    source: article?.source,
    info: footerInfo,
    loading,
    error,
  });
}
