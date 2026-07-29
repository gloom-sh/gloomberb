import { useCallback, useMemo } from "react";
import { useShortcut } from "../react/input";
import { useRendererHost } from "../ui";
import {
  usePaneFooter,
  type PaneFooterSegment,
  type PaneHint,
} from "./layout/pane/footer";

interface UseExternalLinkFooterOptions {
  registrationId: string;
  focused: boolean;
  url: string | null | undefined;
  source?: string | null;
  info?: PaneFooterSegment[];
  hints?: PaneHint[];
  label?: string;
  showHint?: boolean;
}

const EMPTY_INFO: PaneFooterSegment[] = [];
const EMPTY_HINTS: PaneHint[] = [];

function normalizeUrl(url: string | null | undefined): string | null {
  const trimmed = url?.trim();
  return trimmed ? trimmed : null;
}

export function useExternalLinkFooter({
  registrationId,
  focused,
  url: rawUrl,
  source,
  info = EMPTY_INFO,
  hints = EMPTY_HINTS,
  label = "link",
  showHint = true,
}: UseExternalLinkFooterOptions) {
  const rendererHost = useRendererHost();
  const url = normalizeUrl(rawUrl);
  const sourceLabel = source?.trim() || null;

  const openUrl = useCallback(() => {
    if (!url) return;
    void rendererHost.openExternal(url);
  }, [rendererHost, url]);

  useShortcut((event) => {
    const key = (event.name ?? event.key ?? "").toLowerCase();
    if (!focused || !url || key !== "o") return;
    event.stopPropagation?.();
    event.preventDefault?.();
    openUrl();
  });

  const footer = useMemo(() => {
    const contextLabel = label.trim() || "link";
    const linkInfo: PaneFooterSegment[] = url && sourceLabel
      ? [{
        id: "external-link",
        onPress: openUrl,
        parts: [
          { text: contextLabel === "link" ? "source" : contextLabel, tone: "label" as const },
          { text: sourceLabel, tone: "value" as const },
        ],
      }]
      : [];

    return {
      info: [...info, ...linkInfo],
      hints: [
        ...hints,
        ...(url && showHint ? [{ id: "open", key: "o", label: "pen", onPress: openUrl }] : []),
      ],
    };
  }, [hints, info, label, openUrl, showHint, sourceLabel, url]);

  usePaneFooter(registrationId, () => footer, [footer]);

  return openUrl;
}
