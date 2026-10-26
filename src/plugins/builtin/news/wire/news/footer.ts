import { useMemo } from "react";
import type { PaneFooterSegment } from "../../../../../components";
import { delayedFooterSegment } from "../../../../../components/layout/pane/footer/model";
import type { NewsAccess } from "../../../../../news/types";
import { t, tf } from "../../../../../i18n";
import { useAppLanguage } from "../../../../../i18n/react";
import { useCloudAccessFooter } from "../../../shared/cloud-upgrade";
import { NEWEST_STORY } from "../../../shared/report-freshness";
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
  /** Which news the list on screen is, from the service's answer; null or absent when it did not say. */
  feedAccess?: NewsAccess | null;
}

/**
 * Whether the stories are the live wire: what the service's answer said when
 * it said; otherwise held back for an account without real-time news, and
 * not said at all for one with it. The plan never claims the live wire.
 */
function newsFeedRealtime(feedAccess: NewsAccess | null | undefined, hasProAccess: boolean): boolean | null {
  if (feedAccess) return feedAccess === "realtime";
  return hasProAccess ? null : false;
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
  const { access, hint: upgradeHint, segment } = useCloudAccessFooter({
    delayLabel,
    focused,
    // A feed the service answered live has nothing to upgrade.
    degraded: feedAccess !== "realtime",
    segmentId: "news-access",
    placement: "news-footer",
    shortcutScope: `${registrationId}:news-upgrade`,
  });
  const realtime = newsFeedRealtime(feedAccess, access.hasProAccess);

  // A report or capture of the pane says how far its stories are held back, as the footer does, and dates the
  // list by its newest story, named so it is not read as the time now.
  useRemoteUiNode({
    role: "report-freshness",
    label: "News freshness",
    getMetadata: () => (realtime === true
      ? { status: "live", asOfLabel: NEWEST_STORY }
      : realtime === false
        ? { status: "delayed", delayMinutes: CLOUD_NEWS_DELAY_HOURS * 60, asOfLabel: NEWEST_STORY }
        : { status: "not-a-feed", basis: "published stories", asOfLabel: NEWEST_STORY }),
  });

  const accessInfo = useMemo<PaneFooterSegment[]>(() => {
    // A trial keeps its days-left segment, which manages the plan.
    if (realtime === true && !access.isTrialActive) {
      return [{ id: "news-access", parts: [{ text: t("real-time news"), tone: "positive" }] }];
    }
    // Held back although the account has Pro (a read that went out before its session): say so, without a pitch.
    if (feedAccess === "delayed" && access.hasProAccess) {
      return [delayedFooterSegment({ id: "news-access", detail: tf("{delay} delayed", { delay: delayLabel }), delay: delayLabel })];
    }
    return segment ? [segment] : [];
  }, [access.hasProAccess, access.isTrialActive, delayLabel, feedAccess, language, realtime, segment]);
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
