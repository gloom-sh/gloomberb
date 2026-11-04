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

export function createBrowserDeepLinkBridge(): DesktopDeepLinkBridge {
  // Restoring a saved pane can update the address before App subscribes.
  // Keep the incoming link intact until it has been delivered once.
  const initialSearch = window.location.search;
  return {
    subscribe(listener) {
      let initial = true;
      const emit = () => {
        const search = initial ? initialSearch : window.location.search;
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
        if (entry) listener({ url: `gloomberb://ticker/${encodeURIComponent(entry.symbol)}?tab=${entry.tab}` });
      };
      emit();
      window.addEventListener("popstate", emit);
      return () => window.removeEventListener("popstate", emit);
    },
  };
}
