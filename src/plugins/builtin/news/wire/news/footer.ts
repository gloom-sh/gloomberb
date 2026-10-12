import { useMemo } from "react";
import type { PaneFooterSegment } from "../../../../../components";
import { t, tf } from "../../../../../i18n";
import { useAppLanguage } from "../../../../../i18n/react";
import { useCloudAccessFooter } from "../../../shared/cloud-upgrade";
import { CLOUD_NEWS_DELAY_HOURS } from "../../../../../api-client/plan-access";
import { usePaneStatusLinkFooter } from "../../../../../components/layout/pane/status-footer";
import { useRemoteUiNode } from "../../../../../remote/semantic-tree";

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
  onPopOut?: () => void;
}

export function useNewsArticleFooter({
  registrationId,
  focused,
  article,
  info,
  loading = false,
  error,
  onPopOut,
}: UseNewsArticleFooterOptions) {
  const language = useAppLanguage();
  const { access, hint: upgradeHint, segment } = useCloudAccessFooter({
    delayLabel: tf("{count}h", { count: CLOUD_NEWS_DELAY_HOURS }),
    focused,
    segmentId: "news-access",
    placement: "news-footer",
    shortcutScope: `${registrationId}:news-upgrade`,
  });

  // A report or capture of the pane says how far its stories are held back, as the footer does.
  useRemoteUiNode({
    role: "report-freshness",
    label: "News freshness",
    getMetadata: () => (access.hasProAccess
      ? { status: "live" }
      : { status: "delayed", delayMinutes: CLOUD_NEWS_DELAY_HOURS * 60 }),
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
      ...(onPopOut ? [{ id: "pop-out", key: "p", label: "op out", onPress: onPopOut }] : []),
    ],
    showOpenHint: true,
    loading,
    error,
  });
}
