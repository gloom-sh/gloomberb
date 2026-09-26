import { useCallback, useMemo } from "react";
import type { PaneFooterSegment } from "../../../../../components";
import { t, tf } from "../../../../../i18n";
import { useAppLanguage } from "../../../../../i18n/react";
import { useShortcut } from "../../../../../react/input";
import { useUiCapabilities } from "../../../../../ui";
import { isPlainKey } from "../../../../../utils/keyboard";
import { useCloudAccessFooter } from "../../../shared/cloud-upgrade";
import { CLOUD_NEWS_DELAY_HOURS } from "../../../../../api-client/plan-access";
import { usePaneStatusLinkFooter } from "../../../../../components/layout/pane/status-footer";
import { usePluginAppActions } from "../../../../runtime";
import { useOptionalPaneInstanceId } from "../../../../../state/app/context";

interface NewsFooterArticle {
  title?: string | null;
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

export function useNewsArticleFooter({
  registrationId,
  focused,
  article,
  info,
  loading = false,
  error,
}: UseNewsArticleFooterOptions) {
  const language = useAppLanguage();
  const { publicSharing } = useUiCapabilities();
  const { sharePane } = usePluginAppActions();
  const paneInstanceId = useOptionalPaneInstanceId();
  // The open story is pane state, so sharing the pane shares the story: the
  // receiver's terminal opens on the same article.
  const shareArticle = useCallback(() => {
    if (!article?.title || !paneInstanceId) return;
    sharePane(paneInstanceId);
  }, [article?.title, paneInstanceId, sharePane]);
  useShortcut((event) => {
    if (!focused || !publicSharing || !article?.title || !isPlainKey(event, "y")) return;
    event.preventDefault();
    event.stopPropagation();
    shareArticle();
  });
  const { access, hint: upgradeHint, segment } = useCloudAccessFooter({
    delayLabel: tf("{count}h", { count: CLOUD_NEWS_DELAY_HOURS }),
    focused,
    segmentId: "news-access",
    shortcutScope: `${registrationId}:news-upgrade`,
  });

  const accessInfo = useMemo<PaneFooterSegment[]>(() => {
    if (access.isPayingPro) {
      return [{ id: "news-access", parts: [{ text: t("real-time news"), tone: "positive" }] }];
    }
    return segment ? [segment] : [];
  }, [access.isPayingPro, language, segment]);
  const footerInfo = useMemo(() => [...accessInfo, ...(info ?? [])], [accessInfo, info]);

  usePaneStatusLinkFooter({
    registrationId,
    focused,
    url: article?.url,
    source: article?.source,
    info: footerInfo,
    // [o]pen is appended after these, so the story's own actions stay rightmost.
    hints: [
      ...(upgradeHint ? [upgradeHint] : []),
      ...(publicSharing && article?.title && paneInstanceId
        ? [{ id: "share", key: "y", label: " share", onPress: shareArticle }]
        : []),
    ],
    showOpenHint: true,
    loading,
    error,
  });
}
