import { useMemo } from "react";
import type { PaneFooterSegment } from "../../../../../components";
import { delayedFooterSegment } from "../../../../../components/layout/pane/footer/model";
import type { NewsAccess } from "../../../../../news/types";
import { t, tf } from "../../../../../i18n";
import { useAppLanguage } from "../../../../../i18n/react";
import { useCloudAccessFooter } from "../../../shared/cloud-upgrade";
import { cloudNewsFreshness, cloudPlanRealtimeAccess } from "../../../shared/report-freshness";
import { apiClient } from "../../../../../api-client";
import { CLOUD_NEWS_DELAY_HOURS } from "../../../../../api-client/plan-access";
import { usePaneStatusLinkFooter } from "../../../../../components/layout/pane/status-footer";
import { useRemoteUiNode } from "../../../../../remote/semantic-tree";

interface NewsFooterArticle {
  title?: string | null;
  source?: string | null;
  url?: string | null;
  publishedAt?: Date | null;
}

/** Whether a story was out before the free tier's delay: every plan reads it the same, so no delay sits beside it. */
function publishedBeforeNewsDelay(article: NewsFooterArticle | null | undefined, now = Date.now()): boolean {
  const published = article?.publishedAt?.getTime();
  return published != null && Number.isFinite(published) && now - published >= CLOUD_NEWS_DELAY_HOURS * 3_600_000;
}

interface UseNewsArticleFooterOptions {
  registrationId: string;
  focused: boolean;
  article: NewsFooterArticle | null | undefined;
  info?: PaneFooterSegment[];
  loading?: boolean;
  error?: string | null;
  onPopOut?: () => void;
  /** Which news the list on screen is, from the service's answer; null or absent when it did not say. */
  feedAccess?: NewsAccess | null;
}

/**
 * Whether the stories are the live wire: what the service's answer said when
 * it said; otherwise held back for an account without real-time news, and
 * not said at all for one with it. The plan never claims the live wire.
 */
function newsFeedRealtime(feedAccess: NewsAccess | null): boolean | null {
  if (feedAccess) return feedAccess === "realtime";
  if (!apiClient.isSignedIn() && !apiClient.isDisplayScopePending()) return false;
  return cloudPlanRealtimeAccess(apiClient.getCurrentUser()) === false ? false : null;
}

export function useNewsArticleFooter({
  registrationId,
  focused,
  article,
  info,
  loading = false,
  error,
  onPopOut,
  feedAccess = null,
}: UseNewsArticleFooterOptions) {
  const language = useAppLanguage();
  const delayLabel = tf("{count}h", { count: CLOUD_NEWS_DELAY_HOURS });
  const realtime = newsFeedRealtime(feedAccess);
  const { access, hint: upgradeHint, segment } = useCloudAccessFooter({
    delayLabel,
    focused,
    degraded: realtime === false,
    segmentId: "news-access",
    placement: "news-footer",
    shortcutScope: `${registrationId}:news-upgrade`,
  });
  const storyPastDelay = publishedBeforeNewsDelay(article);

  // A report or capture dates the list by its newest story, named so it is not read as the time now.
  useRemoteUiNode({
    role: "report-freshness",
    label: "News freshness",
    getMetadata: () => ({ ...cloudNewsFreshness(realtime) }),
  });

  const accessInfo = useMemo<PaneFooterSegment[]>(() => {
    // A trial keeps its days-left segment, which manages the plan.
    if (realtime === true && !access.isTrialActive) {
      return [{ id: "news-access", parts: [{ text: t("real-time news"), tone: "positive" }] }];
    }
    // A story open from before the delay was never held back; the list's delay comes back with the list.
    if (storyPastDelay && !access.isTrialActive) return [];
    // Held back although the account has Pro (a read that went out before its session): say so, without a pitch.
    if (feedAccess === "delayed" && access.hasProAccess) {
      return [delayedFooterSegment({ id: "news-access", detail: tf("{delay} delayed", { delay: delayLabel }), delay: delayLabel })];
    }
    return segment ? [segment] : [];
  }, [access.hasProAccess, access.isTrialActive, delayLabel, feedAccess, language, realtime, segment, storyPastDelay]);
  const footerInfo = useMemo(() => [...accessInfo, ...(info ?? [])], [accessInfo, info]);

  // The story's header names its source, so the footer keeps to the link.
  usePaneStatusLinkFooter({
    registrationId,
    focused,
    url: article?.url,
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
