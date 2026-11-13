import { marketplaceLayoutIdFromSearch } from "../../layout-marketplace/api";
import { paneShareIdFromSearch } from "../../shares/location";
import type { DesktopDeepLinkBridge } from "../../types/desktop-deeplink";
import { functionEntryFromSearch, researchEntryFromSearch } from "./research-entry";

/**
 * A hand-off parameter is consumed once. Leaving it in the address would open
 * a second copy of the shared pane on every reload, and the link would
 * outlive the share it points at.
 */
function consumeHandoffParams(search: string, keys: string[]): void {
  const history = window.history;
  if (typeof history?.replaceState !== "function") return;
  const params = new URLSearchParams(search);
  if (!keys.some((key) => params.has(key))) return;
  for (const key of keys) params.delete(key);
  const query = params.toString();
  const url = `${window.location.pathname || "/"}${query ? `?${query}` : ""}${window.location.hash ?? ""}`;
  history.replaceState(history.state, "", url);
}

/** How this page was opened: "navigate", "reload" or "back_forward". */
function pageNavigationType(): string | undefined {
  try {
    const [entry] = globalThis.performance?.getEntriesByType?.("navigation") ?? [];
    return (entry as PerformanceNavigationTiming | undefined)?.type;
  } catch {
    // Intentional ignore: without the timing API the page counts as opened from its address.
    return undefined;
  }
}

export function createBrowserDeepLinkBridge(navigationType: () => string | undefined = pageNavigationType): DesktopDeepLinkBridge {
  // Restoring a saved pane can update the address before App subscribes.
  // Keep the incoming link intact until it has been delivered once.
  const initialSearch = window.location.search;
  // A reload, or a return through history, brings back the saved workspace the
  // address was written from. Its tab asks for nothing: the pane keeps the tab
  // it saved, and one only Pro opens stays behind a free one (pane-choices.ts).
  const restoring = (() => {
    const type = navigationType();
    return type === "reload" || type === "back_forward";
  })();
  return {
    subscribe(listener) {
      let initial = true;
      const emit = () => {
        const first = initial;
        const search = first ? initialSearch : window.location.search;
        initial = false;
        const layoutId = marketplaceLayoutIdFromSearch(search);
        if (layoutId) {
          consumeHandoffParams(search, ["layout"]);
          listener({ url: `gloomberb://layout/${layoutId}` });
          return;
        }
        const shareId = paneShareIdFromSearch(search);
        if (shareId) {
          consumeHandoffParams(search, ["share"]);
          listener({ url: `gloomberb://share/${shareId}` });
          return;
        }
        const fn = functionEntryFromSearch(search);
        if (fn) {
          // The pane stays in the saved workspace; a reload must not open a second one.
          consumeHandoffParams(search, ["fn", "arg"]);
          listener({ url: `gloomberb://fn/${fn.code}${fn.arg ? `?arg=${encodeURIComponent(fn.arg)}` : ""}` });
          return;
        }
        const entry = researchEntryFromSearch(search);
        if (!entry) return;
        const symbolUrl = `gloomberb://ticker/${encodeURIComponent(entry.symbol)}`;
        listener({ url: restoring && first ? symbolUrl : `${symbolUrl}?tab=${entry.tab}` });
      };
      emit();
      window.addEventListener("popstate", emit);
      return () => window.removeEventListener("popstate", emit);
    },
  };
}
