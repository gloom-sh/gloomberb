import { useCallback, useMemo } from "react";
import type { PaneFooterSegment } from "../../../../../components";
import { t, tf } from "../../../../../i18n";
import { useAppLanguage } from "../../../../../i18n/react";
import { useShortcut } from "../../../../../react/input";
import { useUiCapabilities } from "../../../../../ui";
import { isPlainKey } from "../../../../../utils/keyboard";
import { useCloudAccessFooter } from "../../../shared/cloud-upgrade";
import { CLOUD_NEWS_DELAY_HOURS } from "../../../shared/plan-access";
import { usePaneStatusLinkFooter } from "../../../shared/pane-footer";
import { usePublicShare } from "../../../shared/public-share";

interface NewsFooterArticle {
  title?: string | null;
  summary?: string | null;
  source?: string | null;
  url?: string | null;
  items?: Array<{ title?: string | null; summary?: string | null }>;
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
  const createPublicShare = usePublicShare();
  const shareArticle = useCallback(() => {
    if (!article?.title) return;
    const text = [
      article.summary,
      ...(article.items ?? []).map((item) => item.summary || item.title),
    ].filter((value): value is string => !!value?.trim()).join("\n\n").slice(0, 50_000);
    void createPublicShare({
      kind: "article",
      data: {
        title: article.title,
        text,
        ...(article.url ? { sourceUrl: article.url } : {}),
      },
    });
  }, [article, createPublicShare]);
  useShortcut((event) => {
    if (!focused || !publicSharing || !article?.title || !isPlainKey(event, "y")) return;
    event.preventDefault();
    event.stopPropagation();
    shareArticle();
  });
  const { access, segment } = useCloudAccessFooter({
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
    hints: publicSharing && article?.title
      ? [{ id: "share", key: "y", label: " share", onPress: shareArticle }]
      : undefined,
    showOpenHint: true,
    loading,
    error,
  });
}
